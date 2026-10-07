#!/bin/sh
# Project-local PostgreSQL for running the portal without Docker (macOS/Linux).
#
#   npm run db:local -- start    create the cluster on first use, then start it
#   npm run db:local -- init     create the cluster, role and database (and start it)
#   npm run db:local -- stop     stop it
#   npm run db:local -- status   running or not, port, data directory
#   npm run db:local -- psql     open psql on the portal's database (extra args pass through)
#
# The cluster lives in ./.data/postgres (git-ignored) and belongs to you, not
# to a system service: it runs only while you want it to. It listens on
# localhost only, TCP port 5433 by default (PGPORT=... to choose another at
# init or start). Role "aktivacity" (password "aktivacity", superuser: fine on
# a developer machine, and the migrations create extensions) owns database
# "aktivacity", matching DATABASE_URL in .env.local-dev.example.
#
# Uses initdb/pg_ctl from PATH, or from the usual Homebrew/apt/Postgres.app
# locations; PG_BIN=/path/to/bin overrides. Windows: install PostgreSQL and
# point DATABASE_URL in .env at it instead.
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
DATA_PARENT="$ROOT/.data"
DATA_DIR="$DATA_PARENT/postgres"
LOG_FILE="$DATA_PARENT/postgres.log"
DB_USER=aktivacity
DB_PASSWORD=aktivacity
DB_NAME=aktivacity
DEFAULT_PORT=5433
MIN_MAJOR=14

say() { printf '%s\n' "$*"; }
die() { printf 'local-postgres: %s\n' "$*" >&2; exit 1; }

install_hint() {
  cat >&2 <<'EOF'
local-postgres: PostgreSQL's server programs (initdb, pg_ctl) were not found.

Install PostgreSQL 14 or newer (17 recommended), then run this again:
  macOS (Homebrew):  brew install postgresql@17
  Debian/Ubuntu:     sudo apt install postgresql
  Fedora/RHEL:       sudo dnf install postgresql-server postgresql-contrib
There is no need to start the system-wide service: this script runs its own
cluster in ./.data/postgres.

Installed somewhere unusual? Point PG_BIN at its bin directory:
  PG_BIN=/path/to/postgresql/bin npm run db:local -- start
On Windows, install PostgreSQL from postgresql.org and set DATABASE_URL in
.env to that server instead of using this script.
EOF
  exit 1
}

major_of() { # $1 = bin dir; prints the major version of its pg_ctl
  "$1/pg_ctl" --version 2>/dev/null | sed -n 's/.*(PostgreSQL) \([0-9][0-9]*\).*/\1/p'
}

candidates() { # bin directories holding pg_ctl, PATH first, then newest-last globs
  if command -v pg_ctl >/dev/null 2>&1; then
    dirname -- "$(command -v pg_ctl)"
  fi
  for d in \
    /opt/homebrew/opt/postgresql@*/bin /opt/homebrew/opt/postgresql/bin \
    /usr/local/opt/postgresql@*/bin /usr/local/opt/postgresql/bin \
    /Applications/Postgres.app/Contents/Versions/*/bin \
    /usr/lib/postgresql/*/bin /usr/pgsql-*/bin /opt/local/lib/postgresql*/bin; do
    if [ -x "$d/pg_ctl" ] && [ -x "$d/initdb" ]; then say "$d"; fi
  done
}

# Sets BIN. $1 = required major version (an existing cluster's), or empty.
resolve_bin() {
  want=$1
  if [ -n "${PG_BIN:-}" ]; then
    [ -x "$PG_BIN/pg_ctl" ] || die "PG_BIN=$PG_BIN has no pg_ctl in it."
    BIN=$PG_BIN
  else
    BIN=
    list=$(candidates)
    [ -n "$list" ] || install_hint
    if [ -n "$want" ]; then
      BIN=$(printf '%s\n' "$list" | while IFS= read -r d; do
        if [ "$(major_of "$d")" = "$want" ]; then say "$d"; break; fi
      done)
      [ -n "$BIN" ] || die "the cluster in $DATA_DIR was created by PostgreSQL $want, but no PostgreSQL $want was found (brew install postgresql@$want, or set PG_BIN). Or delete $DATA_PARENT to start over — that erases the local database."
    elif command -v pg_ctl >/dev/null 2>&1 && command -v initdb >/dev/null 2>&1; then
      BIN=$(dirname -- "$(command -v pg_ctl)")
    else
      BIN=$(printf '%s\n' "$list" | tail -n 1)
    fi
  fi
  for tool in initdb pg_ctl psql createdb; do
    [ -x "$BIN/$tool" ] || die "$BIN/$tool is missing — is the PostgreSQL client package installed too?"
  done
  major=$(major_of "$BIN")
  if [ -n "$major" ] && [ "$major" -lt "$MIN_MAJOR" ]; then
    say "local-postgres: warning: PostgreSQL $major is older than $MIN_MAJOR; the portal is tested on 17." >&2
  fi
}

initialised() { [ -f "$DATA_DIR/PG_VERSION" ]; }

running() { "$BIN/pg_ctl" -D "$DATA_DIR" status >/dev/null 2>&1; }

# The port the running server listens on (line 4 of postmaster.pid), else the
# configured one.
current_port() {
  if [ -f "$DATA_DIR/postmaster.pid" ]; then
    p=$(sed -n 4p "$DATA_DIR/postmaster.pid")
    if [ -n "$p" ]; then say "$p"; return; fi
  fi
  p=$(sed -n "s/^port = \([0-9][0-9]*\).*/\1/p" "$DATA_DIR/postgresql.conf" 2>/dev/null | tail -n 1)
  say "${p:-$DEFAULT_PORT}"
}

url_for() { say "postgres://$DB_USER:$DB_PASSWORD@localhost:$1/$DB_NAME"; }

ensure_database() {
  port=$(current_port)
  exists=$(PGPASSWORD=$DB_PASSWORD "$BIN/psql" -X -q -t -A -h localhost -p "$port" -U "$DB_USER" -d postgres \
    -c "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'") || die "could not connect to the local server on port $port (see $LOG_FILE)."
  if [ "$exists" != "1" ]; then
    PGPASSWORD=$DB_PASSWORD "$BIN/createdb" -h localhost -p "$port" -U "$DB_USER" -O "$DB_USER" "$DB_NAME"
    say "Created database $DB_NAME."
  fi
}

start_server() {
  # The configured port applies unless PGPORT asks for another one this time.
  if [ -n "${PGPORT:-}" ]; then
    set -- -o "-p $PGPORT"
  else
    set --
  fi
  if ! "$BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" -w -t 60 "$@" start >/dev/null; then
    say "local-postgres: PostgreSQL did not start. Last lines of $LOG_FILE:" >&2
    tail -n 15 "$LOG_FILE" >&2 || true
    say "(Port already taken? Choose another: PGPORT=5434 npm run db:local -- start, and use it in DATABASE_URL.)" >&2
    exit 1
  fi
}

cmd_init() {
  if initialised; then
    say "Local PostgreSQL cluster already exists in $DATA_DIR."
    cmd_start
    return
  fi
  if [ "$(id -u)" = "0" ]; then
    die "PostgreSQL refuses to run as root. Run this as your normal user."
  fi
  if [ -d "$DATA_DIR" ] && [ -n "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then
    die "$DATA_DIR exists but is not a PostgreSQL cluster. Move it away and try again."
  fi
  resolve_bin ""
  port=${PGPORT:-$DEFAULT_PORT}
  mkdir -p "$DATA_DIR"
  chmod 700 "$DATA_DIR"
  pwfile=$(mktemp "${TMPDIR:-/tmp}/aktivacity-pg.XXXXXX")
  trap 'rm -f "$pwfile"' EXIT
  trap 'rm -f "$pwfile"; exit 130' INT TERM
  say "$DB_PASSWORD" > "$pwfile"
  say "Creating a PostgreSQL $(major_of "$BIN") cluster in $DATA_DIR ..."
  # C locale and UTF-8, as in the Docker deployment: identical sorting everywhere.
  if ! "$BIN/initdb" -D "$DATA_DIR" -U "$DB_USER" --pwfile="$pwfile" --auth=scram-sha-256 \
      --encoding=UTF8 --locale=C >"$LOG_FILE" 2>&1; then
    tail -n 20 "$LOG_FILE" >&2 || true
    rm -rf "$DATA_DIR"
    die "initdb failed (full output in $LOG_FILE)."
  fi
  rm -f "$pwfile"
  trap - EXIT INT TERM
  # TCP on localhost only: nothing on the network can reach it, and no Unix
  # socket directory is needed (apt builds default to /var/run/postgresql,
  # which a normal user cannot write).
  cat >>"$DATA_DIR/postgresql.conf" <<EOF

# --- added by scripts/local-postgres.sh ---
listen_addresses = 'localhost'
port = $port
unix_socket_directories = ''
EOF
  start_server
  ensure_database
  say "Local PostgreSQL is running on localhost:$(current_port)."
  say "DATABASE_URL=$(url_for "$(current_port)")"
}

cmd_start() {
  if ! initialised; then
    cmd_init
    return
  fi
  resolve_bin "$(cat "$DATA_DIR/PG_VERSION")"
  if running; then
    say "Local PostgreSQL is already running on localhost:$(current_port)."
  else
    start_server
    say "Local PostgreSQL started on localhost:$(current_port)."
  fi
  ensure_database
  say "DATABASE_URL=$(url_for "$(current_port)")"
}

cmd_stop() {
  if ! initialised; then say "No local cluster in $DATA_DIR — nothing to stop."; return; fi
  resolve_bin "$(cat "$DATA_DIR/PG_VERSION")"
  if running; then
    "$BIN/pg_ctl" -D "$DATA_DIR" -m fast -w stop >/dev/null
    say "Local PostgreSQL stopped."
  else
    say "Local PostgreSQL is not running."
  fi
}

cmd_status() {
  if ! initialised; then
    say "No local cluster yet. Create and start one with: npm run db:local -- start"
    return
  fi
  resolve_bin "$(cat "$DATA_DIR/PG_VERSION")"
  if running; then
    say "Running: PostgreSQL $(cat "$DATA_DIR/PG_VERSION") on localhost:$(current_port), data in $DATA_DIR"
    say "DATABASE_URL=$(url_for "$(current_port)")"
  else
    say "Stopped: PostgreSQL $(cat "$DATA_DIR/PG_VERSION"), data in $DATA_DIR. Start it with: npm run db:local -- start"
  fi
}

cmd_psql() {
  initialised || die "no local cluster yet. Run: npm run db:local -- start"
  resolve_bin "$(cat "$DATA_DIR/PG_VERSION")"
  running || die "the local server is not running. Run: npm run db:local -- start"
  PGPASSWORD=$DB_PASSWORD exec "$BIN/psql" -h localhost -p "$(current_port)" -U "$DB_USER" -d "$DB_NAME" "$@"
}

command=${1:-}
[ $# -gt 0 ] && shift
case "$command" in
  init) cmd_init ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  psql) cmd_psql "$@" ;;
  *)
    say "Usage: npm run db:local -- <start|init|stop|status|psql>"
    say "  start   create the local cluster on first use, then start it (safe to repeat)"
    say "  init    create the cluster, role and database, and start it"
    say "  stop    stop the local server"
    say "  status  show whether it is running, and its DATABASE_URL"
    say "  psql    open psql on the portal database"
    [ -z "$command" ] || exit 1
    ;;
esac
