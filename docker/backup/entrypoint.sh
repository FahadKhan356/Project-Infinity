#!/bin/sh
# Entrypoint of the `backup` service.
#
#   cron                 (default) run backup + rehearsal on their schedules
#   backup-now           one backup, now
#   verify-now           one restore rehearsal, now
#   list                 dumps, restic snapshots, status files
#   restore-db ARGS      scripts/backup/restore-db.sh ARGS
#   restore-files ARGS   scripts/backup/restore-files.sh ARGS
#   restic ARGS          restic, with the repository and password configured
#   anything else        executed as given (e.g. `sh`)
set -eu

LIB=${BACKUP_LIB_DIR:-/usr/local/lib/aktivacity-backup}
ENV_FILE=${BACKUP_ENV_FILE:-/run/aktivacity-backup.env}
CRONTABS=${BACKUP_CRONTABS_DIR:-/etc/crontabs}

BACKUP_SCHEDULE=${BACKUP_SCHEDULE:-30 2 * * *}
VERIFY_SCHEDULE=${VERIFY_SCHEDULE:-30 4 * * 0}

cmd=${1:-cron}
[ $# -gt 0 ] && shift

case $cmd in
  cron)
    # busybox crond does not pass the container environment to jobs, so hand
    # it over in a root-only file (it holds PGPASSWORD / RESTIC_PASSWORD).
    umask 077
    export -p >"$ENV_FILE"
    # A lock left by a container that was killed mid-run.
    rm -rf "${BACKUP_STATUS_DIR:-${BACKUP_DIR:-/backups}/status}/.lock"
    mkdir -p "$CRONTABS"
    cat >"$CRONTABS/root" <<EOF
$BACKUP_SCHEDULE . $ENV_FILE; $LIB/backup.sh >/proc/1/fd/1 2>/proc/1/fd/2
$VERIFY_SCHEDULE . $ENV_FILE; $LIB/verify-restore.sh >/proc/1/fd/1 2>/proc/1/fd/2
EOF
    echo "aktivacity backup: TZ=${TZ:-UTC}"
    echo "  backup:            $BACKUP_SCHEDULE"
    echo "  restore rehearsal: $VERIFY_SCHEDULE"
    if [ -n "${RESTIC_REPOSITORY:-}" ]; then
      repo_line=$RESTIC_REPOSITORY
    elif [ "${BACKUP_FILES_DISABLED:-}" = 1 ]; then
      repo_line="DISABLED (BACKUP_FILES_DISABLED=1) - database dumps only, the uploaded files are not backed up"
    else
      repo_line="NOT CONFIGURED - every run will FAIL until RESTIC_REPOSITORY is set (or BACKUP_FILES_DISABLED=1 on purpose)"
    fi
    echo "  off-box repository: $repo_line"
    exec crond -f -d 8 -c "$CRONTABS"
    ;;
  backup-now) exec "$LIB/backup.sh" "$@" ;;
  verify-now) exec "$LIB/verify-restore.sh" "$@" ;;
  list) exec "$LIB/list.sh" "$@" ;;
  restore-db) exec "$LIB/restore-db.sh" "$@" ;;
  restore-files) exec "$LIB/restore-files.sh" "$@" ;;
  restic) exec restic "$@" ;;
  *) exec "$cmd" "$@" ;;
esac
