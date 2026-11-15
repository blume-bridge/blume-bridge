#!/usr/bin/env bash
# Remote half of scripts/hpdevkit-cluster.sh. Streamed to the cluster host with
#   ssh HOST env VAR=... bash -s < scripts/remote/cluster-manage.sh
#
# CMD=create    a second (third, ...) hpdevkit cluster beside the default one: its own deploy manager, volume, network,
#               container prefix and ports, with NODES nodes. hpdevkit's manager is a bash script driven by environment
#               variables (CLUSTER, CLUSTER_SIZE, HP_USER_PORT_BEGIN, ...), so a second manager with the names swapped is a
#               second cluster; the variables are copied from the default cluster's manager.
# CMD=inspect   print what `destroy` would lose, change nothing.
# CMD=destroy   stop and remove the nodes, the manager, the volume (signing keys and consensus state included) and the
#               network. Refused, with exit status 3, for a cluster named 'main' or one that reads as mainnet, unless
#               CONFIRM_DESTROY is set to the cluster's name. Always prints what is about to be lost first.
#
# Env: CMD, CLUSTER, NODES (create), USER_PORT, PEER_PORT (create), REMOTE_DIR, MAINNET (1 = the caller knows it is
#      mainnet), CONFIRM_DESTROY, VOL_ROOT, DOCKER (test hooks)
set -euo pipefail

say() { printf '%s\n' "$*" || true; }
warn() { printf '%s\n' "$*" >&2 || true; }
fail() {
  warn "ERROR: $*"
  exit 1
}

# True when a config.json (a node's state) or a genesis.json (a bundle) points at mainnet: the XRPL EVM mainnet chain id,
# or a public mainnet XRPL endpoint. Same test as scripts/genesis-info.ts; plain `contains` so it needs no regex support in jq.
reads_as_mainnet() {
  jq -e '(.config // .) as $c | (($c.evm.chainId // 0) == 1440000) or (($c.xrpl.rpc // []) | any(contains("xrplcluster.com") or contains("s1.ripple.com") or contains("s2.ripple.com")))' "$1" >/dev/null 2>&1
}

main() {
  trap '' HUP PIPE
  CMD="${CMD:-create}"
  CLUSTER="${CLUSTER:?CLUSTER is required}"
  VOL_ROOT="${VOL_ROOT:-/var/lib/docker/volumes}"
  DOCKER="${DOCKER:-docker}"
  REMOTE_DIR="${REMOTE_DIR:-/root/bridge-cluster-$CLUSTER}"
  MAINNET="${MAINNET:-0}"
  local name_re='^[A-Za-z0-9][A-Za-z0-9_-]*$' int_re='^[1-9][0-9]*$'
  [[ "$CLUSTER" =~ $name_re ]] || fail "bad CLUSTER '$CLUSTER'"
  [ "$CLUSTER" != default ] || fail "the default cluster is hpdevkit's own; pick another name"
  local vol="$VOL_ROOT/hpdevkit_${CLUSTER}_vol/_data" mgr="hpdevkit_${CLUSTER}_deploymgr"

  case "$CMD" in
    create)
      NODES="${NODES:?NODES is required for create}"
      USER_PORT="${USER_PORT:-8091}"
      PEER_PORT="${PEER_PORT:-22871}"
      [[ "$NODES" =~ $int_re ]] || fail "NODES must be a positive integer, got '$NODES'"
      [[ "$USER_PORT" =~ $int_re && "$PEER_PORT" =~ $int_re ]] || fail "USER_PORT and PEER_PORT must be port numbers"
      create_cluster "$mgr" "$vol"
      ;;
    inspect) describe_loss "$vol" ;;
    destroy) destroy_cluster "$mgr" "$vol" ;;
    *) fail "CMD must be create, inspect or destroy, got '$CMD'" ;;
  esac
}

create_cluster() {
  local mgr="$1" vol="$2" env_lines line n
  if "$DOCKER" ps -a --format '{{.Names}}' | grep -q "^${mgr}$"; then
    say "cluster $CLUSTER already exists"
    "$DOCKER" exec "$mgr" cluster status
    return 0
  fi
  env_lines="$("$DOCKER" inspect hpdevkit_default_deploymgr --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -v '^PATH=' | grep -v '^$' |
    sed -e "s/hpdevkit_default_/hpdevkit_${CLUSTER}_/g" -e "s/^CLUSTER=default$/CLUSTER=${CLUSTER}/" -e "s/^CLUSTER_SIZE=.*/CLUSTER_SIZE=${NODES}/" -e "s/^HP_USER_PORT_BEGIN=.*/HP_USER_PORT_BEGIN=${USER_PORT}/" -e "s/^HP_PEER_PORT_BEGIN=.*/HP_PEER_PORT_BEGIN=${PEER_PORT}/")"
  # The default manager is expected to carry CLUSTER_SIZE (hpdevkit passes it); if it does not, say it anyway.
  printf '%s\n' "$env_lines" | grep -q '^CLUSTER_SIZE=' || env_lines="$env_lines
CLUSTER_SIZE=${NODES}"
  local args=()
  while IFS= read -r line; do
    [ -n "$line" ] && args+=(-e "$line")
  done <<EOF
$env_lines
EOF
  say "creating cluster $CLUSTER: $NODES node(s), user ports $USER_PORT-$((USER_PORT + NODES - 1)), peer ports $PEER_PORT-$((PEER_PORT + NODES - 1))"
  # A throwaway manager without the volume mount (the manager takes an existing volume for an existing cluster); it
  # creates the volume, the network and the node containers.
  "$DOCKER" run --rm --entrypoint cluster --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock "${args[@]}" evernode/hpdevkit:0.6.5-beta create
  # The persistent manager, with the volume mounted, for bindmesh / sync / start / stop.
  "$DOCKER" run -dit --name "$mgr" --restart unless-stopped \
    --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
    --mount "type=volume,src=hpdevkit_${CLUSTER}_vol,dst=/hpdevkit_vol" \
    "${args[@]}" evernode/hpdevkit:0.6.5-beta >/dev/null
  "$DOCKER" exec "$mgr" cluster bindmesh
  "$DOCKER" exec "$mgr" cluster status
  for n in $(seq 1 "$NODES"); do
    jq -c '{id:.contract.id, unl:(.contract.unl|length), peers:.mesh.known_peers, user:.user.port, mesh:.mesh.port}' "$vol/node$n/cfg/hp.cfg"
  done
}

# What destroying this cluster loses. Addresses only: the key files are read through a jq filter that names the two
# address fields, so no seed or private key can reach the output.
describe_loss() {
  local vol="$1" d n nodes=0 f addrs payout states cursor
  if [ ! -d "$vol" ]; then
    say "no volume at $vol: there is nothing of cluster $CLUSTER on this host to lose"
    return 0
  fi
  say "cluster $CLUSTER, volume $vol"
  say "destroying it deletes, with no way back:"
  for d in "$vol"/node*; do
    [ -d "$d" ] || continue
    case "${d##*/}" in node*[!0-9]* | node) continue ;; esac
    n="${d##*/node}"
    nodes=$((nodes + 1))
    f="$d/contract_fs/seed/bridge-keys.json"
    if [ -s "$f" ]; then
      addrs="$(jq -r '"XRPL \(.xrpl.address // "?")  EVM \(.evm.address // "?")"' "$f" 2>/dev/null || echo "XRPL ?  EVM ? (unreadable)")"
    else
      addrs="no signing key file"
    fi
    if [ -s "$d/contract_fs/seed/bridge-payout.json" ]; then payout="payout file yes"; else payout="payout file no"; fi
    states=0
    for f in "$d"/contract_fs/seed/state/*.json; do
      if [ -f "$f" ]; then states=$((states + 1)); fi
    done
    cursor="$(jq -r '.xrpl.ledger // "?"' "$d/contract_fs/seed/state/cursor.json" 2>/dev/null || echo "?")"
    say "  node $n: $addrs; $payout; $states state files, XRPL cursor $cursor"
  done
  say "  = $nodes node(s): their signing keys, the consensus state (which burns have been paid), the HotPocket identities and the node logs"
  say "  + the deploy manager container, the volume and the network"
  say "  Signing keys are not recoverable from anywhere else unless scripts/keys-backup.sh was run and its output kept."
}

# Why this cluster must not be destroyed by accident, or nothing when it may.
protected_because() {
  local vol="$1" f why=""
  [ "$CLUSTER" = main ] && why="it is named 'main', the sole-operator mainnet cluster"
  [ "$MAINNET" = 1 ] && why="${why:+$why; }the deploy was told it is mainnet (MAINNET=1)"
  for f in "$vol"/node*/contract_fs/seed/state/config.json "$vol/contract_bundle/genesis.json" "$REMOTE_DIR/dist/genesis.json"; do
    [ -f "$f" ] || continue
    if reads_as_mainnet "$f"; then
      why="${why:+$why; }${f##*/} points at mainnet (${f#"$vol"/})"
      break
    fi
  done
  printf '%s' "$why"
}

destroy_cluster() {
  local mgr="$1" vol="$2" why
  if [ ! -d "$vol" ] && ! "$DOCKER" ps -a --format '{{.Names}}' | grep -q "^${mgr}$"; then
    say "cluster $CLUSTER does not exist on this host"
    return 0
  fi
  describe_loss "$vol"
  why="$(protected_because "$vol")"
  if [ -n "$why" ] && [ "${CONFIRM_DESTROY:-}" != "$CLUSTER" ]; then
    warn ""
    warn "REFUSED: $why."
    warn "This cluster holds real signing keys. If you are sure, run keys-backup.sh first, then repeat with CONFIRM_DESTROY=$CLUSTER."
    exit 3
  fi
  [ -z "$why" ] || say "CONFIRM_DESTROY=$CLUSTER given ($why): going ahead."
  "$DOCKER" exec "$mgr" cluster stop >/dev/null 2>&1 || true
  "$DOCKER" exec "$mgr" cluster destroy || true
  "$DOCKER" rm -f "$mgr" >/dev/null 2>&1 || true
  "$DOCKER" volume rm "hpdevkit_${CLUSTER}_vol" >/dev/null 2>&1 || true
  "$DOCKER" network rm "hpdevkit_${CLUSTER}_net" >/dev/null 2>&1 || true
  say "cluster $CLUSTER destroyed"
}

main "$@"
