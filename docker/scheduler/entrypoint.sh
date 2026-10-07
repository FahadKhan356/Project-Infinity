#!/bin/sh
# Entrypoint of the `scheduler` service: the portal's nightly jobs on a
# schedule, from the migrator image (the only one with tsx and scripts/),
# so a Compose deployment needs no host cron. Modelled on the backup
# service's docker/backup/entrypoint.sh.
#
#   cron                 (default) run the three jobs on their schedules
#   sweep-now [ARGS]     the retention sweep, now (e.g. --dry-run)
#   recurring-now [ARGS] the recurring projects, now
#   nightly-now [ARGS]   the nightly housekeeping, now
#   anything else        executed as given (e.g. `sh`)
#
# Each real run records itself under STORAGE_ROOT/jobs/<job>.json
# (src/lib/jobs), which the dashboard and /api/health read.
set -eu

ENV_FILE=${SCHEDULER_ENV_FILE:-/run/aktivacity-scheduler.env}
CRONTABS=${SCHEDULER_CRONTABS_DIR:-/etc/crontabs}

SWEEP_SCHEDULE=${SWEEP_SCHEDULE:-0 2 * * *}
RECURRING_SCHEDULE=${RECURRING_SCHEDULE:-15 2 * * *}
NIGHTLY_SCHEDULE=${NIGHTLY_SCHEDULE:-20 2 * * *}
FILE_RETENTION_DAYS=${FILE_RETENTION_DAYS:-30}

cmd=${1:-cron}
[ $# -gt 0 ] && shift

case $cmd in
  cron)
    # busybox crond does not pass the container environment to jobs, so hand
    # it over in a root-only file (it holds DATABASE_URL). The umask goes
    # back to 022 afterwards: the jobs inherit it, and what they write under
    # /storage/jobs is read by the app as another user.
    umask 077
    export -p >"$ENV_FILE"
    umask 022
    mkdir -p "$CRONTABS"
    # crond starts each job in /, hence the cd. Output goes to the
    # container's log like the backup's.
    cat >"$CRONTABS/root" <<CRONTAB
$SWEEP_SCHEDULE . $ENV_FILE; cd /app && npm run files:sweep -- --retention-days $FILE_RETENTION_DAYS >/proc/1/fd/1 2>/proc/1/fd/2
$RECURRING_SCHEDULE . $ENV_FILE; cd /app && npm run projects:recurring >/proc/1/fd/1 2>/proc/1/fd/2
$NIGHTLY_SCHEDULE . $ENV_FILE; cd /app && npm run jobs:nightly >/proc/1/fd/1 2>/proc/1/fd/2
CRONTAB
    echo "aktivacity scheduler: TZ=${TZ:-UTC}"
    echo "  retention sweep:      $SWEEP_SCHEDULE  (FILE_RETENTION_DAYS=$FILE_RETENTION_DAYS)"
    echo "  recurring projects:   $RECURRING_SCHEDULE"
    echo "  nightly housekeeping: $NIGHTLY_SCHEDULE"
    exec crond -f -d 8 -c "$CRONTABS"
    ;;
  # The job's own --retention-days, when given, comes first and wins.
  sweep-now) exec npm run files:sweep -- "$@" --retention-days "$FILE_RETENTION_DAYS" ;;
  recurring-now) exec npm run projects:recurring -- "$@" ;;
  nightly-now) exec npm run jobs:nightly -- "$@" ;;
  *) exec "$cmd" "$@" ;;
esac
