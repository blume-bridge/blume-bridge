#!/usr/bin/env bash
# Copies one node's consensus state off the box, on a schedule, and keeps the last N copies.
#
# The state is the record of which burns were paid and which locks were minted: losing every copy loses it, and a
# redeploy or a rebuilt cluster would pay burns twice or forget locks. The state files hold no key (the keys sit one
# level up, in bridge-keys.json, and are never read here), so the target needs no more trust than a place to keep files.
# The target should be another machine, and ideally one the node box cannot delete from.
#
#   BACKUP_TARGET=backup@vault.example:/srv/bridge-state CLUSTER=main bash state-backup.sh
#   DRY_RUN=1 BACKUP_TARGET=... CLUSTER=main bash state-backup.sh        # print what it would do, copy nothing
#
# Each run writes one generation, state-<cluster>-node<NODE_NUMBER>-<UTC time>-<xrpl cursor>/, holding the *.json files of the
# node's state directory and a MANIFEST.json (their hashes, the cursors, when). The copy is taken until two reads in a row
# agree, so a round that is writing files at that moment is not captured half done. It refuses to copy a directory that
# has a file named like a key. Old generations beyond KEEP are removed from the target (PRUNE=0 to leave that to the target).
#
# Env:
#   BACKUP_TARGET   required. user@host:/absolute/path (ssh) or an absolute local directory
#   CLUSTER         hpdevkit cluster name (default 'default'); NODE_NUMBER the node to copy from (default 1; the state is the same on all;
#                   not called NODE because npm and npx set that variable to the path of node)
#   STATE_DIR       the directory of state *.json files, instead of <volume>/node<NODE_NUMBER>/contract_fs/seed/state
#   KEEP            generations to keep per cluster and node (default 48: two days of hourly copies)
#   PRUNE           1 (default) removes old generations at the target; 0 only adds
#   BACKUP_METHOD   rsync (default when installed) or scp. Local targets use cp
#   SSH_OPTS        extra ssh options, e.g. "-i /root/.ssh/state-backup -o StrictHostKeyChecking=yes"
#   MARKER_DIR      where the last cursor is remembered, to warn when the state stops moving (default /var/lib/bridge-state-backup)
#   VOL_ROOT, STAGE_ROOT, DRY_RUN=1, BACKUP_STAMP (names the generation: a test hook)
# Needs: jq (for the manifest), tar not needed; rsync or scp for a remote target.
set -euo pipefail
umask 077

die() {
  echo "ERROR: $*" >&2
  exit 1
}

DRY_RUN="${DRY_RUN:-0}"
case "$DRY_RUN" in 0 | 1) ;; *) die "DRY_RUN must be 0 or 1" ;; esac
CLUSTER="${CLUSTER:-default}"
NODE_NUMBER="${NODE_NUMBER:-1}"
KEEP="${KEEP:-48}"
PRUNE="${PRUNE:-1}"
VOL_ROOT="${VOL_ROOT:-/var/lib/docker/volumes}"
SSH_OPTS="${SSH_OPTS:-}"
MARKER_DIR="${MARKER_DIR:-/var/lib/bridge-state-backup}"
TARGET="${BACKUP_TARGET:-}"
name_re='^[A-Za-z0-9][A-Za-z0-9_-]*$'
int_re='^[1-9][0-9]*$'
[[ "$CLUSTER" =~ $name_re ]] || die "bad CLUSTER '$CLUSTER'"
[[ "$NODE_NUMBER" =~ $int_re ]] || die "NODE_NUMBER must be a positive integer"
[[ "$KEEP" =~ $int_re ]] || die "KEEP must be a positive integer"
case "$PRUNE" in 0 | 1) ;; *) die "PRUNE must be 0 or 1" ;; esac
[ -n "$TARGET" ] || die "BACKUP_TARGET is required (user@host:/path or an absolute directory)"
command -v jq >/dev/null 2>&1 || die "jq is required"
# SSH_OPTS goes through the shell; keep it to option characters.
ssh_opts_re='^[A-Za-z0-9 =_./:@,+-]*$'
[[ "$SSH_OPTS" =~ $ssh_opts_re ]] || die "SSH_OPTS has characters that do not belong in ssh options"

# ------------------------------------------------------------------ the target

REMOTE_HOST=""
REMOTE_PATH=""
remote_re='^([A-Za-z0-9._@-]+):(/[A-Za-z0-9._/@+-]*)$'
local_re='^/[A-Za-z0-9._/@+-]*$'
if [[ "$TARGET" =~ $remote_re ]]; then
  REMOTE_HOST="${BASH_REMATCH[1]}"
  REMOTE_PATH="${BASH_REMATCH[2]%/}"
elif [[ "$TARGET" =~ $local_re ]]; then
  REMOTE_PATH="${TARGET%/}"
else
  die "BACKUP_TARGET must be user@host:/absolute/path or an absolute directory, got '$TARGET'"
fi
[ -n "$REMOTE_PATH" ] || die "BACKUP_TARGET names the root directory; give it a directory of its own"
METHOD="${BACKUP_METHOD:-}"
if [ -z "$METHOD" ]; then
  if command -v rsync >/dev/null 2>&1; then METHOD=rsync; else METHOD=scp; fi
fi
case "$METHOD" in rsync | scp) ;; *) die "BACKUP_METHOD must be rsync or scp" ;; esac
if [ -n "$REMOTE_HOST" ]; then command -v "$METHOD" >/dev/null 2>&1 || die "$METHOD is not installed"; fi

# ------------------------------------------------------------------ the source

SRC="${STATE_DIR:-$VOL_ROOT/hpdevkit_${CLUSTER}_vol/_data/node$NODE_NUMBER/contract_fs/seed/state}"
[ -d "$SRC" ] || die "no state directory at $SRC (CLUSTER=$CLUSTER NODE_NUMBER=$NODE_NUMBER; or set STATE_DIR)"
bad_names=""
for f in "$SRC"/*; do
  [ -e "$f" ] || continue
  base="${f##*/}"
  lower="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    *key* | *seed* | *secret* | *private* | *mnemonic*) bad_names="$bad_names $base" ;;
  esac
done
[ -z "$bad_names" ] || die "$SRC holds files named like keys:$bad_names. This is not the state directory (it is the one above?). Nothing was copied."
[ -f "$SRC/config.json" ] && [ -f "$SRC/cursor.json" ] || die "$SRC has no config.json and cursor.json: not a bridge state directory"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# one read of the directory: copies *.json into $1, prints a digest of names and contents
read_state() {
  local dest="$1" f digest=""
  rm -rf "$dest"
  mkdir -p "$dest"
  for f in "$SRC"/*.json; do
    [ -f "$f" ] || continue
    cp "$f" "$dest/"
  done
  for f in "$dest"/*.json; do
    [ -f "$f" ] || continue
    digest="$digest${f##*/}:$(sha256_of "$f")
"
  done
  printf '%s' "$digest"
}

stamp="${BACKUP_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
cursor="$(jq -r '.xrpl.ledger // 0' "$SRC/cursor.json" 2>/dev/null || echo 0)"
GEN="state-$CLUSTER-node$NODE_NUMBER-$stamp-$cursor"
PREFIX="state-$CLUSTER-node$NODE_NUMBER-"

ssh_run() { # run a command on the target host
  # shellcheck disable=SC2086,SC2029 # SSH_OPTS is a list of options on purpose; the command is built here on purpose
  ssh $SSH_OPTS "$REMOTE_HOST" "$1"
}

target_cmds() { # the commands, printed for a dry run
  if [ -n "$REMOTE_HOST" ]; then
    if [ "$METHOD" = rsync ]; then echo "+ rsync -a -e 'ssh $SSH_OPTS' <stage>/ $REMOTE_HOST:$REMOTE_PATH/$GEN.partial/"; else echo "+ scp -r $SSH_OPTS <stage> $REMOTE_HOST:$REMOTE_PATH/$GEN.partial"; fi
    echo "+ ssh $SSH_OPTS $REMOTE_HOST 'mv $REMOTE_PATH/$GEN.partial $REMOTE_PATH/$GEN'"
    if [ "$PRUNE" = 1 ]; then echo "+ ssh $SSH_OPTS $REMOTE_HOST 'cd $REMOTE_PATH && ls -1d ${PREFIX}* | sort -r | tail -n +$((KEEP + 1)) | remove each'"; fi
  else
    echo "+ copy <stage> to $REMOTE_PATH/$GEN.partial, then rename it to $GEN"
    if [ "$PRUNE" = 1 ]; then echo "+ remove all but the newest $KEEP of $REMOTE_PATH/${PREFIX}*"; fi
  fi
}

if [ "$DRY_RUN" = 1 ]; then
  count=0
  for f in "$SRC"/*.json; do
    if [ -f "$f" ]; then count=$((count + 1)); fi
  done
  echo "DRY_RUN=1: nothing is copied."
  echo "source: $SRC ($count state files, xrpl cursor $cursor)"
  echo "generation: $GEN"
  target_cmds
  exit 0
fi

# ------------------------------------------------------------------ copy until two reads agree

STAGE_ROOT="${STAGE_ROOT:-${TMPDIR:-/tmp}}"
STAGE="$(mktemp -d "${STAGE_ROOT%/}/state-backup.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
stable=""
previous=""
for _ in 1 2 3 4 5 6 7 8; do
  now="$(read_state "$STAGE/gen")"
  if [ -n "$previous" ] && [ "$now" = "$previous" ]; then
    stable=1
    break
  fi
  previous="$now"
  sleep 0.5
done
[ -n "$stable" ] || die "the state kept changing under the copy (8 reads); nothing was copied. Try again."
files=0
for f in "$STAGE/gen"/*.json; do
  [ -f "$f" ] || continue
  if ! jq empty "$f" 2>/dev/null; then die "${f##*/} is not valid JSON; not backing up a damaged state"; fi
  files=$((files + 1))
done
[ "$files" -gt 0 ] || die "no state files were read"
cursor="$(jq -r '.xrpl.ledger // 0' "$STAGE/gen/cursor.json")"
evm_cursor="$(jq -r '.evm.block // empty' "$STAGE/gen/cursor.json")"
GEN="state-$CLUSTER-node$NODE_NUMBER-$stamp-$cursor"
manifest_entries=""
for f in "$STAGE/gen"/*.json; do
  manifest_entries="$manifest_entries${f##*/} $(sha256_of "$f")
"
done
printf '%s' "$manifest_entries" | jq -R -s --arg created "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg cluster "$CLUSTER" --argjson node "$NODE_NUMBER" --argjson xrpl "$cursor" --arg evm "$evm_cursor" '{format:"blume-bridge-state/1", createdAt:$created, cluster:$cluster, node:$node, xrplCursor:$xrpl, evmCursor:(if $evm=="" then null else ($evm|tonumber) end), files:(split("\n")|map(select(length>0)|split(" ")|{key:.[0], value:.[1]})|from_entries)}' >"$STAGE/gen/MANIFEST.json"
size="$(du -sk "$STAGE/gen" | cut -f1)"

# ------------------------------------------------------------------ push, rename, prune

if [ -n "$REMOTE_HOST" ]; then
  # shellcheck disable=SC2086,SC2029
  ssh $SSH_OPTS "$REMOTE_HOST" "mkdir -p '$REMOTE_PATH'" || die "cannot reach $REMOTE_HOST or create $REMOTE_PATH"
  if [ "$METHOD" = rsync ]; then
    rsync -a -e "ssh $SSH_OPTS" "$STAGE/gen/" "$REMOTE_HOST:$REMOTE_PATH/$GEN.partial/" || die "rsync to $REMOTE_HOST failed"
  else
    # shellcheck disable=SC2086
    scp -r $SSH_OPTS "$STAGE/gen" "$REMOTE_HOST:$REMOTE_PATH/$GEN.partial" || die "scp to $REMOTE_HOST failed"
  fi
  ssh_run "mv '$REMOTE_PATH/$GEN.partial' '$REMOTE_PATH/$GEN'" || die "could not finish the copy at $REMOTE_HOST"
  kept="?"
  if [ "$PRUNE" = 1 ]; then
    ssh_run "cd '$REMOTE_PATH' && ls -1d ${PREFIX}[0-9]* 2>/dev/null | grep -E '^${PREFIX}[0-9]{8}T[0-9]{6}Z-[0-9]+\$' | sort -r | tail -n +$((KEEP + 1)) | while read -r old; do rm -rf -- \"\$old\"; done; find . -maxdepth 1 -name '${PREFIX}*.partial' -mtime +1 -exec rm -rf {} + 2>/dev/null; ls -1d ${PREFIX}[0-9]* 2>/dev/null | wc -l" >"$STAGE/kept" || echo "WARNING: the copy is there but pruning old generations failed" >&2
    kept="$(tr -d ' \n' <"$STAGE/kept" 2>/dev/null || echo '?')"
  fi
else
  mkdir -p "$REMOTE_PATH"
  [ ! -e "$REMOTE_PATH/$GEN" ] || die "$REMOTE_PATH/$GEN already exists (two runs in the same second?)"
  rm -rf "$REMOTE_PATH/$GEN.partial"
  cp -R "$STAGE/gen" "$REMOTE_PATH/$GEN.partial"
  mv "$REMOTE_PATH/$GEN.partial" "$REMOTE_PATH/$GEN"
  kept="?"
  if [ "$PRUNE" = 1 ]; then
    # generations of this cluster and node only, newest first; the stamp sorts as text
    gen_re="^${PREFIX}[0-9]{8}T[0-9]{6}Z-[0-9]+\$"
    names=""
    for d in "$REMOTE_PATH/$PREFIX"[0-9]*; do
      if [ -d "$d" ] && [[ "${d##*/}" =~ $gen_re ]]; then names="$names${d##*/}
"; fi
    done
    n=0
    kept=0
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      n=$((n + 1))
      if [ "$n" -gt "$KEEP" ]; then rm -rf -- "${REMOTE_PATH:?}/$name"; else kept=$((kept + 1)); fi
    done <<EOF
$(printf '%s' "$names" | sort -r)
EOF
    find "$REMOTE_PATH" -maxdepth 1 -name "${PREFIX}*.partial" -mtime +1 -exec rm -rf {} + 2>/dev/null || true
  fi
fi

# ------------------------------------------------------------------ is the state moving?

stale_note=""
if mkdir -p "$MARKER_DIR" 2>/dev/null; then
  marker="$MARKER_DIR/$CLUSTER-node$NODE_NUMBER.cursor"
  last="$(cat "$marker" 2>/dev/null || echo "")"
  unchanged="${last#*:}"
  if [ "${last%%:*}" = "$cursor" ]; then unchanged=$((${unchanged:-0} + 1)); else unchanged=0; fi
  printf '%s:%s\n' "$cursor" "$unchanged" >"$marker" 2>/dev/null || true
  if [ "$unchanged" -ge 3 ]; then stale_note="WARNING: the XRPL cursor has not moved in $unchanged copies in a row ($cursor): the cluster is stalled, or this directory is not the live state."; fi
fi

echo "state backup ok: $GEN ($files files, ${size} KB, xrpl cursor $cursor${evm_cursor:+, evm $evm_cursor}) -> ${REMOTE_HOST:+$REMOTE_HOST:}$REMOTE_PATH; $kept generation(s) there (keeping $KEEP)"
if [ -n "$stale_note" ]; then echo "$stale_note" >&2; fi
