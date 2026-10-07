/**
 * One-command local setup for a fresh checkout, on macOS, Linux or Windows:
 *
 *   npm install
 *   npm run setup
 *   npm run dev
 *
 *   1. Creates .env from .env.local-dev.example when there is no .env yet.
 *   2. Makes sure PostgreSQL answers at DATABASE_URL. On macOS/Linux, when
 *      DATABASE_URL points at the project-local cluster (localhost:5433), it
 *      starts that cluster (scripts/local-postgres.sh) if it is not running.
 *      A server that is up but lacks the database gets it created.
 *   3. Applies the migrations.
 *   4. Loads the demo data — unless the database already has users, in which
 *      case it says so and leaves them alone (`npm run db:reset:demo` starts
 *      over). `--no-seed` skips this step.
 *   5. Ends with what backups need (brief §44): RESTIC_REPOSITORY and
 *      RESTIC_PASSWORD in .env, or BACKUP_FILES_DISABLED=1 on purpose —
 *      `npm start` refuses to run with neither.
 *
 * Safe to re-run. Plain JavaScript on purpose: it must work before anything
 * but `npm install` has happened, on every OS.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { fileBackupPolicy } from './backup-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = '.env';
const ENV_TEMPLATE = '.env.local-dev.example';
const LOCAL_CLUSTER_PORT = '5433';
const MIN_NODE = [22, 12];

const step = (message) => console.log(`\n> ${message}`);
const fail = (message) => {
  console.error(`\nSetup stopped: ${message}`);
  process.exit(1);
};

process.chdir(ROOT);

// ------------------------------------------------------------------ checks --
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
  fail(`Node.js ${MIN_NODE.join('.')} or newer is required; this is ${process.versions.node}. Install the current LTS from nodejs.org.`);
}

let postgres;
try {
  postgres = (await import('postgres')).default;
  import.meta.resolve('tsx');
} catch {
  fail('dependencies are missing. Run `npm install` first, then `npm run setup` again.');
}

// --------------------------------------------------------------------- .env --
step('Environment');
if (existsSync(ENV_FILE)) {
  console.log(`  ${ENV_FILE} exists — using it as it is.`);
} else {
  copyFileSync(ENV_TEMPLATE, ENV_FILE);
  console.log(`  Created ${ENV_FILE} from ${ENV_TEMPLATE}.`);
}
// Values already set in the shell win over the file, as with --env-file.
process.loadEnvFile(ENV_FILE);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) fail(`DATABASE_URL is not set. Add it to ${ENV_FILE} (see ${ENV_TEMPLATE}).`);
let parsed;
try {
  parsed = new URL(databaseUrl);
} catch {
  fail(`DATABASE_URL in ${ENV_FILE} is not a valid URL: ${databaseUrl}`);
}
const where = `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));

if (!process.env.STORAGE_ROOT) fail(`STORAGE_ROOT is not set. Add it to ${ENV_FILE}, e.g. STORAGE_ROOT=./storage`);
const storageRoot = path.resolve(process.env.STORAGE_ROOT);
// The file store is readable by the portal's own account and nobody else
// (brief §43): every byte leaves through the download handler, which checks
// who is asking and writes the access log. A folder anyone on the machine
// could open would be a second, unlogged way to the same files. `mode` only
// applies when the folder is new, so an existing one is tightened as well;
// Windows has no POSIX mode and keeps its own ACLs.
mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') chmodSync(storageRoot, 0o700);
console.log(`  Database: ${where}`);
console.log(`  Files:    ${storageRoot}`);
console.log('            (readable by this account only — see docs/runbook.md, "The file store without Docker")');

// ---------------------------------------------------------------- database --
const errorCode = (error) => error?.code ?? error?.errors?.[0]?.code;

async function probe(url) {
  const sql = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await sql`SELECT 1`;
    return null;
  } catch (error) {
    return error;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

const isLocalHost = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
const usesLocalCluster = isLocalHost && parsed.port === LOCAL_CLUSTER_PORT;

step(`PostgreSQL at ${where}`);
let error = await probe(databaseUrl);

if (error && ['ECONNREFUSED', 'ETIMEDOUT', 'CONNECT_TIMEOUT'].includes(errorCode(error)) && usesLocalCluster) {
  if (process.platform === 'win32') {
    fail(
      `nothing answers on localhost:${LOCAL_CLUSTER_PORT}. On Windows, install PostgreSQL (postgresql.org), ` +
        `then set DATABASE_URL in ${ENV_FILE} to it, e.g. postgres://postgres:YOUR_PASSWORD@localhost:5432/aktivacity`,
    );
  }
  console.log('  Not running — starting the project-local cluster (npm run db:local -- start).');
  const started = spawnSync('sh', ['scripts/local-postgres.sh', 'start'], { stdio: 'inherit' });
  if (started.status !== 0) {
    fail(`the local PostgreSQL did not start (see above). Or point DATABASE_URL in ${ENV_FILE} at a PostgreSQL you run yourself.`);
  }
  error = await probe(databaseUrl);
}

if (error && errorCode(error) === '3D000') {
  // The server is up but has no such database: create it, as its owner.
  console.log(`  Database "${databaseName}" does not exist — creating it.`);
  const admin = new URL(databaseUrl);
  admin.pathname = '/postgres';
  const sql = postgres(admin.toString(), { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await sql.unsafe(`CREATE DATABASE "${databaseName.replaceAll('"', '""')}"`);
  } catch (createError) {
    fail(
      `could not create database "${databaseName}": ${createError.message}. ` +
        `Create it yourself (psql: CREATE DATABASE ${databaseName};) and run setup again.`,
    );
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
  error = await probe(databaseUrl);
}

if (error) {
  const code = errorCode(error);
  const hint =
    code === 'ECONNREFUSED'
      ? `Nothing is listening there. Start PostgreSQL${process.platform === 'win32' ? '' : ' (npm run db:local -- start for the project-local one)'}, or fix DATABASE_URL in ${ENV_FILE}.`
      : code === '28P01' || code === '28000'
        ? `The server refused the user name or password in DATABASE_URL (${ENV_FILE}).`
        : code === 'ENOTFOUND' || code === 'EAI_AGAIN'
          ? `Unknown host. Is ${ENV_FILE} a copy of the Docker template (host "postgres")? For this machine use ${ENV_TEMPLATE}.`
          : `Check DATABASE_URL in ${ENV_FILE}.`;
  fail(`cannot connect to PostgreSQL at ${where}: ${error.message || code || error}\n  ${hint}`);
}
console.log('  Connected.');

// -------------------------------------------------------------- migrations --
const run = (args) => spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env }).status === 0;

step('Migrations');
if (!run(['--import', 'tsx', 'scripts/migrate.ts'])) fail('migrations failed (see above).');

// -------------------------------------------------------------------- seed --
step('Demo data');
if (process.argv.includes('--no-seed')) {
  console.log('  Skipped (--no-seed). `npm run db:seed:demo` loads it later, `npm run db:seed` creates just an administrator.');
} else {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM users`;
  await sql.end({ timeout: 1 });
  if (count > 0) {
    console.log(`  The database already has ${count} user(s) — leaving its data alone.`);
    console.log('  To wipe it and load the demo data again: npm run db:reset:demo');
  } else if (!existsSync('scripts/seed-demo.ts')) {
    fail('scripts/seed-demo.ts is missing, so there is no demo data to load. `npm run db:seed` creates just an administrator (ADMIN_EMAIL / ADMIN_PASSWORD in .env).');
  } else if (!run(['--conditions=react-server', '--import', 'tsx', 'scripts/seed-demo.ts'])) {
    fail('loading the demo data failed (see above).');
  }
}

const backupPolicy = fileBackupPolicy(process.env);
const backupLine =
  backupPolicy === 'configured'
    ? `configured: RESTIC_REPOSITORY=${process.env.RESTIC_REPOSITORY}`
    : backupPolicy === 'disabled'
      ? 'switched off on purpose (BACKUP_FILES_DISABLED=1): database dumps only'
      : 'NOT CONFIGURED: the uploaded files are not backed up anywhere';

console.log(`
Ready. Start the portal:

  npm run dev        development server, http://localhost:3000
  (or npm run build && npm start for the production build)

Sign-in details for the demo accounts are in README.md ("Default login").

Backups (brief §44): the database AND the uploaded files must be copied off
this machine. \`npm run backup\` does that once RESTIC_REPOSITORY and
RESTIC_PASSWORD are in ${ENV_FILE} (docs/runbook.md, "Backups without Docker").
\`npm start\` refuses to run without them unless BACKUP_FILES_DISABLED=1 is
set on purpose; \`npm run dev\` warns.
  File backups: ${backupLine}`);
