#!/usr/bin/env bash
# Backs up every node's signing keys into ONE file that only a key you hold offline can open.
#
# Run it ON THE NODE HOST (as root, or whoever can read the cluster volume). It collects each node's
# bridge-keys.json and bridge-payout.json from the volume, encrypts them to a recipient PUBLIC key and writes a single
# file. It prints the file's sha256 and the addresses it covers, never a key. There is no passphrase mode and no
# plaintext fallback: without a recipient it writes nothing. The matching private key never comes near this host.
#
#   BACKUP_RECIPIENT=age1xxxx...  CLUSTER=main bash keys-backup.sh               # age (when installed)
#   BACKUP_RECIPIENT=<40-hex gpg fingerprint> CLUSTER=main bash keys-backup.sh   # gpg --encrypt --recipient
#   DRY_RUN=1 BACKUP_RECIPIENT=... CLUSTER=main bash keys-backup.sh              # list what would be covered, write nothing
#
# Check the result on the machine that holds the private key, with scripts/keys-restore.sh --verify FILE.
# Procedure and what is safe to lose: KEYS.md.
#
# Env:
#   BACKUP_RECIPIENT    age: one or more public keys (age1...), comma separated. gpg: one or more full fingerprints
#                       (40 hex), comma separated, already imported into this host's keyring. Required.
#   BACKUP_RECIPIENTS_FILE   age only: a recipients file (age -R), used in addition to BACKUP_RECIPIENT
#   BACKUP_TOOL         age | gpg (default: age if installed, else gpg)
#   BACKUP_OUT          output file (default ./bridge-keys-<cluster>-<UTC time>.tar.age|.tar.gpg); never overwritten
#   CLUSTER             hpdevkit cluster name (default 'default'); the volume is hpdevkit_<CLUSTER>_vol
#   CLUSTER_SIZE        how many nodes (default: the node<N> directories the volume holds)
#   NODE_NUMBERS        explicit node numbers, e.g. 4 for a host that runs only node 4 (with SEED_DIR_TEMPLATE)
#   SEED_DIR_TEMPLATE   where a node keeps its keys, {n} = node number (default <volume>/node{n}/contract_fs/seed)
#   ALLOW_MISSING_NODES  comma list of nodes whose key file may be absent (the backup says so loudly)
#   VOL_ROOT, STAGE_ROOT, AGE_BIN, GPG_BIN   overrides
#   DRY_RUN=1           print what would be done, write nothing
# Needs: jq, tar, and age or gpg.
set -euo pipefail
umask 077

die() {
  echo "ERROR: $*" >&2
  exit 1
}
usage() {
  echo "ERROR: $*" >&2
  exit 2
}

DRY_RUN="${DRY_RUN:-0}"
case "$DRY_RUN" in 0 | 1) ;; *) usage "DRY_RUN must be 0 or 1" ;; esac
CLUSTER="${CLUSTER:-default}"
VOL_ROOT="${VOL_ROOT:-/var/lib/docker/volumes}"
AGE_BIN="${AGE_BIN:-age}"
GPG_BIN="${GPG_BIN:-gpg}"
BACKUP_TOOL="${BACKUP_TOOL:-}"
BACKUP_RECIPIENT="${BACKUP_RECIPIENT:-}"
BACKUP_RECIPIENTS_FILE="${BACKUP_RECIPIENTS_FILE:-}"
ALLOW_MISSING_NODES="${ALLOW_MISSING_NODES:-}"
name_re='^[A-Za-z0-9][A-Za-z0-9_-]*$'
[[ "$CLUSTER" =~ $name_re ]] || usage "bad CLUSTER '$CLUSTER'"
command -v jq >/dev/null 2>&1 || die "jq is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# ------------------------------------------------------------------ tool and recipient (no recipient, no file)

if [ -z "$BACKUP_TOOL" ]; then
  if command -v "$AGE_BIN" >/dev/null 2>&1; then BACKUP_TOOL=age; else BACKUP_TOOL=gpg; fi
fi
case "$BACKUP_TOOL" in
  age | gpg) ;;
  *) usage "BACKUP_TOOL must be age or gpg, got '$BACKUP_TOOL'" ;;
esac
if [ -z "$BACKUP_RECIPIENT" ] && [ -z "$BACKUP_RECIPIENTS_FILE" ]; then
  usage "no recipient. Set BACKUP_RECIPIENT to the PUBLIC key the backup is encrypted to (an age1... key, or a gpg fingerprint). There is no passphrase mode and no unencrypted mode: nothing was written."
fi
if [ "$BACKUP_TOOL" = gpg ] && [ -n "$BACKUP_RECIPIENTS_FILE" ]; then usage "BACKUP_RECIPIENTS_FILE is for age; give gpg its recipients in BACKUP_RECIPIENT"; fi

RECIPIENT_ARGS=()
RECIPIENT_SUMMARY=""
IFS=',' read -r -a RCPTS <<<"$BACKUP_RECIPIENT"
if [ -n "$BACKUP_RECIPIENT" ]; then
  for r in "${RCPTS[@]}"; do
    r="${r// /}"
    [ -n "$r" ] || usage "BACKUP_RECIPIENT has an empty entry"
    if [ "$BACKUP_TOOL" = age ]; then
      case "$r" in
        AGE-SECRET-KEY-*) usage "BACKUP_RECIPIENT holds an age PRIVATE key. Give the public key (age1...) and keep the private one off this host." ;;
        age1[a-z0-9]*) RECIPIENT_ARGS+=(-r "$r") ;;
        *) usage "BACKUP_RECIPIENT entry '${r:0:12}...' is not an age public key (age1...)" ;;
      esac
      RECIPIENT_SUMMARY="$RECIPIENT_SUMMARY $r"
    else
      r="$(printf '%s' "$r" | tr 'a-f' 'A-F')"
      [[ "$r" =~ ^[0-9A-F]{40}$ ]] || usage "gpg recipients must be full 40-hex fingerprints (a short id or an email can name the wrong key), got '${r:0:12}...'"
      "$GPG_BIN" --batch --list-keys "$r" >/dev/null 2>&1 || die "no public key $r in this host's gpg keyring: import the public key first (gpg --import)"
      RECIPIENT_ARGS+=(--recipient "$r")
      RECIPIENT_SUMMARY="$RECIPIENT_SUMMARY $r"
    fi
  done
fi
if [ -n "$BACKUP_RECIPIENTS_FILE" ]; then
  [ -r "$BACKUP_RECIPIENTS_FILE" ] || die "cannot read BACKUP_RECIPIENTS_FILE $BACKUP_RECIPIENTS_FILE"
  if grep -q 'AGE-SECRET-KEY-' "$BACKUP_RECIPIENTS_FILE"; then die "$BACKUP_RECIPIENTS_FILE contains an age PRIVATE key; it must list public keys only"; fi
  RECIPIENT_ARGS+=(-R "$BACKUP_RECIPIENTS_FILE")
  RECIPIENT_SUMMARY="$RECIPIENT_SUMMARY file:$BACKUP_RECIPIENTS_FILE"
fi
if [ "$BACKUP_TOOL" = age ]; then command -v "$AGE_BIN" >/dev/null 2>&1 || die "age is not installed (or set BACKUP_TOOL=gpg)"; else command -v "$GPG_BIN" >/dev/null 2>&1 || die "gpg is not installed (or install age)"; fi

# ------------------------------------------------------------------ which nodes, and where their keys are

VOL="${VOL:-$VOL_ROOT/hpdevkit_${CLUSTER}_vol/_data}"
seed_dir_of() {
  if [ -n "${SEED_DIR_TEMPLATE:-}" ]; then printf '%s' "${SEED_DIR_TEMPLATE//\{n\}/$1}"; else printf '%s/node%s/contract_fs/seed' "$VOL" "$1"; fi
}
NODES=""
if [ -n "${NODE_NUMBERS:-}" ]; then
  list_re='^[1-9][0-9]*(,[1-9][0-9]*)*$'
  [[ "$NODE_NUMBERS" =~ $list_re ]] || usage "NODE_NUMBERS must look like 4 or 1,2,3"
  NODES="${NODE_NUMBERS//,/ }"
else
  count="${CLUSTER_SIZE:-}"
  if [ -z "$count" ]; then
    [ -z "${SEED_DIR_TEMPLATE:-}" ] || usage "with SEED_DIR_TEMPLATE give CLUSTER_SIZE or NODE_NUMBERS"
    [ -d "$VOL" ] || die "no volume at $VOL: is cluster '$CLUSTER' on this host? (CLUSTER=, VOL_ROOT=)"
    count=0
    for d in "$VOL"/node*; do
      [ -d "$d" ] || continue
      case "${d##*/}" in node*[!0-9]* | node) ;; *) count=$((count + 1)) ;; esac
    done
  fi
  int_re='^[1-9][0-9]*$'
  [[ "$count" =~ $int_re ]] || die "cannot tell how many nodes there are (found '$count'): set CLUSTER_SIZE"
  NODES="$(seq 1 "$count" | tr '\n' ' ')"
fi
NODES="${NODES% }"

allowed_missing() {
  case ",$ALLOW_MISSING_NODES," in *",$1,"*) return 0 ;; esac
  return 1
}

COVERED=""
MISSING=""
SUMMARY=()
for n in $NODES; do
  dir="$(seed_dir_of "$n")"
  keyfile="$dir/bridge-keys.json"
  if [ ! -s "$keyfile" ]; then
    if allowed_missing "$n"; then
      MISSING="$MISSING $n"
      continue
    fi
    die "node $n has no key file at $keyfile. A backup that silently leaves a node out is worse than none. Fix that first, or name the node in ALLOW_MISSING_NODES=$n if it really has no key."
  fi
  # The two address fields are public; the type check reads the secret fields but prints nothing.
  if ! jq -e '(.xrpl.address|type=="string") and (.evm.address|type=="string") and (.xrpl.seed|type=="string") and (.evm.privateKey|type=="string")' "$keyfile" >/dev/null 2>&1; then
    die "node $n: $keyfile is not a bridge key file (missing the xrpl and evm fields). Not backing up something that cannot be restored."
  fi
  xrpl_addr="$(jq -r '.xrpl.address' "$keyfile")"
  evm_addr="$(jq -r '.evm.address' "$keyfile")"
  payout="no"
  if [ -s "$dir/bridge-payout.json" ]; then payout="yes"; fi
  COVERED="$COVERED $n"
  SUMMARY+=("  node $n  xrpl $xrpl_addr  evm $evm_addr  payout file $payout")
done
[ -n "$COVERED" ] || die "no node has a key file: nothing to back up"

echo "cluster $CLUSTER: $(echo "$COVERED" | wc -w | tr -d ' ') of $(echo "$NODES" | wc -w | tr -d ' ') node(s) covered (addresses only):"
printf '%s\n' "${SUMMARY[@]}"
if [ -n "$MISSING" ]; then echo "WARNING: node(s)$MISSING are NOT in this backup (ALLOW_MISSING_NODES)." >&2; fi

# ------------------------------------------------------------------ the file

ext="tar.$BACKUP_TOOL"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_OUT:-./bridge-keys-$CLUSTER-$stamp.$ext}"
[ ! -e "$OUT" ] || die "$OUT already exists; refusing to overwrite a backup"
PARTIAL="$OUT.partial"

if [ "$BACKUP_TOOL" = age ]; then
  ENCRYPT=("$AGE_BIN" "${RECIPIENT_ARGS[@]}" -o "$PARTIAL")
else
  ENCRYPT=("$GPG_BIN" --batch --yes --no-tty --trust-model always --encrypt "${RECIPIENT_ARGS[@]}" --output "$PARTIAL")
fi

STAGE_ROOT="${STAGE_ROOT:-}"
if [ -z "$STAGE_ROOT" ]; then
  if [ -d /dev/shm ] && [ -w /dev/shm ]; then STAGE_ROOT=/dev/shm; else STAGE_ROOT="${TMPDIR:-/tmp}"; fi
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "DRY_RUN=1: nothing is staged, encrypted or written."
  echo "+ stage the key files and a manifest in a 0700 directory under $STAGE_ROOT"
  printf '+ tar -cf - -C <stage> manifest.json'
  for n in $COVERED; do printf ' node%s' "$n"; done
  printf ' | '
  printf '%q ' "${ENCRYPT[@]}"
  printf '\n+ mv %q %q\n' "$PARTIAL" "$OUT"
  exit 0
fi

STAGE="$(mktemp -d "$STAGE_ROOT/bridge-backup.XXXXXX")"
chmod 700 "$STAGE"
cleanup() {
  local f
  if [ -n "${STAGE:-}" ] && [ -d "$STAGE" ]; then
    while IFS= read -r f; do
      if command -v shred >/dev/null 2>&1; then shred -u "$f" 2>/dev/null || rm -f "$f"; else rm -f "$f"; fi
    done < <(find "$STAGE" -type f)
    rm -rf "$STAGE"
  fi
  [ ! -e "${PARTIAL:-}" ] || rm -f "$PARTIAL"
}
trap cleanup EXIT

NODE_JSON=()
for n in $COVERED; do
  dir="$(seed_dir_of "$n")"
  mkdir -p "$STAGE/node$n/contract_fs/seed"
  cp "$dir/bridge-keys.json" "$STAGE/node$n/contract_fs/seed/bridge-keys.json"
  files='["bridge-keys.json"]'
  payout_addr=""
  if [ -s "$dir/bridge-payout.json" ]; then
    cp "$dir/bridge-payout.json" "$STAGE/node$n/contract_fs/seed/bridge-payout.json"
    files='["bridge-keys.json","bridge-payout.json"]'
    payout_addr="$(jq -r '.address // empty' "$dir/bridge-payout.json" 2>/dev/null || true)"
  fi
  # Only these fields: the manifest holds addresses, never a seed or a private key.
  NODE_JSON+=("$(jq -c --argjson n "$n" --argjson files "$files" --arg payout "$payout_addr" '{n:$n, xrplAddress:.xrpl.address, evmAddress:.evm.address, payoutAddress:(if $payout=="" then null else $payout end), files:$files}' "$dir/bridge-keys.json")")
done
printf '%s\n' "${NODE_JSON[@]}" | jq -s --arg created "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg cluster "$CLUSTER" --arg host "$(hostname)" '{format:"blume-bridge-keys/1", createdAt:$created, cluster:$cluster, host:$host, nodes:.}' >"$STAGE/manifest.json"

TAR_ITEMS=(manifest.json)
for n in $COVERED; do TAR_ITEMS+=("node$n"); done
tar -cf - -C "$STAGE" "${TAR_ITEMS[@]}" | "${ENCRYPT[@]}"
[ -s "$PARTIAL" ] || die "the encryption tool wrote nothing; no backup was made"
mv "$PARTIAL" "$OUT"
chmod 600 "$OUT"

echo ""
echo "backup written: $OUT ($(wc -c <"$OUT" | tr -d ' ') bytes)"
echo "sha256: $(sha256_of "$OUT")"
echo "encrypted with $BACKUP_TOOL to:$RECIPIENT_SUMMARY"
echo "Next: copy it OFF this host (it is safe anywhere the private key is not), then on the machine that holds the private key:"
echo "  bash scripts/keys-restore.sh --verify $(basename "$OUT")"
