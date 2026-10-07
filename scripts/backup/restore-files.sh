#!/bin/sh
# Restore the file store from a restic snapshot.
#
#   restore-files.sh [SNAPSHOT|latest] <target-dir> [--yes]
#
# SNAPSHOT is a snapshot id from `list` (default: latest `files` snapshot of
# $RESTIC_HOST). The contents of the backed-up directory ($STORAGE_DIR at
# backup time, /storage in the container; override with RESTIC_FILES_PATH)
# land directly in <target-dir>, with ownership and permissions preserved
# when run as root.
#
# restic overwrites files that differ and leaves extra files alone. A
# non-empty target needs --yes.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/backup/lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() {
  echo "usage: $0 [SNAPSHOT|latest] <target-dir> [--yes]" >&2
  exit 2
}

yes=
p1=
p2=
for arg in "$@"; do
  case $arg in
    --yes) yes=1 ;;
    -h | --help) usage ;;
    -*) echo "unknown option: $arg" >&2; usage ;;
    *)
      if [ -z "$p1" ]; then p1=$arg
      elif [ -z "$p2" ]; then p2=$arg
      else usage
      fi
      ;;
  esac
done
if [ -n "$p2" ]; then
  snapshot=$p1
  target=$p2
else
  snapshot=latest
  target=$p1
fi
[ -n "$target" ] || usage
[ -n "$RESTIC_REPOSITORY" ] || die "RESTIC_REPOSITORY is not set"
require_restic_password

files_path=${RESTIC_FILES_PATH:-$STORAGE_DIR}

mkdir -p "$target"
if [ -n "$(ls -A "$target" 2>/dev/null)" ] && [ -z "$yes" ]; then
  cat >&2 <<EOF
$target is not empty. restic will overwrite files that differ from snapshot
$snapshot and leave other files in place. Stop the app first
(docker compose stop app), then re-run with --yes.
EOF
  exit 2
fi

acquire_lock
trap 'release_lock' EXIT
trap 'exit 130' INT TERM HUP

log "restoring $snapshot:$files_path -> $target"
if [ "$snapshot" = latest ]; then
  restic restore "latest:$files_path" --host "$RESTIC_HOST" --tag files --target "$target"
else
  restic restore "$snapshot:$files_path" --target "$target"
fi
log "file restore complete: $(find "$target" -type f | wc -l | tr -d ' ') file(s) in $target"
