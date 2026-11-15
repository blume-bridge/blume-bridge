#!/usr/bin/env bash
# Creates a second (third, ...) hpdevkit cluster on the dev cluster's host (bridge-host) beside the dev one, with the
# same tooling: its own deploy manager, volume, network, container prefix and ports. hpdevkit 0.6.8
# itself only knows one cluster ("default"), but its manager is a bash script driven by environment
# variables, so a second manager with the names swapped is a second cluster. Used for the sole-operator
# mainnet cluster (CLUSTER=main, user ports from 8091, peer ports from 22871), created 2026-09-11 on the old validator box
# (archived, not run, when the dev cluster moved to the blume VM on 2026-10-10). A real mainnet cluster must NOT be created on the
# same box: the bridge audit wants the nodes on separate machines and providers.
#
#   CLUSTER=main CLUSTER_SIZE=5 USER_PORT=8091 PEER_PORT=22871 bash scripts/hpdevkit-cluster.sh create
#   CLUSTER=main bash scripts/hpdevkit-cluster.sh inspect      # what destroy would lose; changes nothing
#   CLUSTER=main CONFIRM_DESTROY=main bash scripts/hpdevkit-cluster.sh destroy
#
# create needs the node count: CLUSTER_SIZE, else n from the genesis named by GENESIS (dev, devnet, testnet,
# mainnet, snapshot), which must agree when both are given. There is no default: a three-node cluster for a
# five-node genesis would be found out at the first redeploy.
#
# destroy stops and removes the nodes, the manager, the volume (SIGNING KEYS AND CONSENSUS STATE INCLUDED) and the
# network. It always prints what will be lost first. For a cluster named 'main', or one whose state or deployed
# genesis points at mainnet, it refuses (exit 3) unless CONFIRM_DESTROY is set to the cluster's name; take
# scripts/keys-backup.sh on the host first.
#
# Env: CLUSTER (required, not 'default'), CLUSTER_SIZE / GENESIS (create), USER_PORT (8091), PEER_PORT (22871),
# CONFIRM_DESTROY, DEPLOY_HOST (bridge-host), DRY_RUN=1 (print every command and the remote script, run nothing).
# Then deploy with CLUSTER=main GENESIS=<genesis> bash scripts/deploy-dev.sh and query localhost:809x.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=lib/ops.sh
. scripts/lib/ops.sh

CLUSTER="${CLUSTER:?CLUSTER is required (not 'default')}"
check_name CLUSTER "$CLUSTER"
[ "$CLUSTER" = default ] && { echo "the default cluster is hpdevkit's own; pick another name"; exit 1; }
HOST="${DEPLOY_HOST:-bridge-host}"
check_name DEPLOY_HOST "$HOST"
USER_PORT="${USER_PORT:-8091}"
PEER_PORT="${PEER_PORT:-22871}"
CMD="${1:-create}"
REMOTE_DIR=/root/bridge-cluster-$CLUSTER
is_dry && note "DRY_RUN=1: nothing below is run; every command is printed"

# Mainnet as far as this side can tell: the genesis named by GENESIS. The host checks the cluster's own state as well.
IS_MAINNET=0
if [ -n "${GENESIS:-}" ]; then
  check_name GENESIS "$GENESIS"
  if [ "$GENESIS" = mainnet ]; then IS_MAINNET=1; fi
  if [ -f "genesis/$GENESIS.json" ] && [ "$(genesis_field "genesis/$GENESIS.json" network)" = mainnet ]; then IS_MAINNET=1; fi
fi

case "$CMD" in
  create)
    [ -n "${GENESIS:-}" ] || [ -n "${CLUSTER_SIZE:-}" ] || die "create needs CLUSTER_SIZE, or GENESIS=<name> to read n from; there is no default size"
    NODES="$(resolve_size "${GENESIS:+genesis/$GENESIS.json}")"
    echo "  creating cluster $CLUSTER with $NODES node(s): user ports $USER_PORT-$((USER_PORT + NODES - 1)), peer ports $PEER_PORT-$((PEER_PORT + NODES - 1))"
    remote_run "$HOST" scripts/remote/cluster-manage.sh CMD=create "CLUSTER=$CLUSTER" "NODES=$NODES" "USER_PORT=$USER_PORT" "PEER_PORT=$PEER_PORT"
    ;;
  inspect)
    remote_run "$HOST" scripts/remote/cluster-manage.sh CMD=inspect "CLUSTER=$CLUSTER"
    ;;
  destroy)
    # Said here too, before any ssh: the host repeats the check against what the cluster really runs.
    if [ "$CLUSTER" = main ] || [ "$IS_MAINNET" = 1 ]; then
      if [ "${CONFIRM_DESTROY:-}" != "$CLUSTER" ]; then
        echo "REFUSED: cluster '$CLUSTER' is the mainnet cluster. Destroying it deletes its signing keys and its consensus state." >&2
        echo "Run 'CLUSTER=$CLUSTER bash scripts/hpdevkit-cluster.sh inspect' to see what is there, take scripts/keys-backup.sh on the host," >&2
        echo "then repeat with CONFIRM_DESTROY=$CLUSTER." >&2
        exit 3
      fi
    fi
    remote_run "$HOST" scripts/remote/cluster-manage.sh CMD=destroy "CLUSTER=$CLUSTER" "REMOTE_DIR=$REMOTE_DIR" "MAINNET=$IS_MAINNET" "CONFIRM_DESTROY=${CONFIRM_DESTROY:-}"
    ;;
  *)
    echo "usage: CLUSTER=<name> hpdevkit-cluster.sh create|inspect|destroy" >&2
    exit 2
    ;;
esac
