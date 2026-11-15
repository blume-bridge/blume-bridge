#!/usr/bin/env bash
# Opens a bundle written by scripts/keys-backup.sh. Run it on a machine you trust that holds the PRIVATE key
# the backup was encrypted to (never on a node host).
#
#   bash scripts/keys-restore.sh --verify BUNDLE      # opens it, checks every key against its address, lists the addresses; writes nothing
#   bash scripts/keys-restore.sh BUNDLE [--out DIR]   # the same, then writes DIR/node<N>/contract_fs/seed/{bridge-keys,bridge-payout}.json
#
# DIR has the layout of the cluster volume (node<N>/contract_fs/seed/...), which is what scripts/deploy-dev.sh keeps and
# restores, so putting a node's keys back on a host is one rsync of DIR/node<N>/ into the volume. DIR is created
# mode 0700 and must not exist; the files in it are PLAINTEXT keys, so move them where they are going and delete
# the rest (shred -u where you have it).
#
# --verify is the dry run: DRY_RUN=1 means the same. Decryption goes through a private temporary directory that is
# shredded on exit; nothing is printed but addresses.
#
# Env:
#   AGE_IDENTITY   age: the identity file (the private key, or a plugin identity such as a YubiKey's). Required for .age bundles.
#   BACKUP_TOOL    age | gpg, when the file name does not say (.age => age, .gpg/.pgp/.asc => gpg). gpg asks for its own passphrase or token.
#   CLUSTER_SIZE   the node count you expect the bundle to cover (fails if it covers another number)
#   STAGE_ROOT, AGE_BIN, GPG_BIN   overrides
# Needs: tar, age or gpg, and node_modules in this checkout (npm ci) for the key check.
set -euo pipefail
umask 077

die() {
  echo "ERROR: $*" >&2
  exit 1
}

VERIFY=0
OUT_DIR=""
BUNDLE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --verify) VERIFY=1 ;;
    --out)
      [ $# -ge 2 ] || die "--out needs a directory"
      OUT_DIR="$2"
      shift
      ;;
    -h | --help)
      sed -n '2,22p' "$0"
      exit 0
      ;;
    -*) die "unknown option $1" ;;
    *)
      [ -z "$BUNDLE" ] || die "one bundle at a time"
      BUNDLE="$1"
      ;;
  esac
  shift
done
[ -n "$BUNDLE" ] || die "usage: keys-restore.sh [--verify] [--out DIR] BUNDLE"
[ -f "$BUNDLE" ] || die "no such file: $BUNDLE"
[ "${DRY_RUN:-0}" != 1 ] || VERIFY=1
[ "$VERIFY" = 0 ] || [ -z "$OUT_DIR" ] || die "--verify writes nothing; drop --out"

AGE_BIN="${AGE_BIN:-age}"
GPG_BIN="${GPG_BIN:-gpg}"
TOOL="${BACKUP_TOOL:-}"
if [ -z "$TOOL" ]; then
  case "$BUNDLE" in
    *.age) TOOL=age ;;
    *.gpg | *.pgp | *.asc) TOOL=gpg ;;
    *) die "cannot tell from the name which tool made $BUNDLE: set BACKUP_TOOL=age or gpg" ;;
  esac
fi
case "$TOOL" in age | gpg) ;; *) die "BACKUP_TOOL must be age or gpg" ;; esac

BUNDLE_ABS="$(cd "$(dirname "$BUNDLE")" && pwd)/$(basename "$BUNDLE")"
if [ -n "$OUT_DIR" ]; then
  case "$OUT_DIR" in /*) ;; *) OUT_DIR="$PWD/$OUT_DIR" ;; esac
  if [ -e "$OUT_DIR" ] && [ -n "$(ls -A "$OUT_DIR" 2>/dev/null)" ]; then die "$OUT_DIR exists and is not empty; refusing to write keys over anything"; fi
fi
if [ "$VERIFY" = 0 ] && [ -z "$OUT_DIR" ]; then OUT_DIR="$PWD/bridge-keys-restored-$(date -u +%Y%m%dT%H%M%SZ)"; fi
cd "$(dirname "$0")/.."

STAGE_ROOT="${STAGE_ROOT:-${TMPDIR:-/tmp}}"
STAGE="$(mktemp -d "${STAGE_ROOT%/}/bridge-restore.XXXXXX")"
chmod 700 "$STAGE"
cleanup() {
  local f
  if [ -n "${STAGE:-}" ] && [ -d "$STAGE" ]; then
    while IFS= read -r f; do
      if command -v shred >/dev/null 2>&1; then shred -u "$f" 2>/dev/null || rm -f "$f"; else rm -f "$f"; fi
    done < <(find "$STAGE" -type f)
    rm -rf "$STAGE"
  fi
}
trap cleanup EXIT

echo "opening $(basename "$BUNDLE") with $TOOL..."
if [ "$TOOL" = age ]; then
  [ -n "${AGE_IDENTITY:-}" ] || die "AGE_IDENTITY (the identity file holding the private key) is required to open an age bundle"
  command -v "$AGE_BIN" >/dev/null 2>&1 || die "age is not installed"
  "$AGE_BIN" -d -i "$AGE_IDENTITY" "$BUNDLE_ABS" | tar -xf - -C "$STAGE" || die "could not open the bundle with that identity (wrong key, or a damaged file)"
else
  command -v "$GPG_BIN" >/dev/null 2>&1 || die "gpg is not installed"
  "$GPG_BIN" --quiet --decrypt "$BUNDLE_ABS" | tar -xf - -C "$STAGE" || die "could not open the bundle with this gpg keyring (the private key is not here, or a damaged file)"
fi

# What came out must be exactly what keys-backup.sh writes: a manifest, and per node the two files. Nothing else, no links.
path_re='^node[1-9][0-9]*(/contract_fs(/seed(/bridge-(keys|payout)\.json)?)?)?$'
bad=""
while IFS= read -r p; do
  rel="${p#"$STAGE"/}"
  [ "$rel" = manifest.json ] && continue
  [[ "$rel" =~ $path_re ]] || bad="$bad $rel"
  if [ -L "$p" ]; then bad="$bad $rel(link)"; fi
done < <(find "$STAGE" -mindepth 1)
[ -z "$bad" ] || die "the bundle holds paths a backup never does:$bad. Not using it."
[ -f "$STAGE/manifest.json" ] || die "the bundle has no manifest.json: not a keys-backup.sh bundle"

# The deep check: every seed and private key derives the address on record. Prints addresses and ok/MISMATCH, never a key.
npx --no-install tsx scripts/keys-check.ts "$STAGE"

if [ -n "${CLUSTER_SIZE:-}" ]; then
  have="$(find "$STAGE" -mindepth 1 -maxdepth 1 -type d -name 'node*' | wc -l | tr -d ' ')"
  [ "$have" = "$CLUSTER_SIZE" ] || die "the bundle covers $have node(s) but CLUSTER_SIZE=$CLUSTER_SIZE. A bundle that leaves a node out cannot restore the cluster."
fi

if [ "$VERIFY" = 1 ]; then
  echo "verified: $(basename "$BUNDLE") opens with this key and every key in it matches its address. Nothing was written."
  exit 0
fi

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"
cp -R "$STAGE"/node* "$OUT_DIR"/
find "$OUT_DIR" -type f -exec chmod 600 {} +
find "$OUT_DIR" -type d -exec chmod 700 {} +
echo ""
echo "restored into $OUT_DIR (mode 0700). These are PLAINTEXT signing keys."
echo "To put a node's keys back on its host (as root there; the volume of cluster NAME is /var/lib/docker/volumes/hpdevkit_NAME_vol/_data):"
echo "  rsync -a --chmod=F600 $OUT_DIR/node<N>/ root@HOST:/var/lib/docker/volumes/hpdevkit_NAME_vol/_data/node<N>/"
echo "Then redeploy from the snapshot: the deploy keeps every node's keys. Delete $OUT_DIR when done (shred -u its files where you have shred)."
