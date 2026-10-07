#!/bin/sh
# What can be restored: local dumps, restic snapshots, and the status files.
#
#   list.sh
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/backup/lib.sh
. "$SCRIPT_DIR/lib.sh"

echo "== Local dumps ($DB_DIR) =="
if [ -n "$(newest_dump)" ]; then
  ls -l "$DB_DIR"/"$DUMP_PREFIX"*.dump
else
  echo "(none)"
fi

echo
echo "== restic snapshots (${RESTIC_REPOSITORY:-not configured}) =="
if [ -n "$RESTIC_REPOSITORY" ]; then
  require_restic_password
  restic snapshots --host "$RESTIC_HOST"
elif [ "$BACKUP_FILES_DISABLED" = 1 ]; then
  echo "RESTIC_REPOSITORY is not set: file backups are switched off on purpose (BACKUP_FILES_DISABLED=1). Database dumps only."
else
  echo "RESTIC_REPOSITORY is not set: there is no off-box copy, and every backup run FAILS until it is set (or BACKUP_FILES_DISABLED=1 on purpose)."
fi

for f in last-run last-success last-verify; do
  echo
  echo "== $STATUS_DIR/$f.json =="
  cat "$STATUS_DIR/$f.json" 2>/dev/null || echo "(none yet)"
done
