#!/usr/bin/env bash
# Remote half of scripts/deploy-dev.sh. It is streamed to the cluster host with
#   ssh HOST env VAR=... bash -s < scripts/remote/redeploy.sh
# and is not meant to be run by hand, except for the RESTORE-KEYS.sh it leaves behind when something goes wrong.
#
# Stops the cluster, keeps every node's signing key across `cluster sync` (which wipes the node directories),
# starts it again. The keys are staged in memory (tmpfs) for the seconds between the wipe and the restore, and the
# staged copies are shredded only after every key is back on its node and checked. If anything fails after the
# wipe they stay where they are, and the message says where and how to put them back.
#
# Env (all plain strings; deploy-dev.sh checks them before sending):
#   CLUSTER          hpdevkit cluster name ('default', 'main', ...)
#   REMOTE_DIR       where the bundle was rsynced to (/root/bridge-cluster[-NAME])
#   NODES            n, the number of nodes in the cluster
#   MAINNET          1 when the genesis being deployed is mainnet (default 0)
#   ACCEPT_NEW_KEYS  '' | all | 4,5: nodes that may start without a key file (they will make new keys)
#   STAGE_ROOT       where staged keys live (default /dev/shm: memory only)
#   VOL_ROOT, DOCKER, STOP_WAIT_S, START_WAIT_S   test hooks
set -euo pipefail

# Everything is a function and main runs on the last line, so bash has read the whole script before it does
# anything: a dropped ssh connection cannot cut the script off between the wipe and the restore.

say() { printf '%s\n' "$*" || true; }
warn() { printf '%s\n' "$*" >&2 || true; }
fail() {
  warn "ERROR: $*"
  exit 1
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Shred where shred exists (the servers), plain removal elsewhere. Missing files are fine.
wipe() {
  local f
  for f in "$@"; do
    [ -f "$f" ] || continue
    if command -v shred >/dev/null 2>&1; then shred -u "$f" 2>/dev/null || rm -f "$f"; else rm -f "$f"; fi
  done
}

seed_dir() { printf '%s/node%s/contract_fs/seed' "$VOL" "$1"; }

# restore_keys STAGE: copies every staged file back to its node, mode 600, and checks each copy byte for byte.
# Files are node<N>.json (bridge-keys.json) and node<N>.payout.json (bridge-payout.json). Also embedded in the
# RESTORE-KEYS.sh that is left next to the staged files.
restore_keys() {
  local stage="$1" f base n dest dir bad=0
  for f in "$stage"/node*.json; do
    [ -f "$f" ] || continue
    base="${f##*/}"
    case "$base" in
      node[0-9]*.payout.json)
        n="${base#node}"
        n="${n%.payout.json}"
        dest=bridge-payout.json
        ;;
      node[0-9]*.json)
        n="${base#node}"
        n="${n%.json}"
        dest=bridge-keys.json
        ;;
      *) continue ;;
    esac
    dir="$(seed_dir "$n")"
    if mkdir -p "$dir" && cp "$f" "$dir/$dest" && chmod 600 "$dir/$dest" && [ -s "$dir/$dest" ] && [ "$(sha256_of "$dir/$dest")" = "$(sha256_of "$f")" ]; then
      say "  node $n: $dest restored"
    else
      warn "  node $n: could not put $dest back into $dir"
      bad=1
    fi
  done
  [ "$bad" = 0 ]
}

# After the restore, looked at again from the nodes' side: every node that had a key has one, non-empty, and every
# payout file that was staged is back too. restore_keys checks what it copied; this checks that nothing was missed.
verify_on_nodes() {
  local n bad=0
  for n in $HAVE; do
    if [ ! -s "$(seed_dir "$n")/bridge-keys.json" ]; then
      warn "  node $n: bridge-keys.json is missing or empty after the restore"
      bad=1
    fi
    if [ -f "$STAGE/node$n.payout.json" ] && [ ! -s "$(seed_dir "$n")/bridge-payout.json" ]; then
      warn "  node $n: bridge-payout.json is missing or empty after the restore"
      bad=1
    fi
  done
  [ "$bad" = 0 ]
}

VOL=""
STAGE=""
KEYS_AT_RISK=0 # 1 while the staged copies may be the only ones
VOLUME_TOUCHED=0 # 1 once `cluster sync` may have wiped the node directories
HAVE=""
MISSING=""

on_exit() {
  local rc=$?
  if [ "$KEYS_AT_RISK" = 1 ] && [ -n "$STAGE" ] && [ -d "$STAGE" ]; then
    if [ "$VOLUME_TOUCHED" = 0 ]; then
      # Nothing has been wiped yet: the originals are still where the nodes read them, so the staged copies are only copies.
      wipe "$STAGE"/node*.json "$STAGE/RESTORE-KEYS.sh"
      rm -rf "$STAGE"
    else
      warn ""
      warn "!! The signing keys are NOT confirmed back on the nodes. The staged copies are untouched, in memory, at:"
      warn "!!     $STAGE   (mode 0700, tmpfs: gone at a reboot, so do not reboot this host)"
      warn "!! Put them back, check them and shred the copies with:"
      warn "!!     bash $STAGE/RESTORE-KEYS.sh"
      warn "!! Then rerun the deploy. Do not delete that directory by hand."
    fi
  fi
  exit "$rc"
}

nodes_running() { "$DOCKER" ps --filter "name=hpdevkit_${CLUSTER}_node_" --filter status=running -q | wc -l | tr -d ' '; }

# Node directories in the volume: node1, node2, ... and nothing else that merely starts with 'node'.
count_node_dirs() {
  local d count=0
  for d in "$VOL"/node*; do
    [ -d "$d" ] || continue
    case "${d##*/}" in node*[!0-9]* | node) ;; *) count=$((count + 1)) ;; esac
  done
  echo "$count"
}

# Which nodes have a key file, and which do not. A file that exists and is empty is a stop, not a "missing".
classify_keys() {
  local n f
  HAVE=""
  MISSING=""
  for n in $(seq 1 "$NODES"); do
    f="$(seed_dir "$n")/bridge-keys.json"
    if [ -e "$f" ] && [ ! -s "$f" ]; then fail "node $n: $f exists but is empty. Nothing was touched; find out why before anything is redeployed."; fi
    if [ -s "$f" ]; then HAVE="$HAVE $n"; else MISSING="$MISSING $n"; fi
  done
}

accepted() {
  [ "$ACCEPT_NEW_KEYS" = all ] && return 0
  case ",$ACCEPT_NEW_KEYS," in *",$1,"*) return 0 ;; esac
  return 1
}

# Nothing is stopped or wiped before this passes.
check_key_policy() {
  local n
  [ -n "$MISSING" ] || return 0
  if [ -z "$HAVE" ]; then
    if [ "$MAINNET" = 1 ] && [ "$ACCEPT_NEW_KEYS" != all ]; then
      fail "no node has a key file and this is a mainnet cluster. If this is the very first boot, rerun with ACCEPT_NEW_KEYS=all. If the cluster ran before, STOP: its keys are gone or this is the wrong cluster ($VOL). Nothing was touched."
    fi
    say "  no node has a key file yet: a fresh cluster, the nodes will make their own"
    return 0
  fi
  for n in $MISSING; do
    accepted "$n" || fail "node $n has no key file, but node(s)$HAVE do. A redeploy would give node $n a new random signing key and the SignerList would stop matching. Find that key (scripts/keys-restore.sh) or, if the node is really being replaced, rerun with ACCEPT_NEW_KEYS=$n. Nothing was touched."
  done
  say "  WARNING: node(s)$MISSING will make new signing keys (ACCEPT_NEW_KEYS=$ACCEPT_NEW_KEYS): the SignerList and the minter need a rotation afterwards"
}

# Node-local files: the fake feed, the test-hook delay, the node id and last round, the contract log, and the
# validated-ledger, account_tx, EVM head and EVM log caches. Every one of them is /tmp/bridge-* (src/contract.ts,
# src/log.ts, src/feed/*.ts); left in place across a network switch the caches answer with the old ledger's numbers.
# Cleared only after the stop: doing it before gave a node still closing ledgers the chance to write them straight
# back. `cluster stop` exits the node containers, so their /tmp is reached through the stopped container's writable
# layer rather than `docker exec`, which needs a running container.
clear_node_caches() {
  local n upper
  for n in $(seq 1 "$NODES"); do
    upper="$("$DOCKER" inspect "hpdevkit_${CLUSTER}_node_$n" --format '{{.GraphDriver.Data.UpperDir}}' 2>/dev/null || true)"
    if [ -n "$upper" ] && [ -d "$upper/tmp" ]; then rm -f "$upper"/tmp/bridge-*; else warn "  WARNING node_$n: /tmp not reachable from the host, node-local caches left in place"; fi
  done
}

write_restore_script() {
  {
    echo '#!/usr/bin/env bash'
    echo '# Puts the staged node keys back where the nodes read them, checks every copy, then shreds the staged files.'
    echo 'set -euo pipefail'
    declare -f say warn fail sha256_of wipe seed_dir restore_keys
    printf 'VOL=%q\n' "$VOL"
    # shellcheck disable=SC2016 # the generated script expands these, not this one
    echo 'HERE="$(cd "$(dirname "$0")" && pwd)"'
    # shellcheck disable=SC2016
    echo 'if restore_keys "$HERE"; then wipe "$HERE"/node*.json "$HERE/RESTORE-KEYS.sh"; rmdir "$HERE" 2>/dev/null || true; say "keys restored and checked; the staged copies are shredded"; else fail "some keys were not restored; the staged copies are untouched in $HERE"; fi'
  } >"$STAGE/RESTORE-KEYS.sh"
  chmod 700 "$STAGE/RESTORE-KEYS.sh"
}

stage_keys() {
  local n src
  [ -n "$HAVE" ] || return 0
  STAGE="$(mktemp -d "$STAGE_ROOT/bridge-keys.XXXXXX")"
  chmod 700 "$STAGE"
  KEYS_AT_RISK=1
  for n in $HAVE; do
    src="$(seed_dir "$n")"
    cp "$src/bridge-keys.json" "$STAGE/node$n.json"
    chmod 600 "$STAGE/node$n.json"
    cmp -s "$src/bridge-keys.json" "$STAGE/node$n.json" || fail "the staged copy of node $n's key differs from the original. Nothing was wiped."
    if [ -s "$src/bridge-payout.json" ]; then
      cp "$src/bridge-payout.json" "$STAGE/node$n.payout.json"
      chmod 600 "$STAGE/node$n.payout.json"
      cmp -s "$src/bridge-payout.json" "$STAGE/node$n.payout.json" || fail "the staged copy of node $n's payout file differs from the original. Nothing was wiped."
    fi
  done
  write_restore_script
  say "  staged the keys of node(s)$HAVE in $STAGE (memory only)"
}

main() {
  trap '' HUP PIPE
  CLUSTER="${CLUSTER:?CLUSTER is required}"
  REMOTE_DIR="${REMOTE_DIR:?REMOTE_DIR is required}"
  NODES="${NODES:?NODES is required}"
  MAINNET="${MAINNET:-0}"
  ACCEPT_NEW_KEYS="${ACCEPT_NEW_KEYS:-}"
  STAGE_ROOT="${STAGE_ROOT:-/dev/shm}"
  VOL_ROOT="${VOL_ROOT:-/var/lib/docker/volumes}"
  DOCKER="${DOCKER:-docker}"
  STOP_WAIT_S="${STOP_WAIT_S:-40}"
  START_WAIT_S="${START_WAIT_S:-12}"

  local name_re='^[A-Za-z0-9][A-Za-z0-9_-]*$' int_re='^[1-9][0-9]*$' list_re='^[1-9][0-9]*(,[1-9][0-9]*)*$'
  [[ "$CLUSTER" =~ $name_re ]] || fail "bad CLUSTER '$CLUSTER'"
  [[ "$NODES" =~ $int_re ]] || fail "NODES must be a positive integer, got '$NODES'"
  case "$MAINNET" in 0 | 1) ;; *) fail "MAINNET must be 0 or 1" ;; esac
  if [ -n "$ACCEPT_NEW_KEYS" ] && [ "$ACCEPT_NEW_KEYS" != all ] && ! [[ "$ACCEPT_NEW_KEYS" =~ $list_re ]]; then
    fail "ACCEPT_NEW_KEYS must be empty, 'all' or a list of node numbers like 4,5"
  fi

  VOL="$VOL_ROOT/hpdevkit_${CLUSTER}_vol/_data"
  MGR="hpdevkit_${CLUSTER}_deploymgr"
  LOG="$REMOTE_DIR/redeploy.log"
  [ -d "$VOL" ] || fail "no volume at $VOL: is the cluster '$CLUSTER' created on this host?"
  [ -f "$REMOTE_DIR/dist/index.js" ] || fail "$REMOTE_DIR/dist/index.js is missing: the rsync did not land"
  : >"$LOG"

  local found
  found="$(count_node_dirs)"
  [ "$found" = "$NODES" ] || fail "the volume holds $found node directories but this deploy is for $NODES. Fix CLUSTER_SIZE or the genesis; nothing was touched."

  # An earlier run that died after the wipe leaves its keys staged. They may be the only copies.
  local d leftover=""
  for d in "$STAGE_ROOT"/bridge-keys.*; do
    [ -d "$d" ] || continue
    if ls "$d"/node*.json >/dev/null 2>&1; then leftover="$leftover $d"; fi
  done
  [ -z "$leftover" ] || fail "an earlier deploy left signing keys staged in:$leftover. They may be the only copies. Put them back with 'bash <dir>/RESTORE-KEYS.sh' (it checks them and shreds the staged files), then rerun."
  if ls "$REMOTE_DIR"/node-keys/*.json >/dev/null 2>&1; then
    fail "$REMOTE_DIR/node-keys holds key files from an older version of this script. Compare them with the nodes' own (node<N>/contract_fs/seed/bridge-keys.json) and remove them yourself once you know they are copies."
  fi

  classify_keys
  check_key_policy

  trap on_exit EXIT
  say "==> stop the cluster"
  "$DOCKER" exec "$MGR" cluster stop >>"$LOG" 2>&1 || true
  local i=0
  while [ "$(nodes_running)" != 0 ]; do
    i=$((i + 1))
    [ "$i" -le "$STOP_WAIT_S" ] || fail "nodes are still running ${STOP_WAIT_S}s after the stop. Nothing was wiped."
    sleep 1
  done
  clear_node_caches
  # A signing key exists in exactly one place (KEYS.md): the staged copies live in memory only, for the seconds between
  # the wipe and the restore, and this host is shared with other tenants.
  stage_keys

  rm -rf "$VOL/contract_bundle"
  mkdir -p "$VOL/contract_bundle"
  cp -r "$REMOTE_DIR/dist/." "$VOL/contract_bundle/"

  say "==> sync (wipes the node directories)"
  VOLUME_TOUCHED=1
  local sync_ok=1
  "$DOCKER" exec "$MGR" cluster sync >>"$LOG" 2>&1 || sync_ok=0

  if [ -n "$HAVE" ]; then
    say "==> put the keys back"
    restore_keys "$STAGE" || fail "not every key is back on its node. The staged copies are untouched; see the message below."
    verify_on_nodes || fail "the restore finished but a key file is not on its node. The staged copies are untouched; see the message below."
    # Verified: every node that had a key has it again, non-empty and byte-identical to the staged copy. Only now do the copies go.
    wipe "$STAGE"/node*.json "$STAGE/RESTORE-KEYS.sh"
    rm -rf "$STAGE"
    KEYS_AT_RISK=0
  fi
  if [ "$sync_ok" = 0 ]; then
    warn "--- last lines of $LOG"
    tail -n 15 "$LOG" >&2 || true
    fail "cluster sync failed. The cluster is stopped and the keys are back on the nodes (checked). Fix the cause and rerun the deploy."
  fi

  say "==> start"
  "$DOCKER" exec "$MGR" cluster start >>"$LOG" 2>&1
  sleep "$START_WAIT_S"
  local n
  for n in $(seq 1 "$NODES"); do
    printf 'node_%s ' "$n" || true
    { "$DOCKER" logs "hpdevkit_${CLUSTER}_node_$n" --tail 50 2>&1 | grep "Ledger created" | tail -1 | sed "s/.*(lcl/(lcl/"; } || true
  done
  say "contract log (node 1):"
  "$DOCKER" exec "hpdevkit_${CLUSTER}_node_1" sh -c "tail -3 /tmp/bridge-cluster.log 2>/dev/null || echo \"  (none yet)\"" || true
}

main "$@"
