# shellcheck shell=bash
# Shared helpers for the ops scripts that drive a cluster host over ssh. Source it, do not run it.
#
#   DRY_RUN=1   print every command instead of running it: no ssh, no build, no network. Reads of local
#               files (a genesis, the staging dir) still happen, because the decisions need them.
#
# Nothing here prints a key or a seed, and nothing here knows where keys live. Written for bash 3.2 (the
# Mac's) as well as the servers' bash 5.

DRY_RUN="${DRY_RUN:-0}"
case "$DRY_RUN" in
  0 | 1) ;;
  *)
    echo "ERROR: DRY_RUN must be 0 or 1, got '$DRY_RUN'" >&2
    exit 2
    ;;
esac

is_dry() { [ "$DRY_RUN" = 1 ]; }
die() {
  echo "ERROR: $*" >&2
  exit 1
}
note() { echo "==> $*"; }

# A command line as a shell would need it typed.
quote_cmd() {
  local out="" a
  for a in "$@"; do out="$out$(printf '%q' "$a") "; done
  printf '%s' "${out% }"
}

# run CMD ARGS...: runs it, or in a dry run prints it.
run() {
  if is_dry; then echo "+ $(quote_cmd "$@")"; else "$@"; fi
}

# remote_run HOST SCRIPT_FILE VAR=value ...: runs a local script file on HOST under `bash -s` with the given
# environment. The values travel through the remote shell, so they are held to a plain character set.
remote_run() {
  local host="$1" script="$2" a
  local plain='^[A-Z][A-Z0-9_]*=[A-Za-z0-9_./:,@+-]*$'
  shift 2
  for a in "$@"; do
    [[ "$a" =~ $plain ]] || die "refusing to send '$a' to the remote shell: variable names are upper case and values are plain"
  done
  if is_dry; then
    echo "+ ssh $host env $* bash -s < $script"
    sed 's/^/    | /' "$script"
  else
    ssh "$host" env "$@" bash -s < "$script"
  fi
}

# genesis_field FILE FIELD: n, k, network or why, from scripts/genesis-info.ts. Run from the package root.
genesis_field() { npx --no-install tsx scripts/genesis-info.ts "$1" "$2"; }

# resolve_size GENESIS_FILE: how many nodes this run is for. CLUSTER_SIZE wins when set, and must agree with the
# genesis: a cluster of five that the config calls three (or the other way round) is a misconfiguration, not a choice.
resolve_size() {
  local file="$1" from_genesis=""
  if [ -f "$file" ]; then from_genesis="$(genesis_field "$file" n)" || die "cannot read n from $file"; fi
  if [ -n "${CLUSTER_SIZE:-}" ]; then
    [[ "$CLUSTER_SIZE" =~ ^[1-9][0-9]*$ ]] || die "CLUSTER_SIZE must be a positive integer, got '$CLUSTER_SIZE'"
    if [ -n "$from_genesis" ] && [ "$from_genesis" != "$CLUSTER_SIZE" ]; then
      die "CLUSTER_SIZE=$CLUSTER_SIZE but $file says n=$from_genesis. Fix whichever is wrong before anything is wiped."
    fi
    echo "$CLUSTER_SIZE"
  elif [ -n "$from_genesis" ]; then
    echo "$from_genesis"
  else
    die "cannot tell how many nodes there are: ${file:-no genesis was named}${file:+ cannot be read} and CLUSTER_SIZE is not set"
  fi
}

# check_name KIND VALUE: names that end up in container names, paths and ssh commands stay plain.
check_name() {
  [[ "$2" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || die "$1 '$2' must be letters, digits, '-' and '_'"
}
