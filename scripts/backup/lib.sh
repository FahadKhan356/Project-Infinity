# shellcheck shell=sh
# shellcheck disable=SC2034 # variables here are used by the scripts that source this
# Shared helpers for the backup scripts. Sourced, never executed.
#
# Everything is configured through the environment so the same scripts run in
# the `backup` container (/backups, /storage) and directly on a workstation for
# a drill. PG* variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE) and
# RESTIC_* variables are read natively by the postgres and restic tools.
#
# Nothing here may print a password: no `set -x`, and never echo the env.

# ------------------------------------------------------------------ config --
BACKUP_DIR=${BACKUP_DIR:-/backups}
DB_DIR=${BACKUP_DB_DIR:-$BACKUP_DIR/db}
STATUS_DIR=${BACKUP_STATUS_DIR:-$BACKUP_DIR/status}
STORAGE_DIR=${STORAGE_DIR:-/storage}

BACKUP_KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}
BACKUP_KEEP_MIN=${BACKUP_KEEP_MIN:-7}

RESTIC_REPOSITORY=${RESTIC_REPOSITORY:-}
# The explicit opt-out from the off-box file copy (brief §44): 1 = database
# dumps only, on purpose. Without it, a run with no RESTIC_REPOSITORY fails.
BACKUP_FILES_DISABLED=${BACKUP_FILES_DISABLED:-}
# A fixed host name: container host names change on every recreate, and
# `restic forget` groups snapshots by host.
RESTIC_HOST=${RESTIC_HOST:-aktivacity-portal}
RESTIC_KEEP_DAILY=${RESTIC_KEEP_DAILY:-7}
RESTIC_KEEP_WEEKLY=${RESTIC_KEEP_WEEKLY:-4}
RESTIC_KEEP_MONTHLY=${RESTIC_KEEP_MONTHLY:-12}
RESTIC_CHECK_SUBSET=${RESTIC_CHECK_SUBSET:-2%}
RESTIC_CACHE_DIR=${RESTIC_CACHE_DIR:-$BACKUP_DIR/.restic-cache}
export RESTIC_CACHE_DIR

VERIFY_DB=${VERIFY_DB:-aktivacity_restore_check}
VERIFY_TOLERANCE_PCT=${VERIFY_TOLERANCE_PCT:-10}
VERIFY_TOLERANCE_ROWS=${VERIFY_TOLERANCE_ROWS:-100}
VERIFY_MAX_DUMP_AGE_HOURS=${VERIFY_MAX_DUMP_AGE_HOURS:-48}

DUMP_PREFIX=aktivacity-
CORE_TABLES="users clients projects deliverables files activity_log _migrations"

# ----------------------------------------------------------------- logging --
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
now_epoch() { date -u +%s; }

log() { printf '[%s] %s\n' "$(now_iso)" "$*"; }
warn() { printf '[%s] WARNING: %s\n' "$(now_iso)" "$*" >&2; }
die() { ERROR="$*"; printf '[%s] ERROR: %s\n' "$(now_iso)" "$*" >&2; exit 1; }

loud_warning() {
  {
    echo '#####################################################################'
    printf '# WARNING: %s\n' "$@"
    echo '#####################################################################'
  } >&2
}

# ------------------------------------------------------------------- JSON --
# Escape a string for a JSON value: backslash, quote, tab, newline; other
# control characters are dropped.
json_str() {
  printf '%s' "$1" \
    | tr -d '\000-\010\013\014\016-\037' \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/	/\\t/g' -e 's/\r$//' \
    | awk 'NR > 1 { printf "\\n" } { printf "%s", $0 }'
}

# Write $2 to $1 atomically and world-readable: the app reads it as another user.
write_status() {
  _target=$1
  mkdir -p "$(dirname "$_target")"
  chmod 755 "$(dirname "$_target")" 2>/dev/null || true
  printf '%s\n' "$2" >"$_target.tmp"
  chmod 644 "$_target.tmp"
  mv -f "$_target.tmp" "$_target"
}

# --------------------------------------------------------------- utilities --
file_size() { wc -c <"$1" | tr -d ' '; }

# Device number of a path (busybox/GNU stat, then BSD stat).
device_of() { stat -c %d "$1" 2>/dev/null || stat -f %d "$1" 2>/dev/null || echo unknown; }

# Newest verified dump, or nothing.
newest_dump() {
  # Timestamps are in the file names, so name order is age order.
  # shellcheck disable=SC2012
  ls -1 "$DB_DIR"/"$DUMP_PREFIX"*.dump 2>/dev/null | sort | tail -n 1
}

# Is the restic repository a local path (as opposed to sftp:, rest:, s3: ...)?
repo_local_path() {
  case $RESTIC_REPOSITORY in
    local:*) printf '%s' "${RESTIC_REPOSITORY#local:}" ;;
    /*) printf '%s' "$RESTIC_REPOSITORY" ;;
    *) return 1 ;;
  esac
}

require_restic_password() {
  if [ -z "${RESTIC_PASSWORD:-}" ] && [ -z "${RESTIC_PASSWORD_FILE:-}" ] \
    && [ -z "${RESTIC_PASSWORD_COMMAND:-}" ]; then
    die "RESTIC_REPOSITORY is set but none of RESTIC_PASSWORD, RESTIC_PASSWORD_FILE, RESTIC_PASSWORD_COMMAND is"
  fi
  if [ -n "${RESTIC_PASSWORD_FILE:-}" ] && [ ! -r "$RESTIC_PASSWORD_FILE" ]; then
    die "RESTIC_PASSWORD_FILE ($RESTIC_PASSWORD_FILE) is not readable"
  fi
}

# ------------------------------------------------------------------- lock --
# One backup/verify/restore at a time. mkdir is atomic everywhere; flock is
# not on macOS. The lock records host + pid so a `docker compose run` in a
# second container does not break a lock held by the cron container.
LOCK_DIR=$STATUS_DIR/.lock
LOCK_HELD=

pid_alive() {
  [ -d "/proc/$1" ] || kill -0 "$1" 2>/dev/null || ps -p "$1" >/dev/null 2>&1
}

acquire_lock() {
  mkdir -p "$STATUS_DIR"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    _owner=$(cat "$LOCK_DIR/owner" 2>/dev/null || echo unknown)
    _host=${_owner%% *}
    _pid=${_owner##* }
    _me=$(hostname 2>/dev/null || echo unknown)
    _stale=
    if [ "$_host" = "$_me" ] && ! pid_alive "$_pid"; then
      _stale=1
    elif [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +720 2>/dev/null)" ]; then
      _stale=1 # older than 12 hours: nothing legitimate runs that long
    fi
    if [ -n "$_stale" ]; then
      warn "removing stale lock held by $_owner"
      rm -rf "$LOCK_DIR"
      mkdir "$LOCK_DIR" || die "could not take lock $LOCK_DIR"
    else
      die "another backup job is running ($_owner); lock: $LOCK_DIR"
    fi
  fi
  printf '%s %s\n' "$(hostname 2>/dev/null || echo unknown)" "$$" >"$LOCK_DIR/owner"
  LOCK_HELD=1
}

release_lock() {
  if [ -n "$LOCK_HELD" ]; then
    rm -rf "$LOCK_DIR"
    LOCK_HELD=
  fi
}

# ----------------------------------------------------------------- running --
# Per-run scratch directory, removed by cleanup_workdir.
WORK_DIR=
init_workdir() { WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/aktivacity-backup.XXXXXX"); }
cleanup_workdir() {
  if [ -n "$WORK_DIR" ]; then rm -rf "$WORK_DIR"; fi
  WORK_DIR=
}

# run_step [-q] NAME CMD... — run an external command with its output captured
# in $STEP_LOG (left in place for the caller to parse), print that output
# indented (with -q: only on failure), and on failure set STEP_ERROR and return
# non-zero. Pass external commands only: `set -e` does not apply inside a
# function whose status is being tested.
STEP_ERROR=
STEP_LOG=
run_step() {
  _quiet=
  if [ "$1" = -q ]; then
    _quiet=1
    shift
  fi
  _name=$1
  shift
  STEP_LOG=$WORK_DIR/step.log
  _rc=0
  "$@" >"$STEP_LOG" 2>&1 || _rc=$?
  if [ -z "$_quiet" ] || [ "$_rc" -ne 0 ]; then
    sed 's/^/    /' "$STEP_LOG"
  fi
  if [ "$_rc" -ne 0 ]; then
    STEP_ERROR="$_name failed (exit $_rc): $(tail -n 15 "$STEP_LOG")"
    return "$_rc"
  fi
  return 0
}
