#!/usr/bin/env bash
# Extend the leases of a cluster's instances. A lapsed lease purges the instance and its keys with no grace period, so this is
# the renewal. The operator runs it; it signs with the tenant wallet and never prints the seed.
#
#   bash scripts/evernode-extend.sh 720                              # every instance in keys/evernode-cluster.json, 720 moments (30 days) more
#   LIST=keys/evernode-rehearsal.json bash scripts/evernode-extend.sh 1
#   DRY_RUN=1 bash scripts/evernode-extend.sh 720                    # print what it would send; read no wallet, touch no network
#
# LIST is the instance list scripts/evernode-spread.ts writes: {"nodes":[{"host":"r…","name":"…"},…]}. Each extension is one
# transaction per instance, at the host's price per moment (about 0.000001 EVR).
set -euo pipefail
cd "$(dirname "$0")/.."

MOMENTS="${1:-}"
LIST="${LIST:-keys/evernode-cluster.json}"
DRY_RUN="${DRY_RUN:-0}"
if [ -z "${WALLET_FILE:-}" ]; then
  if [ -f keys/evernode-tenant.txt ]; then WALLET_FILE="$PWD/keys/evernode-tenant.txt"; else WALLET_FILE="$HOME/Projects/evernode-test-deploy/tenant-test-wallet.txt"; fi
fi

case "$MOMENTS" in ''|*[!0-9]*|0) echo "usage: bash scripts/evernode-extend.sh MOMENTS   (a whole number of hourly moments, 1 or more)"; exit 1;; esac
[ "$MOMENTS" -le 4320 ] || { echo "MOMENTS=$MOMENTS is over 4320 (180 days): extend in steps"; exit 1; }
[ -f "$LIST" ] || { echo "instance list $LIST missing (scripts/evernode-spread.ts writes keys/evernode-cluster.json)"; exit 1; }

LINES="$(node -e '
const nodes = (require(require("path").resolve(process.argv[1])).nodes || []).filter((n) => n.host && n.name)
if (!nodes.length) { console.error("no instances in " + process.argv[1]); process.exit(2) }
for (const n of nodes) console.log(n.host + ":" + n.name + ":" + process.argv[2])
' "$LIST" "$MOMENTS")" || { echo "cannot read instances from $LIST"; exit 1; }

echo "extending $(printf '%s\n' "$LINES" | wc -l | tr -d ' ') instance(s) of $LIST by $MOMENTS moment(s) each:"
printf '%s\n' "$LINES" | sed -E 's/^([^:]{8})[^:]*:([^:]{8})[^:]*:/  \1…  \2…  +/'
if [ "$DRY_RUN" = 1 ]; then
  echo "DRY_RUN=1: the tenant seed is not read and nothing is sent."
  echo "+ evdevkit extend <the lines above> -m $MOMENTS"
  exit 0
fi

unset EV_NETWORK                                   # unset = MAINNET
export EV_TENANT_SECRET
EV_TENANT_SECRET="$(grep -E '^seed=' "$WALLET_FILE" | head -1 | cut -d= -f2- | tr -d ' \r')"
[ -n "$EV_TENANT_SECRET" ] || { echo "no seed= line in $WALLET_FILE"; exit 1; }
FILE="$(mktemp)"; chmod 600 "$FILE"; trap 'rm -f "$FILE"' EXIT
# One instance per evdevkit call. Given all of them in one file it sends the payments from the tenant wallet at once, they
# collide on the account's sequence, and only one lands (2026-10-18: 1 of 3; the other two never reached the ledger).
OK=0
FAILED=""
WANT=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  WANT=$((WANT + 1))
  printf '%s\n' "$line" > "$FILE"
  # evdevkit exits 0 on failure: read what it says.
  OUT="$(evdevkit extend "$FILE" -m "$MOMENTS" 2>&1 | sed -E "s/(privateKey: ')[0-9a-fA-F]+/\1<masked>/")"
  printf '%s\n' "$OUT"
  if printf '%s\n' "$OUT" | grep -q "Extension txn Ref"; then OK=$((OK + 1)); else FAILED="$FAILED ${line%:*}"; fi
done <<< "$LINES"
if [ "$OK" != "$WANT" ]; then
  # The ones that failed, as a list of their own, so a second run extends only them (one already extended would be extended twice).
  RETRY="keys/evernode-extend-retry.json"
  node -e '
const list = require(require("path").resolve(process.argv[1]))
const failed = new Set(process.argv[2].trim().split(/\s+/))
const nodes = (list.nodes || []).filter((n) => failed.has(n.host + ":" + n.name))
require("fs").writeFileSync(process.argv[3], JSON.stringify({ nodes }, null, 2) + "\n", { mode: 0o600 })
' "$LIST" "$FAILED" "$RETRY"
  echo "ONLY $OK of $WANT instances were extended. The rest are in $RETRY: LIST=$RETRY bash scripts/evernode-extend.sh $MOMENTS"
  exit 1
fi
echo "extended $OK of $WANT instances"
