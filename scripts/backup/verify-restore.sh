#!/bin/sh
# Weekly automated restore rehearsal (brief §45).
#
#   1. Take the newest dump in $DB_DIR; fail if it is older than
#      VERIFY_MAX_DUMP_AGE_HOURS (the nightly job has stopped).
#   2. Restore it into a scratch database ($VERIFY_DB, never the live one).
#   3. Compare row counts of the core tables with the live database, within
#      VERIFY_TOLERANCE_PCT percent or VERIFY_TOLERANCE_ROWS rows, whichever is
#      larger; `_migrations` must match exactly.
#   4. The off-box copy, under the same rule as backup.sh (brief §44 makes
#      file backups mandatory): with RESTIC_REPOSITORY set, confirm the newest
#      db snapshot holds this dump and run `restic check` (reading
#      RESTIC_CHECK_SUBSET of the data). With it unset the rehearsal FAILS
#      (offsite: unconfigured) — the database part above still runs and is
#      recorded — unless BACKUP_FILES_DISABLED=1 says dumps-only is on
#      purpose, which records offsite: disabled and passes.
#   5. Drop the scratch database and write $STATUS_DIR/last-verify.json.
#
# Exit status: 0 when everything passed (including with file backups switched
# off on purpose), 1 otherwise — including RESTIC_REPOSITORY unset without
# BACKUP_FILES_DISABLED=1. See docs/runbook.md, "Restore rehearsal".
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/backup/lib.sh
. "$SCRIPT_DIR/lib.sh"

STARTED_AT=$(now_iso)
STARTED_EPOCH=$(now_epoch)
CURRENT_STEP=start
FINISHED=
STATUS=failed
ERROR=
DUMP=
DUMP_AGE_HOURS=
TABLES_JSON=
RESTORE_SECONDS=
# The file part's verdict, as backup.sh records it: ok / unconfigured /
# disabled / failed / not-reached. The two below are the individual steps.
OFFSITE=not-reached
OFFSITE_HAS_DUMP=skipped
RESTIC_CHECK=skipped
SCRATCH_CREATED=

json_or_null() {
  if [ -n "$1" ]; then printf '"%s"' "$(json_str "$1")"; else printf 'null'; fi
}

num_or_null() {
  if [ -n "$1" ]; then printf '%s' "$1"; else printf 'null'; fi
}

drop_scratch() {
  dropdb --if-exists "$VERIFY_DB" >/dev/null 2>&1
}

on_exit() {
  _rc=$?
  set +e
  if [ -n "$SCRATCH_CREATED" ]; then
    drop_scratch || warn "could not drop scratch database $VERIFY_DB; drop it by hand"
  fi
  if [ -z "$FINISHED" ]; then
    STATUS=failed
    if [ -z "$ERROR" ]; then
      ERROR=${STEP_ERROR:-"unexpected exit $_rc during step: $CURRENT_STEP"}
    fi
    [ "$_rc" -eq 0 ] && _rc=1
  fi
  _json=$(cat <<EOF
{
  "kind": "verify",
  "status": "$STATUS",
  "started_at": "$STARTED_AT",
  "finished_at": "$(now_iso)",
  "duration_seconds": $(($(now_epoch) - STARTED_EPOCH)),
  "dump_file": $(json_or_null "${DUMP##*/}"),
  "dump_age_hours": $(num_or_null "$DUMP_AGE_HOURS"),
  "scratch_database": "$(json_str "$VERIFY_DB")",
  "restore_seconds": $(num_or_null "$RESTORE_SECONDS"),
  "tables": {${TABLES_JSON}
  },
  "offsite": "$OFFSITE",
  "offsite_has_dump": "$OFFSITE_HAS_DUMP",
  "restic_check": "$RESTIC_CHECK",
  "error": $(json_or_null "$ERROR")
}
EOF
)
  write_status "$STATUS_DIR/last-verify.json" "$_json"
  if [ "$STATUS" = ok ]; then
    log "restore rehearsal passed"
  else
    printf '[%s] RESTORE REHEARSAL FAILED: %s\n' "$(now_iso)" "$ERROR" >&2
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
acquire_lock
trap on_exit EXIT
trap 'exit 130' INT TERM HUP
init_workdir

CURRENT_STEP=preflight
[ -n "${PGDATABASE:-}" ] || fail "PGDATABASE is not set"
case $VERIFY_DB in
  "$PGDATABASE" | postgres | template0 | template1 | "")
    fail "VERIFY_DB=$VERIFY_DB is not a scratch database name; refusing" ;;
esac

DUMP=$(newest_dump)
[ -n "$DUMP" ] || fail "no dumps found in $DB_DIR"
log "rehearsing restore of ${DUMP##*/} into scratch database $VERIFY_DB"

max_minutes=$((VERIFY_MAX_DUMP_AGE_HOURS * 60))
if [ -n "$(find "$DUMP" -mmin +"$max_minutes" 2>/dev/null)" ]; then
  fail "newest dump ${DUMP##*/} is older than $VERIFY_MAX_DUMP_AGE_HOURS hours: nightly backups have stopped"
fi
# Hours since the dump, from the UTC timestamp in its name.
DUMP_AGE_HOURS=$(
  ts=${DUMP##*/"$DUMP_PREFIX"}
  ts=${ts%.dump}
  if d=$(date -u -d "$(printf '%s' "$ts" | sed 's/^\(....\)\(..\)\(..\)T\(..\)\(..\)\(..\)Z$/\1-\2-\3 \4:\5:\6/')" +%s 2>/dev/null) \
    || d=$(date -u -j -f '%Y%m%dT%H%M%SZ' "$ts" +%s 2>/dev/null); then
    echo $((($(now_epoch) - d) / 3600))
  fi
)

# -------------------------------------------------------------- restore --
CURRENT_STEP=restore
run_step -q "pg_restore --list" pg_restore --list "$DUMP" || fail "$STEP_ERROR"
run_step "drop old scratch db" dropdb --if-exists "$VERIFY_DB" || fail "$STEP_ERROR"
run_step "createdb" createdb --template=template0 "$VERIFY_DB" || fail "$STEP_ERROR"
SCRATCH_CREATED=1
t0=$(now_epoch)
run_step "pg_restore" pg_restore --no-owner --no-acl --exit-on-error --dbname="$VERIFY_DB" "$DUMP" \
  || fail "$STEP_ERROR"
RESTORE_SECONDS=$(($(now_epoch) - t0))
log "restored in ${RESTORE_SECONDS}s"

# --------------------------------------------------------------- counts --
CURRENT_STEP=counts
count_rows() { # db table -> count, or "missing"
  if psql -X -q -At -d "$1" -c "SELECT to_regclass('public.$2') IS NOT NULL" | grep -q '^t$'; then
    psql -X -q -At -v ON_ERROR_STOP=1 -d "$1" -c "SELECT count(*) FROM public.\"$2\""
  else
    echo missing
  fi
}

problems=
sep=
for table in $CORE_TABLES; do
  live=$(count_rows "$PGDATABASE" "$table") || fail "could not count $table in $PGDATABASE"
  restored=$(count_rows "$VERIFY_DB" "$table") || fail "could not count $table in $VERIFY_DB"
  ok=true
  if [ "$live" = missing ] || [ "$restored" = missing ]; then
    ok=false
  elif [ "$table" = _migrations ]; then
    # Unless a deploy happened since the dump, these must match exactly.
    [ "$live" -eq "$restored" ] || ok=false
  else
    diff=$((live - restored))
    [ "$diff" -lt 0 ] && diff=$((-diff))
    allowed=$((live * VERIFY_TOLERANCE_PCT / 100))
    [ "$allowed" -lt "$VERIFY_TOLERANCE_ROWS" ] && allowed=$VERIFY_TOLERANCE_ROWS
    [ "$diff" -le "$allowed" ] || ok=false
    [ "$live" -gt 0 ] && [ "$restored" -eq 0 ] && ok=false
  fi
  log "  $(printf '%-14s live %-10s restored %-10s %s' "$table" "$live" "$restored" "$ok")"
  case $live in missing) live_json='"missing"' ;; *) live_json=$live ;; esac
  case $restored in missing) restored_json='"missing"' ;; *) restored_json=$restored ;; esac
  TABLES_JSON="$TABLES_JSON$sep
    \"$table\": { \"live\": $live_json, \"restored\": $restored_json, \"ok\": $ok }"
  sep=,
  [ "$ok" = true ] || problems="$problems $table(live=$live,restored=$restored)"
done
[ -z "$problems" ] || fail "row counts out of tolerance:$problems"

CURRENT_STEP=drop-scratch
run_step "dropdb" dropdb "$VERIFY_DB" || fail "$STEP_ERROR"
SCRATCH_CREATED=

# ---------------------------------------------------------------- restic --
# The same policy as backup.sh: file backups are mandatory (brief §44), so no
# RESTIC_REPOSITORY is a failure — after the database part, whose result is
# worth recording either way — unless BACKUP_FILES_DISABLED=1 says the
# install runs on database dumps alone, on purpose.
CURRENT_STEP=offsite
if [ -z "$RESTIC_REPOSITORY" ]; then
  if [ "$BACKUP_FILES_DISABLED" = 1 ]; then
    OFFSITE=disabled
    loud_warning "BACKUP_FILES_DISABLED=1: file backups are switched off." \
      "Off-box copy not checked: the dump restores, but the uploaded files are not backed up."
  else
    OFFSITE=unconfigured
    fail "RESTIC_REPOSITORY is not set: there is no off-box copy to check, and the uploaded files are not backed up (brief §44 makes file backups mandatory). Set RESTIC_REPOSITORY and RESTIC_PASSWORD (docs/runbook.md, \"Setting up the NAS target\"), or BACKUP_FILES_DISABLED=1 to run without file backups on purpose."
  fi
else
  [ "$BACKUP_FILES_DISABLED" != 1 ] || warn "BACKUP_FILES_DISABLED=1 is ignored: RESTIC_REPOSITORY is set"
  require_restic_password
  OFFSITE=failed
  CURRENT_STEP=offsite-has-dump
  OFFSITE_HAS_DUMP=failed
  run_step -q "restic ls" restic ls --host "$RESTIC_HOST" --tag db latest || fail "$STEP_ERROR"
  if grep -q "/${DUMP##*/}\$" "$STEP_LOG"; then
    OFFSITE_HAS_DUMP=ok
    log "newest db snapshot contains ${DUMP##*/}"
  else
    fail "newest restic db snapshot does not contain ${DUMP##*/}: the off-box copy is behind"
  fi

  CURRENT_STEP=restic-check
  RESTIC_CHECK=failed
  case $RESTIC_CHECK_SUBSET in
    "" | 0 | 0%) set -- ;;
    *) set -- "--read-data-subset=$RESTIC_CHECK_SUBSET" ;;
  esac
  log "restic check $*"
  run_step "restic check" restic check "$@" || fail "$STEP_ERROR"
  RESTIC_CHECK=ok
  OFFSITE=ok
fi

CURRENT_STEP=finished
STATUS=ok
FINISHED=1
