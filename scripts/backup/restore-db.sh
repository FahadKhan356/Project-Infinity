#!/bin/sh
# Restore a pg_dump custom-format file into a database.
#
#   restore-db.sh <dumpfile> --yes [--dbname NAME] [--recreate] [--force]
#
# <dumpfile> is a path, or a bare file name looked up in $DB_DIR.
# The target defaults to $PGDATABASE (the live portal database) and is created
# if it does not exist. Existing objects are dropped and recreated from the
# dump (pg_restore --clean --if-exists) in a single transaction: it either
# fully succeeds or leaves the database as it was. Objects that are NOT in the
# dump (say, a table a later migration added) are left in place; --recreate
# drops and recreates the whole database first so it matches the dump exactly.
#
# This script stops nothing. Stop the app first so nobody writes while the
# restore runs:  docker compose stop app   (see docs/runbook.md)
# It refuses to run while other sessions are connected, unless --force.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/backup/lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() {
  echo "usage: $0 <dumpfile> --yes [--dbname NAME] [--recreate] [--force]" >&2
  exit 2
}

dump=
target=${PGDATABASE:-}
yes=
force=
recreate=
while [ $# -gt 0 ]; do
  case $1 in
    --yes) yes=1 ;;
    --force) force=1 ;;
    --recreate) recreate=1 ;;
    --dbname) [ $# -ge 2 ] || usage; target=$2; shift ;;
    --dbname=*) target=${1#--dbname=} ;;
    -h | --help) usage ;;
    -*) echo "unknown option: $1" >&2; usage ;;
    *) [ -z "$dump" ] || usage; dump=$1 ;;
  esac
  shift
done
[ -n "$dump" ] || usage
[ -n "$target" ] || die "no target database: set PGDATABASE or pass --dbname"

if [ ! -f "$dump" ] && [ -f "$DB_DIR/$dump" ]; then dump=$DB_DIR/$dump; fi
[ -f "$dump" ] || die "dump not found: $dump"

case $target in
  postgres | template0 | template1) die "refusing to restore into $target" ;;
esac

log "checking $dump"
pg_restore --list "$dump" >/dev/null || die "$dump is not a readable custom-format dump"

if [ -z "$yes" ]; then
  cat >&2 <<EOF
This will REPLACE the contents of database "$target" on ${PGHOST:-local}:${PGPORT:-5432}
with ${dump##*/}. Anything written since that dump was taken is lost.

Stop the app first (docker compose stop app), then re-run with --yes.
EOF
  exit 2
fi

acquire_lock
trap 'release_lock' EXIT
trap 'exit 130' INT TERM HUP

quoted=$(printf '%s' "$target" | sed "s/'/''/g")
exists=$(psql -X -At -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$quoted'")
if [ "$exists" = 1 ]; then
  others=$(psql -X -At -d postgres -c \
    "SELECT count(*) FROM pg_stat_activity WHERE datname = '$quoted' AND pid <> pg_backend_pid()")
  if [ "$others" -gt 0 ] && [ -z "$force" ]; then
    die "$others other session(s) are connected to $target. Stop the app (docker compose stop app) or pass --force."
  fi
  if [ -n "$recreate" ]; then
    log "--recreate: dropping database $target"
    dropdb ${force:+--force} "$target"
    exists=
  fi
fi
if [ "$exists" != 1 ]; then
  log "creating database $target"
  createdb --template=template0 "$target"
fi

log "restoring ${dump##*/} into $target (single transaction)"
started=$(now_epoch)
pg_restore --clean --if-exists --no-owner --single-transaction --dbname="$target" "$dump"
log "restore complete in $(($(now_epoch) - started))s"

migrations=$(psql -X -At -d "$target" -c "SELECT count(*) FROM _migrations" 2>/dev/null || echo '?')
users=$(psql -X -At -d "$target" -c "SELECT count(*) FROM users" 2>/dev/null || echo '?')
log "restored database: $migrations migration(s) applied, $users user(s)"
log "next: docker compose up -d  (migrate applies any newer migrations, then app starts)"
