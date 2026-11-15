#!/usr/bin/env bash
# Create the cluster on Evernode (mainnet EVR). The operator runs this; it signs the leases with the tenant wallet and never prints
# the seed. Everything else is read-only afterwards.
#
#   bash scripts/evernode-cluster.sh            # as many nodes as the built genesis says (dist/genesis.json n), one on each of the first n hosts of hp/hosts.txt
#   HOSTS=hp/hosts-mainnet.txt MOMENTS=72 bash scripts/evernode-cluster.sh
#   RESUME=1 bash scripts/evernode-cluster.sh    # after a failure part-way: carry on from keys/evernode-cluster.json
#   DRY_RUN=1 bash scripts/evernode-cluster.sh   # print the plan; read no wallet, touch no network
#
# The instances are leased one host at a time by scripts/evernode-spread.ts, not by `evdevkit cluster-create`, which puts a
# second instance on the first host when it has a slot (two of three on one operator in the rehearsal of 2026-10-18).
#
# It ends when the cluster has FORMED (every instance on the app, synced, closing ledgers), not when the bundle is up: the second
# rehearsal of 2026-10-18 had every instance on the app and a cluster that never closed another ledger (Decision 39). A mainnet
# cluster is first leased for a few moments only (MOMENTS=3), proven, and extended afterwards (scripts/evernode-extend.sh).
#
# The node count is n from dist/genesis.json (the genesis the bundle was built with); SIZE or CLUSTER_SIZE may
# restate it but must agree. A cluster of the wrong size boots a config that names other operators than exist.
set -euo pipefail
cd "$(dirname "$0")/.."

DRY_RUN="${DRY_RUN:-0}"
SIZE="${SIZE:-${CLUSTER_SIZE:-}}"   # empty: n from dist/genesis.json, below
MOMENTS="${MOMENTS:-2}"
IMAGE="${IMAGE:-evernode/sashimono:hp.0.6.5-beta-ubt.20.04-njs.20}"   # default hp.0.6.4 is the build whose peer handshake failed us twice
HOSTS="${HOSTS:-hp/hosts.txt}"
# The tenant that pays the leases: the bridge's own wallet (scripts/evernode-tenant.ts new) when it exists, else the throwaway one the rehearsals used.
if [ -z "${WALLET_FILE:-}" ]; then
  if [ -f keys/evernode-tenant.txt ]; then WALLET_FILE="$PWD/keys/evernode-tenant.txt"; else WALLET_FILE="$HOME/Projects/evernode-test-deploy/tenant-test-wallet.txt"; fi
fi
CLIENT_KEY_FILE="keys/evernode-client.json"

[ -f "$HOSTS" ] || { echo "hosts file $HOSTS missing (copy hp/hosts.example.txt and put the second host on line 2)"; exit 1; }
[ "$DRY_RUN" = 1 ] || [ -f "$WALLET_FILE" ] || { echo "tenant wallet file $WALLET_FILE missing"; exit 1; }
[ -f dist/index.js ] && [ -f dist/genesis.json ] || { echo "dist/ missing: run GENESIS=testnet npm run build first"; exit 1; }
GENESIS_N="$(npx --no-install tsx scripts/genesis-info.ts dist/genesis.json n)" || { echo "cannot read n from dist/genesis.json"; exit 1; }
SIZE="${SIZE:-$GENESIS_N}"
[ "$SIZE" = "$GENESIS_N" ] || { echo "SIZE=$SIZE but dist/genesis.json says n=$GENESIS_N: the cluster would boot a config for $GENESIS_N operators with $SIZE nodes. Rebuild with the right genesis or fix SIZE."; exit 1; }

# Where the instances go matters as much as that they exist: an instance's host operator can read its signing keys, so no operator may run
# k or more of the n instances, and each instance needs a host of its own (scripts/evernode-hosts.ts, a read-only registry check). A mainnet
# genesis always gets it; a test genesis may skip it (SKIP_PLACEMENT_CHECK=1) for a rehearsal on hosts that are the operator's own.
GENESIS_K="$(npx --no-install tsx scripts/genesis-info.ts dist/genesis.json k)"
GENESIS_NET="$(npx --no-install tsx scripts/genesis-info.ts dist/genesis.json network)"
# HotPocket's own threshold (80%) needs all of three nodes to close a ledger, and one node a ledger behind then stalls the
# cluster for good (Decision 39). The cluster runs at the percentage at which k of n nodes are enough; CONSENSUS_PCT overrides it.
CONSENSUS_PCT="${CONSENSUS_PCT:-$(npx --no-install tsx scripts/genesis-info.ts dist/genesis.json consensus)}" || { echo "cannot work out the consensus threshold for k=$GENESIS_K of n=$GENESIS_N: set CONSENSUS_PCT (51 to 100) or fix the genesis"; exit 1; }
if [ "$GENESIS_NET" = "mainnet" ] && [ "${SKIP_PLACEMENT_CHECK:-0}" = 1 ]; then echo "SKIP_PLACEMENT_CHECK is not allowed for a mainnet genesis"; exit 1; fi
PLACEMENT="npx --no-install tsx scripts/evernode-hosts.ts check $HOSTS --n $SIZE --k $GENESIS_K --moments $MOMENTS"

if [ "$DRY_RUN" = 1 ]; then
  echo "DRY_RUN=1: nothing is read from the wallet file or sent anywhere."
  echo "  nodes: $SIZE (n from dist/genesis.json), $MOMENTS moment(s) each, image $IMAGE"
  echo "  HotPocket consensus threshold: $CONSENSUS_PCT% (k=$GENESIS_K of n=$GENESIS_N nodes close a ledger; HotPocket's own default is 80%)"
  echo "  hosts ($HOSTS):"
  sed 's/^/    /' "$HOSTS"
  [ "${SKIP_PLACEMENT_CHECK:-0}" = 1 ] || echo "+ $PLACEMENT   (a read-only registry check; refuses a host operator that would run $GENESIS_K or more of $SIZE)"
  echo "  EV_TENANT_SECRET would be read from $WALLET_FILE (seed= line) into the environment, never printed; EV_NETWORK unset = Evernode MAINNET"
  echo "+ HOSTS=$HOSTS SIZE=$SIZE MOMENTS=$MOMENTS IMAGE=$IMAGE DIST=$PWD/dist CONSENSUS_PCT=$CONSENSUS_PCT npx --no-install tsx scripts/evernode-spread.ts"
  HOSTS="$HOSTS" SIZE="$SIZE" MOMENTS="$MOMENTS" IMAGE="$IMAGE" DIST="$PWD/dist" CONSENSUS_PCT="$CONSENSUS_PCT" RESUME="${RESUME:-0}" DRY_RUN=1 npx --no-install tsx scripts/evernode-spread.ts
  exit 0
fi
if [ "${SKIP_PLACEMENT_CHECK:-0}" != 1 ]; then
  echo "== placement: $SIZE instance(s), k=$GENESIS_K"
  $PLACEMENT || { echo "placement refused: fix $HOSTS (or SKIP_PLACEMENT_CHECK=1 for a test genesis)"; exit 1; }
fi
mkdir -p keys && chmod 700 keys

unset EV_NETWORK                                   # unset = MAINNET; this host and the tenant wallet are mainnet
export EV_TENANT_SECRET
EV_TENANT_SECRET="$(grep -E '^seed=' "$WALLET_FILE" | head -1 | cut -d= -f2- | tr -d ' \r')"
[ -n "$EV_TENANT_SECRET" ] || { echo "no seed= line in $WALLET_FILE"; exit 1; }
echo "tenant: $(grep -E '^address=' "$WALLET_FILE" | cut -d= -f2- | tr -d ' \r')"

# Contract-client key: one per cluster, kept for later uploads/extends. evdevkit prints it in its
# final cluster summary, so the output is piped through sed to mask it. Delete the file after a
# cluster is done; the next run generates a fresh one.
if [ ! -f "$CLIENT_KEY_FILE" ]; then
  KEYGEN="$(evdevkit keygen 2>&1)"
  PRIV="$(printf '%s' "$KEYGEN" | grep -oE "privateKey: '[0-9a-fA-F]+'" | cut -d"'" -f2)"
  PUB="$(printf '%s' "$KEYGEN" | grep -oE "publicKey: '[0-9a-fA-F]+'" | cut -d"'" -f2)"
  [ -n "$PRIV" ] && [ -n "$PUB" ] || { echo "keygen output not understood"; exit 1; }
  umask 077; printf '{"privateKey":"%s","publicKey":"%s","createdAt":"%s"}\n' "$PRIV" "$PUB" "$(date -u +%FT%TZ)" > "$CLIENT_KEY_FILE"
  echo "client key generated → $CLIENT_KEY_FILE (public ${PUB:0:16}…)"
fi
export EV_USER_PRIVATE_KEY
EV_USER_PRIVATE_KEY="$(node -e 'console.log(require(process.argv[1]).privateKey)' "$PWD/$CLIENT_KEY_FILE")"

# Pre-flight: the tenant must already hold EVR (leases) and XAH (fees + URIToken reserves). Read-only.
TENANT_ADDR="$(grep -E '^address=' "$WALLET_FILE" | cut -d= -f2- | tr -d ' \r')"
node -e '
const xrpl = require("xrpl"); const [addr, minEvr, minXah] = process.argv.slice(1);
(async () => { const c = new xrpl.Client("wss://xahau.network"); await c.connect();
  const ai = await c.request({ command: "account_info", account: addr, ledger_index: "validated" });
  const li = await c.request({ command: "account_lines", account: addr });
  const xah = Number(ai.result.account_data.Balance) / 1e6;
  const evr = Number((li.result.lines || []).find(l => l.currency === "EVR")?.balance ?? 0);
  await c.disconnect();
  console.log(`tenant balance: ${xah} XAH, ${evr} EVR`);
  if (evr < Number(minEvr) || xah < Number(minXah)) { console.log(`NOT FUNDED: need at least ${minEvr} EVR and ${minXah} XAH at ${addr} on Xahau mainnet before running this`); process.exit(2); }
})().catch(e => { console.log("balance check failed:", e.message); process.exit(2); });
' "$TENANT_ADDR" "${MIN_EVR:-1}" "${MIN_XAH:-3}" || exit 2

export EV_HP_INIT_CFG_PATH="$PWD/hp/evernode-init.json"          # peer discovery off
export EV_HP_OVERRIDE_CFG_PATH="$PWD/hp/evernode-override.json"  # roundtime 3000

echo "== hosts"
evdevkit hostinfo -f "$HOSTS" 2>&1 | grep -E "address|domain|countryCode|availableInstanceSlots|active|leaseAmount|hpVersion|version" || true

LOG="keys/evernode-cluster-$(date -u +%Y%m%dT%H%M%SZ).log"
echo "== leasing $SIZE instance(s), one on each host, $MOMENTS moment(s) each, image $IMAGE, consensus threshold $CONSENSUS_PCT% (log → $LOG)"
set +e
HOSTS="$HOSTS" SIZE="$SIZE" MOMENTS="$MOMENTS" IMAGE="$IMAGE" DIST="$PWD/dist" CONSENSUS_PCT="$CONSENSUS_PCT" RESUME="${RESUME:-0}" npx --no-install tsx scripts/evernode-spread.ts 2>&1 | tee "$LOG"
RC=${PIPESTATUS[0]}
set -e
if [ "$RC" = "0" ]; then
  echo "cluster formed (log $LOG; the instances are listed in keys/evernode-cluster.json; look again any time with: npx tsx scripts/cluster-health.ts --file keys/evernode-cluster.json)"
else
  echo "NOT DONE (exit $RC; see above and $LOG). If some instances were not leased yet: RESUME=1 bash scripts/evernode-cluster.sh. If all are leased but the cluster did not form, resuming does not help: see Decision 39."
fi
exit "$RC"
