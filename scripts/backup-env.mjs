/**
 * The environment scripts/backup/*.sh expect, built from the portal's own
 * settings, so the scripts the `backup` container runs also run on a machine
 * without Docker (scripts/backup.mjs; npm run backup, backup:verify,
 * backup:list) — and the one rule about file backups that the pre-flight
 * (check-env.mjs), setup.mjs and backup.sh all apply: brief §44 makes file
 * backups mandatory, RESTIC_REPOSITORY is where they go, and the explicit
 * BACKUP_FILES_DISABLED=1 is the only way to run without them
 * (fileBackupPolicy below).
 *
 *   DATABASE_URL       -> PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
 *                         (and PGSSLMODE from ?sslmode=)
 *   STORAGE_ROOT       -> STORAGE_DIR        default ./storage
 *   BACKUP_DIR         -> BACKUP_DIR         default ./backups
 *   BACKUP_STATUS_DIR  -> BACKUP_STATUS_DIR  default BACKUP_DIR/status
 *   PATH               gains the PostgreSQL bin directory holding pg_dump
 *
 * Relative paths resolve against the project folder, as the portal resolves
 * them, so BACKUP_STATUS_DIR=./backups/status in .env is the same directory
 * for the script that writes the status and the dashboard that reads it.
 *
 * DATABASE_URL, when set, defines the whole connection: stray PG* variables
 * in the shell are dropped, so the backup always covers the database the
 * portal itself uses. Without DATABASE_URL, PG* pass through unchanged.
 *
 * Nothing here prints anything: the result holds the database password.
 */
import { accessSync, constants, readdirSync } from 'node:fs';
import path from 'node:path';

const CONNECTION_VARS = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE'];

/**
 * Whether the uploaded files are backed up (brief §44).
 *
 *   configured    RESTIC_REPOSITORY is set: files and dumps go off the box.
 *   disabled      BACKUP_FILES_DISABLED=1 (exactly "1", as backup.sh tests
 *                 it): the operator chose database dumps only, on purpose.
 *   unconfigured  neither: the files are not backed up anywhere. `npm start`
 *                 refuses to run and every backup run fails until one of the
 *                 two is set.
 *
 * RESTIC_REPOSITORY wins when both are set.
 *
 * @param {Record<string, string | undefined>} env  usually process.env
 * @returns {'configured' | 'disabled' | 'unconfigured'}
 */
export function fileBackupPolicy(env) {
  if (env.RESTIC_REPOSITORY) return 'configured';
  if (env.BACKUP_FILES_DISABLED === '1') return 'disabled';
  return 'unconfigured';
}

/**
 * @param {Record<string, string | undefined>} env  usually process.env; not modified
 * @param {string} cwd  the project folder
 * @param {{ pgBinDir?: (env: Record<string, string | undefined>) => string | null }} [options]
 * @returns {Record<string, string>}
 */
export function backupEnv(env, cwd, { pgBinDir = findPgBinDir } = {}) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }

  if (env.DATABASE_URL) {
    for (const key of CONNECTION_VARS) delete out[key];
    Object.assign(out, connectionFromUrl(env.DATABASE_URL));
  }

  const resolve = (value, fallback) => path.resolve(cwd, value || fallback);
  out.STORAGE_DIR = resolve(env.STORAGE_ROOT || env.STORAGE_DIR, './storage');
  out.BACKUP_DIR = resolve(env.BACKUP_DIR, './backups');
  out.BACKUP_STATUS_DIR = resolve(env.BACKUP_STATUS_DIR, path.join(out.BACKUP_DIR, 'status'));
  if (env.BACKUP_DB_DIR) out.BACKUP_DB_DIR = resolve(env.BACKUP_DB_DIR);

  const bin = pgBinDir(env);
  if (bin) out.PATH = [bin, env.PATH].filter(Boolean).join(path.delimiter);

  return out;
}

/**
 * libpq's variables for a postgres:// URL. Throws on a URL that does not
 * parse, with a message that does not repeat it (it holds the password).
 *
 * @param {string} url
 * @returns {Record<string, string>}
 */
export function connectionFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DATABASE_URL is not a valid postgres:// URL.');
  }
  /** @type {Record<string, string>} */
  const out = {};
  // [::1] in a URL is ::1 to libpq.
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  if (host) out.PGHOST = host;
  out.PGPORT = parsed.port || '5432';
  if (parsed.username) out.PGUSER = decodeURIComponent(parsed.username);
  if (parsed.password) out.PGPASSWORD = decodeURIComponent(parsed.password);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (database) out.PGDATABASE = database;
  const sslmode = parsed.searchParams.get('sslmode');
  if (sslmode) out.PGSSLMODE = sslmode;
  return out;
}

/**
 * The directory to put in front of PATH so pg_dump, pg_restore, psql,
 * createdb and dropdb are found: PG_BIN if set; nothing if pg_dump is already
 * on PATH; otherwise the newest of the usual install locations — the same
 * list scripts/local-postgres.sh searches (Homebrew's postgresql@17 is
 * keg-only, so it is usually not on PATH, and never on cron's).
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
export function findPgBinDir(env) {
  if (env.PG_BIN) return env.PG_BIN;
  const exe = process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump';
  const onPath = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (onPath.some((dir) => isExecutable(path.join(dir, exe)))) return null;

  const found = pgBinCandidates(process.platform).filter((dir) => isExecutable(path.join(dir, exe)));
  // Newest last. pg_dump reads servers older than itself, never newer ones.
  found.sort((a, b) => majorOf(a) - majorOf(b));
  return found.at(-1) ?? null;
}

/** @param {NodeJS.Platform} platform */
function pgBinCandidates(platform) {
  if (platform === 'win32') {
    return expand(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PostgreSQL'), /^\d+$/, 'bin');
  }
  return [
    ...expand('/opt/homebrew/opt', /^postgresql(@\d+)?$/, 'bin'),
    ...expand('/usr/local/opt', /^postgresql(@\d+)?$/, 'bin'),
    ...expand('/Applications/Postgres.app/Contents/Versions', /./, 'bin'),
    ...expand('/usr/lib/postgresql', /^\d+$/, 'bin'),
    ...expand('/usr', /^pgsql-\d+$/, 'bin'),
    ...expand('/opt/local/lib', /^postgresql\d+$/, 'bin'),
  ];
}

/** Subdirectories of `parent` whose name matches, each joined with `leaf`. */
function expand(parent, pattern, leaf) {
  try {
    return readdirSync(parent)
      .filter((name) => pattern.test(name))
      .map((name) => path.join(parent, name, leaf));
  } catch {
    return [];
  }
}

/** The first number in a bin path (postgresql@17, Versions/16, 15/bin); 0 if none. */
function majorOf(dir) {
  const match = /(\d+)/.exec(dir.replace(/\\/g, '/').split('/').slice(-3).join('/'));
  return match ? Number(match[1]) : 0;
}

function isExecutable(file) {
  try {
    accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
