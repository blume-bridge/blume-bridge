#!/usr/bin/env bash
# Build on the Mac, ship to the cluster host (ssh alias bridge-host: the cluster host), redeploy onto the running hpdevkit cluster.
#   GENESIS=dev|devnet|testnet|mainnet|snapshot bash scripts/deploy-dev.sh
#
# Any GENESIS other than dev, mainnet and snapshot names an XRPL network (GENESIS=devnet, where Batch is live;
# GENESIS=testnet): its genesis is refreshed first and the cluster boots from it. scripts/testnet-setup.ts
# is the validator — it rejects a name that is not in its network table and refuses a network with no
# faucet — and BRIDGE_MINTER must name that cluster's own ThresholdMinter. GENESIS=snapshot stops the
# cluster, copies its consensus state into genesis/snapshot.json and boots the new bundle from it
# (scripts/snapshot-state.sh), so nothing in flight is forgotten or paid twice. CONFIG_FROM=genesis/devnet.json
# changes the config at the same time (new params or RPCs, same accounts).
#
# Not `hpdevkit deploy`: that runs `cluster stop ; cluster sync ; cluster start` inside the
# deploymgr container and `sync` refuses while a node is still stopping, so the old contract
# silently comes back (2026-09-08). This copies the bundle into the cluster volume and runs the
# three steps with a real wait in between.
#
# How many nodes: CLUSTER_SIZE, else n from the genesis being deployed (scripts/genesis-info.ts). When both are
# there they must agree, and the host's volume must hold exactly that many node directories, or nothing is touched.
# Every node's signing key is kept across the redeploy (scripts/remote/redeploy.sh): the keys are shredded only
# after each one is back on its node and checked, and if the deploy fails after the wipe they stay staged and the
# message says where and how to put them back.
#
# Env:
#   GENESIS          dev (default) | devnet | testnet | mainnet | snapshot
#   CLUSTER          hpdevkit cluster name, default 'default'; 'main' is the sole-operator mainnet cluster
#   CLUSTER_SIZE     n; default from the genesis
#   ACCEPT_NEW_KEYS  nodes allowed to start without a key file (they make new ones): 'all' or e.g. 4,5. Needed for the
#                    first boot of a mainnet cluster (all), and to replace a lost node (that node's number)
#   DEPLOY_HOST      ssh host of the cluster, default bridge-host
#   ACK_SINGLE_HOST  1 to deploy a MAINNET cluster whose nodes all live on this one host (required; every key is in one volume)
#   FRESH_MAINNET    1 with GENESIS=mainnet to confirm a first boot: it wipes consensus state (use GENESIS=snapshot afterwards)
#   DRY_RUN=1        print every command and the remote script instead of running anything
#   SNAPSHOT_REUSE   1 with GENESIS=snapshot: boot from the genesis/snapshot.json that is already there instead of pulling
#                    the state off the cluster first. For a snapshot built from a backup copy (STATE_FROM=<dir> bash
#                    scripts/snapshot-state.sh), when the box that held the cluster is gone
#   CONFIG_FROM, BRIDGE_MINTER   passed on to the snapshot and genesis steps as before
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=lib/ops.sh
. scripts/lib/ops.sh

export GENESIS="${GENESIS:-dev}"
# CLUSTER=main targets a second hpdevkit cluster on the same box (containers hpdevkit_main_*, bundle dir /root/bridge-cluster-main).
export CLUSTER="${CLUSTER:-default}"
HOST="${DEPLOY_HOST:-bridge-host}"
check_name GENESIS "$GENESIS"
check_name CLUSTER "$CLUSTER"
check_name DEPLOY_HOST "$HOST"
REMOTE_DIR=/root/bridge-cluster$([ "$CLUSTER" = default ] || echo "-$CLUSTER")
ACCEPT_NEW_KEYS="${ACCEPT_NEW_KEYS:-}"
is_dry && note "DRY_RUN=1: nothing below is run; every command is printed"

IS_MAINNET=0
if [ "$GENESIS" = "mainnet" ]; then
  # Mainnet has no faucet, so testnet-setup.ts cannot refresh it: genesis/mainnet.json comes from scripts/mainnet-genesis.ts
  # (addresses only, with the seed list), run right before this so the cursor starts at a recent ledger.
  IS_MAINNET=1
  [ -f genesis/mainnet.json ] || { echo "genesis/mainnet.json is missing: run scripts/seed-build.ts and scripts/mainnet-genesis.ts first"; exit 1; }
  AGE_MIN=$(( ( $(date +%s) - $(stat -f %m genesis/mainnet.json 2>/dev/null || stat -c %Y genesis/mainnet.json) ) / 60 ))
  [ "$AGE_MIN" -le 30 ] || echo "  WARNING: genesis/mainnet.json is ${AGE_MIN} minutes old; the cluster will read every ledger since its cursor. Rerun scripts/mainnet-genesis.ts for a fresh one."
elif [ "$GENESIS" != "dev" ] && [ "$GENESIS" != "snapshot" ]; then
  # A redeploy wipes consensus state and restarts from the genesis cursors. Fresh cursors mean the new state
  # neither replays days of locks and burns it no longer remembers paying, nor skips more than the seconds
  # between this line and the first round. (The setup only submits XRPL transactions for accounts or trust
  # lines that are missing; on an existing setup it just rewrites genesis/$GENESIS.json.)
  note "refresh $GENESIS genesis cursors"
  if is_dry; then
    echo "+ XRPL_NETWORK=$GENESIS npx tsx scripts/testnet-setup.ts | grep -E 'genesis/$GENESIS.json written|ERROR'"
  else
    XRPL_NETWORK=$GENESIS npx tsx scripts/testnet-setup.ts | grep -E "genesis/$GENESIS.json written|ERROR" || { echo "testnet-setup failed"; exit 1; }
  fi
fi
if [ "$GENESIS" = "snapshot" ]; then
  if [ "${SNAPSHOT_REUSE:-0}" = 1 ]; then
    [ -f genesis/snapshot.json ] || die "SNAPSHOT_REUSE=1 but genesis/snapshot.json does not exist: build it with STATE_FROM=<backup copy> bash scripts/snapshot-state.sh"
    note "SNAPSHOT_REUSE=1: booting from genesis/snapshot.json as it is ($(wc -c < genesis/snapshot.json | tr -d ' ') bytes, written $(date -r genesis/snapshot.json '+%Y-%m-%d %H:%M' 2>/dev/null || echo '?')); nothing is pulled off a cluster"
  else
    # The snapshot step pulls the state off the host and writes genesis/snapshot.json (it honours DRY_RUN itself).
    bash scripts/snapshot-state.sh
  fi
fi

# How many nodes, and whether this is real money. A snapshot's config carries both, like any genesis.
GENESIS_FILE="genesis/$GENESIS.json"
if [ -f "$GENESIS_FILE" ]; then
  [ "$(genesis_field "$GENESIS_FILE" network)" != mainnet ] || IS_MAINNET=1
fi
if is_dry && [ ! -f "$GENESIS_FILE" ] && [ -z "${CLUSTER_SIZE:-}" ]; then
  NODES=UNKNOWN
  echo "  (n is read from $GENESIS_FILE once the snapshot step has written it; set CLUSTER_SIZE to preview a number)"
else
  NODES="$(resolve_size "$GENESIS_FILE")"
fi
echo "  cluster $CLUSTER on $HOST: $NODES node(s), genesis $GENESIS$([ "$IS_MAINNET" = 1 ] && echo ' (MAINNET)')"

# Two things this script does that real money should not meet by accident (pre-mainnet review, 2026-10-17). A dry run only warns.
guard() {
  if is_dry; then echo "  WARNING: $*"; else die "$*"; fi
}
if [ "$IS_MAINNET" = 1 ]; then
  [ "${ACK_SINGLE_HOST:-0}" = 1 ] || guard "this script runs every node of the cluster on ONE host ($HOST) and keeps all $NODES signing keys in one docker volume, so one compromise of that machine is the whole quorum. The sole-operator proof of concept accepts that and says so on the site; set ACK_SINGLE_HOST=1 to confirm. (One node per machine needs the multi-instance deployment, not this script.)"
  [ "$GENESIS" != mainnet ] || [ "${FRESH_MAINNET:-0}" = 1 ] || guard "GENESIS=mainnet wipes the cluster's consensus state and restarts from the genesis cursors. That is right for the first two boots (XRPL only, then both sides); once real transfers exist it forgets which burns were paid. Use GENESIS=snapshot then. Set FRESH_MAINNET=1 to confirm this is a first boot."
fi

note "build (genesis=$GENESIS)"
run npm run --silent build
run npm run --silent build:client
note "rsync"
run ssh "$HOST" "mkdir -p $REMOTE_DIR"
run rsync -az --delete dist/ "$HOST:$REMOTE_DIR/dist/"
run rsync -az --delete dist-client/ "$HOST:$REMOTE_DIR/client/"
note "stop, sync, start (wipes contract state; node-local /tmp files cleared too; the signing keys are kept)"
remote_run "$HOST" scripts/remote/redeploy.sh "CLUSTER=$CLUSTER" "REMOTE_DIR=$REMOTE_DIR" "NODES=$NODES" "MAINNET=$IS_MAINNET" "ACCEPT_NEW_KEYS=$ACCEPT_NEW_KEYS"
