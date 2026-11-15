#!/usr/bin/env bash
# Stop the cluster and turn its consensus state into genesis/snapshot.json, so a redeploy
# (GENESIS=snapshot bash scripts/deploy-dev.sh) resumes from exactly where the cluster stopped:
# queued releases, applied burns, the operator set and the cursors all survive, nothing is replayed
# and nothing is paid twice. The cluster is stopped first so the state cannot move under the copy,
# and it stays stopped: the deploy that follows starts it.
#
#   bash scripts/snapshot-state.sh                       # state and config as the nodes hold them
#   CONFIG_FROM=genesis/testnet.json bash scripts/snapshot-state.sh   # same state, config (RPCs, params, minter) from that file
#   CLUSTER_SIZE=5 SNAPSHOT_MIN_AGREE=4 bash scripts/snapshot-state.sh  # one node is lost: take the state four of five agree on
#
# STATE_FROM=<dir> builds the snapshot from an off-box copy instead (a generation scripts/state-backup.sh wrote): no
# host is touched and no cluster is stopped. It is the way back from a lost box, and CLEAR_OPERATORS=1 empties the
# operator set so the new cluster's nodes vote their keys again. Then run scripts/reconcile-snapshot.ts on the result.
#
# Every node's state is pulled (CLUSTER_SIZE of them; default: every node<N> directory the volume holds) and
# compared file by file: they must all agree, or at least SNAPSHOT_MIN_AGREE of them must, and the dissenters
# are named. The signing keys are not part of the state and are never read here.
#
# Env: CLUSTER (default 'default'), CLUSTER_SIZE, SNAPSHOT_MIN_AGREE, CONFIG_FROM, STATE_FROM, CLEAR_OPERATORS,
# DEPLOY_HOST (default bridge-host), DRY_RUN=1 (print every command, run nothing).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=lib/ops.sh
. scripts/lib/ops.sh

export CLUSTER="${CLUSTER:-default}"
HOST="${DEPLOY_HOST:-bridge-host}"
check_name CLUSTER "$CLUSTER"
check_name DEPLOY_HOST "$HOST"
if [ -n "${CLUSTER_SIZE:-}" ] && ! [[ "$CLUSTER_SIZE" =~ ^[1-9][0-9]*$ ]]; then die "CLUSTER_SIZE must be a positive integer, got '$CLUSTER_SIZE'"; fi
STAGE=.snapshot
is_dry && note "DRY_RUN=1: nothing below is run; every command is printed"

if [ -n "${STATE_FROM:-}" ]; then
  note "assemble genesis/snapshot.json from the backup copy $STATE_FROM (no host is touched, no cluster is stopped)"
  if is_dry; then echo "+ STATE_FROM=$STATE_FROM CONFIG_FROM=${CONFIG_FROM:-} CLEAR_OPERATORS=${CLEAR_OPERATORS:-} npx tsx scripts/snapshot-state.ts"; else STATE_FROM="$STATE_FROM" CONFIG_FROM="${CONFIG_FROM:-}" npx tsx scripts/snapshot-state.ts; fi
  exit 0
fi

note "stop the cluster and pull the state of every node"
if is_dry; then
  echo "+ rm -rf $STAGE && mkdir -p $STAGE"
  remote_run "$HOST" scripts/remote/snapshot-pull.sh "CLUSTER=$CLUSTER" "NODES=${CLUSTER_SIZE:-}"
  echo "  (the output of the script above is a tar, unpacked into $STAGE)"
else
  rm -rf "$STAGE" && mkdir -p "$STAGE"
  remote_run "$HOST" scripts/remote/snapshot-pull.sh "CLUSTER=$CLUSTER" "NODES=${CLUSTER_SIZE:-}" | tar xf - -C "$STAGE"
fi
note "assemble genesis/snapshot.json"
if is_dry; then
  echo "+ CONFIG_FROM=${CONFIG_FROM:-} CLUSTER_SIZE=${CLUSTER_SIZE:-} SNAPSHOT_MIN_AGREE=${SNAPSHOT_MIN_AGREE:-} npx tsx scripts/snapshot-state.ts $STAGE"
else
  CONFIG_FROM="${CONFIG_FROM:-}" npx tsx scripts/snapshot-state.ts "$STAGE"
  rm -rf "$STAGE"
fi
