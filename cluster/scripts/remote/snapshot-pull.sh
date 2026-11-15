#!/usr/bin/env bash
# Remote half of scripts/snapshot-state.sh. Streamed to the cluster host with
#   ssh HOST env VAR=... bash -s < scripts/remote/snapshot-pull.sh | tar xf - -C .snapshot
# Stops the cluster (so the state cannot move under the copy), then writes to stdout a tar of every node's
# consensus state: the *.json files under node<N>/contract_fs/seed/state. The signing keys are one level up
# (contract_fs/seed/bridge-keys.json) and are never read here. Messages go to stderr; stdout is the tar and nothing else.
# The cluster is left stopped: the deploy that follows starts it.
#
# Env: CLUSTER, NODES (n; empty = however many node<N> directories the volume holds), VOL_ROOT, DOCKER, STOP_WAIT_S
set -euo pipefail

say() { printf '%s\n' "$*" >&2 || true; }
fail() {
  say "ERROR: $*"
  exit 1
}

main() {
  trap '' HUP PIPE
  CLUSTER="${CLUSTER:?CLUSTER is required}"
  NODES="${NODES:-}"
  VOL_ROOT="${VOL_ROOT:-/var/lib/docker/volumes}"
  DOCKER="${DOCKER:-docker}"
  STOP_WAIT_S="${STOP_WAIT_S:-40}"
  local name_re='^[A-Za-z0-9][A-Za-z0-9_-]*$' int_re='^[1-9][0-9]*$'
  [[ "$CLUSTER" =~ $name_re ]] || fail "bad CLUSTER '$CLUSTER'"
  if [ -n "$NODES" ] && ! [[ "$NODES" =~ $int_re ]]; then fail "NODES must be a positive integer, got '$NODES'"; fi

  local vol="$VOL_ROOT/hpdevkit_${CLUSTER}_vol/_data" mgr="hpdevkit_${CLUSTER}_deploymgr"
  [ -d "$vol" ] || fail "no volume at $vol: is the cluster '$CLUSTER' created on this host?"

  local d found=0
  for d in "$vol"/node*; do
    [ -d "$d" ] || continue
    case "${d##*/}" in node*[!0-9]* | node) ;; *) found=$((found + 1)) ;; esac
  done
  [ -n "$NODES" ] || NODES="$found"
  [ "$found" = "$NODES" ] || fail "the volume holds $found node directories but the snapshot is for $NODES. Nothing was stopped."
  [ "$NODES" -ge 1 ] || fail "the volume holds no node directories. Nothing was stopped."

  # Check every node has state before the cluster is stopped: a snapshot of three out of five is not a snapshot.
  local n f paths=()
  for n in $(seq 1 "$NODES"); do
    local count=0
    for f in "$vol/node$n/contract_fs/seed/state/"*.json; do
      [ -f "$f" ] || continue
      paths+=("node$n/contract_fs/seed/state/${f##*/}")
      count=$((count + 1))
    done
    [ "$count" -gt 0 ] || fail "node $n has no state files under $vol/node$n/contract_fs/seed/state (has the cluster run this bundle?). Nothing was stopped."
  done

  say "==> stop the cluster"
  "$DOCKER" exec "$mgr" cluster stop >/dev/null 2>&1 || true
  local i=0
  while [ "$("$DOCKER" ps --filter "name=hpdevkit_${CLUSTER}_node_" --filter status=running -q | wc -l | tr -d ' ')" != 0 ]; do
    i=$((i + 1))
    [ "$i" -le "$STOP_WAIT_S" ] || fail "nodes are still running ${STOP_WAIT_S}s after the stop; not copying state that may still move."
    sleep 1
  done
  say "    stopped; copying the state of $NODES node(s). The cluster stays stopped until the next deploy starts it."
  tar cf - -C "$vol" "${paths[@]}"
}

main "$@"
