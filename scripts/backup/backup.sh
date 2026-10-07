#!/bin/sh
# Nightly backup (brief §44).
#
#   1. pg_dump --format=custom of the portal database into $DB_DIR, written
#      under a temporary name, checked with `pg_restore --list`, then renamed.
#   2. Local dump retention: older than BACKUP_KEEP_DAYS days, but never fewer
#      than the BACKUP_KEEP_MIN newest.
#   3. restic snapshots of the file store and of $DB_DIR to RESTIC_REPOSITORY
#      (initialised on first use), then `restic forget --prune`.
#   4. $STATUS_DIR/last-run.json always, with status ok / degraded / disabled
#      / failed; last-success.json only when every step, including the
#      off-box copy, succeeded.
#
# File backups are mandatory (brief §44). With RESTIC_REPOSITORY unset the
# dump is still made and kept, but the run FAILS (offsite: unconfigured) so
# nobody mistakes a dumps-only install for a backed-up one — unless
# BACKUP_FILES_DISABLED=1 says that is on purpose, which records "disabled".
# "degraded" is a local-path repository on the same filesystem as the dumps.
#
# Exit status: 0 on ok, degraded or disabled; 1 on failure — including
# RESTIC_REPOSITORY unset without BACKUP_FILES_DISABLED=1. See
# docs/runbook.md, "Backup".
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/backup/lib.sh
. "$SCRIPT_DIR/lib.sh"

umask 077 # dumps hold password hashes and client data

STARTED_AT=$(now_iso)
STARTED_EPOCH=$(now_epoch)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
CURRENT_STEP=start
FINISHED=
STATUS=failed
ERROR=
WARNINGS=
DUMP_FILE=
DUMP_BYTES=
DUMP_TABLES=
PARTIAL=
OFFSITE=not-reached
SNAP_FILES=skipped
SNAP_DB=skipped

add_warning() {
  WARNINGS="${WARNINGS}${WARNINGS:+
}$1"
}

json_or_null() {
  if [ -n "$1" ]; then printf '"%s"' "$(json_str "$1")"; else printf 'null'; fi
}

num_or_null() {
  if [ -n "$1" ]; then printf '%s' "$1"; else printf 'null'; fi
}

redacted_repo() {
  # rest:https://user:pass@host/ must not land in a world-readable file.
  printf '%s' "$RESTIC_REPOSITORY" | sed 's#//[^/@]*@#//***@#'
}

status_json() {
  _warnings=$(printf '%s\n' "$WARNINGS" | awk -v ORS='' '
    BEGIN { first = 1 }
    length($0) > 0 {
      gsub(/\\/, "\\\\"); gsub(/"/, "\\\"");
      if (!first) printf ", "; printf "\"%s\"", $0; first = 0
    }')
  _finished=$(now_iso)
  _duration=$(($(now_epoch) - STARTED_EPOCH))
  cat <<EOF
{
  "kind": "backup",
  "status": "$STATUS",
  "started_at": "$STARTED_AT",
  "finished_at": "$_finished",
  "duration_seconds": $_duration,
  "database": $(json_or_null "${PGDATABASE:-}"),
  "dump_file": $(json_or_null "$DUMP_FILE"),
  "dump_bytes": $(num_or_null "$DUMP_BYTES"),
  "dump_tables_with_data": $(num_or_null "$DUMP_TABLES"),
  "offsite": "$OFFSITE",
  "restic_repository": $(json_or_null "$(redacted_repo)"),
  "restic_snapshot_files": "$SNAP_FILES",
  "restic_snapshot_db": "$SNAP_DB",
  "warnings": [$_warnings],
  "error": $(json_or_null "$ERROR")
}
EOF
}

on_exit() {
  _rc=$?
  set +e
  if [ -z "$FINISHED" ]; then
    STATUS=failed
    if [ -z "$ERROR" ]; then
      ERROR=${STEP_ERROR:-"unexpected exit $_rc during step: $CURRENT_STEP"}
    fi
    [ "$_rc" -eq 0 ] && _rc=1
  fi
  if [ -n "$PARTIAL" ] && [ -f "$PARTIAL" ]; then rm -f "$PARTIAL"; fi
  _json=$(status_json)
  write_status "$STATUS_DIR/last-run.json" "$_json"
  if [ "$STATUS" = ok ]; then
    write_status "$STATUS_DIR/last-success.json" "$_json"
  fi
  if [ "$STATUS" = failed ]; then
    printf '[%s] BACKUP FAILED: %s\n' "$(now_iso)" "$ERROR" >&2
  else
    log "backup finished: $STATUS"
  fi
  cleanup_workdir
  release_lock
  exit "$_rc"
}

fail() {
  ERROR=$1
  exit 1
}

# ------------------------------------------------------------------ start --
mkdir -p "$DB_DIR" "$STATUS_DIR"
acquire_lock
trap on_exit EXIT
trap 'exit 130' INT TERM HUP
init_workdir

log "backup started: database=${PGDATABASE:-?} host=${PGHOST:-local} storage=$STORAGE_DIR"

# ------------------------------------------------------------------- dump --
CURRENT_STEP=pg_dump
[ -n "${PGDATABASE:-}" ] || fail "PGDATABASE is not set"
DUMP_NAME="$DUMP_PREFIX$STAMP.dump"
PARTIAL="$DB_DIR/.$DUMP_NAME.partial"
log "dumping $PGDATABASE -> $DB_DIR/$DUMP_NAME"
run_step pg_dump pg_dump --format=custom --file="$PARTIAL" "$PGDATABASE" || fail "$STEP_ERROR"

CURRENT_STEP=verify-dump
run_step -q "pg_restore --list" pg_restore --list "$PARTIAL" || fail "$STEP_ERROR"
DUMP_TABLES=$(grep -c ' TABLE DATA ' "$STEP_LOG" || true)
if [ "$DUMP_TABLES" -eq 0 ]; then
  fail "dump contains no table data; refusing to count it as a backup"
fi
mv -f "$PARTIAL" "$DB_DIR/$DUMP_NAME"
PARTIAL=
DUMP_FILE=$DUMP_NAME
DUMP_BYTES=$(file_size "$DB_DIR/$DUMP_NAME")
log "dump ok: $DUMP_BYTES bytes, $DUMP_TABLES tables with data"

# -------------------------------------------------------- local retention --
CURRENT_STEP=local-retention
# shellcheck disable=SC2012
ls -1 "$DB_DIR"/"$DUMP_PREFIX"*.dump 2>/dev/null | sort -r | awk -v keep="$BACKUP_KEEP_MIN" 'NR > keep' \
  >"$WORK_DIR/candidates"
removed=0
while IFS= read -r old; do
  [ -n "$old" ] || continue
  if [ -n "$(find "$old" -mtime +"$BACKUP_KEEP_DAYS" 2>/dev/null)" ]; then
    rm -f "$old"
    removed=$((removed + 1))
  fi
done <"$WORK_DIR/candidates"
log "local retention: removed $removed dump(s) older than $BACKUP_KEEP_DAYS days (keeping at least $BACKUP_KEEP_MIN)"

# ---------------------------------------------------------------- offsite --
CURRENT_STEP=offsite
if [ -z "$RESTIC_REPOSITORY" ]; then
  if [ "$BACKUP_FILES_DISABLED" = 1 ]; then
    OFFSITE=disabled
    STATUS=disabled
    add_warning "BACKUP_FILES_DISABLED=1: file backups are switched off. Database dump only; the uploaded files are not backed up."
    loud_warning "BACKUP_FILES_DISABLED=1: file backups are switched off." \
      "Database dump only; the uploaded files are not backed up, and the dump is on the same disk as the database."
  else
    OFFSITE=unconfigured
    fail "RESTIC_REPOSITORY is not set: the uploaded files were not backed up (brief §44 makes file backups mandatory). Set RESTIC_REPOSITORY and RESTIC_PASSWORD (docs/runbook.md, \"Setting up the NAS target\"), or BACKUP_FILES_DISABLED=1 to run without file backups on purpose."
  fi
else
  [ "$BACKUP_FILES_DISABLED" != 1 ] || warn "BACKUP_FILES_DISABLED=1 is ignored: RESTIC_REPOSITORY is set"
  require_restic_password
  OFFSITE=failed
  if [ ! -d "$STORAGE_DIR" ]; then
    fail "file store $STORAGE_DIR does not exist; refusing to snapshot nothing"
  fi

  SAME_DISK=
  if repo_path=$(repo_local_path); then
    mkdir -p "$repo_path"
    if [ "$(device_of "$repo_path")" = "$(device_of "$BACKUP_DIR")" ] \
      && [ "${BACKUP_ALLOW_SAME_DISK:-}" != 1 ]; then
      SAME_DISK=1
      STATUS=degraded
      add_warning "restic repository $repo_path is on the same filesystem as $BACKUP_DIR. Mount the NAS / second disk there."
      loud_warning "restic repository $repo_path is on the SAME filesystem as $BACKUP_DIR." \
        "Mount the NAS or second disk there (BACKUP_REPO_HOST_DIR); this copy does not survive a disk failure."
    fi
  fi

  CURRENT_STEP=restic-open
  rc=0
  restic cat config >"$WORK_DIR/cat-config" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then
    if [ "$rc" -eq 10 ] || grep -qi 'does not exist\|unable to open config file' "$WORK_DIR/cat-config"; then
      if [ -n "$SAME_DISK" ]; then
        # Most likely the NAS is not mounted and this is the empty mount point.
        fail "no restic repository at $repo_path, and it is on the same disk as $BACKUP_DIR. Is the NAS / second disk mounted? Refusing to create a repository on the local disk."
      fi
      log "restic repository not initialised yet; running restic init"
      run_step "restic init" restic init || fail "$STEP_ERROR"
    else
      fail "cannot open restic repository (exit $rc): $(tail -n 5 "$WORK_DIR/cat-config")"
    fi
  fi

  snapshot_id() {
    grep '"message_type":"summary"' "$STEP_LOG" | sed -n 's/.*"snapshot_id":"\([0-9a-f]*\)".*/\1/p' | tail -n 1
  }

  CURRENT_STEP=restic-files
  log "restic: file store $STORAGE_DIR"
  run_step -q "restic backup (files)" restic backup --json --host "$RESTIC_HOST" --tag files \
    "$STORAGE_DIR" || fail "$STEP_ERROR"
  SNAP_FILES=$(snapshot_id)
  [ -n "$SNAP_FILES" ] || fail "restic backup (files) printed no snapshot id"
  log "  snapshot $SNAP_FILES"

  CURRENT_STEP=restic-db
  log "restic: dumps $DB_DIR"
  run_step -q "restic backup (db)" restic backup --json --host "$RESTIC_HOST" --tag db \
    --exclude '*.partial' "$DB_DIR" || fail "$STEP_ERROR"
  SNAP_DB=$(snapshot_id)
  [ -n "$SNAP_DB" ] || fail "restic backup (db) printed no snapshot id"
  log "  snapshot $SNAP_DB"

  CURRENT_STEP=restic-forget
  log "restic: forget --prune (daily $RESTIC_KEEP_DAILY, weekly $RESTIC_KEEP_WEEKLY, monthly $RESTIC_KEEP_MONTHLY)"
  run_step -q "restic forget" restic forget --host "$RESTIC_HOST" --group-by host,tags \
    --keep-daily "$RESTIC_KEEP_DAILY" --keep-weekly "$RESTIC_KEEP_WEEKLY" \
    --keep-monthly "$RESTIC_KEEP_MONTHLY" --prune || fail "$STEP_ERROR"
  OFFSITE=ok
fi

CURRENT_STEP=finished
case $STATUS in degraded | disabled) ;; *) STATUS=ok ;; esac
FINISHED=1
