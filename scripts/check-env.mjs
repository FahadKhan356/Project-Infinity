/**
 * Pre-flight for `npm run dev` / `npm start` (the predev / prestart hooks).
 *
 * The portal itself only reports a missing or unreachable database as a
 * generic error page once someone signs in. This says what is wrong, and the
 * command that fixes it, before the server starts:
 *
 *   - DATABASE_URL not set             -> stops (nothing can work without it)
 *   - database unreachable             -> warns (it may be starting up)
 *   - migrations pending / no accounts -> warns
 *   - STORAGE_ROOT not set             -> warns (uploads and downloads fail)
 *   - RESTIC_REPOSITORY not set        -> stops in production, warns in dev:
 *                                         file backups are mandatory (brief
 *                                         §44) unless BACKUP_FILES_DISABLED=1
 *                                         says "database dumps only" on purpose
 *
 * The backup check comes last, so everything else that is wrong is printed
 * before the stop.
 *
 * Reads the environment exactly as Next.js will (@next/env: .env, .env.local,
 * .env.development / .env.production, and real variables first).
 *
 *   node scripts/check-env.mjs [--dev]
 */
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import postgres from 'postgres';
import { fileBackupPolicy } from './backup-env.mjs';

const dev = process.argv.includes('--dev');

// Next's own loader, resolved through next so it is always the same copy.
const require = createRequire(import.meta.url);
const { loadEnvConfig } = createRequire(require.resolve('next/package.json'))('@next/env');
loadEnvConfig(process.cwd(), dev, { info: () => {}, error: console.error });

const paint = (code, text) => (process.stderr.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const warn = (message) => console.warn(`${paint(33, '!')} ${message}`);
const setupHint = 'First run on this machine? `npm run setup` creates .env, the database and the demo data.';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(`${paint(31, '✗')} DATABASE_URL is not set, so the portal cannot reach its database.
  ${setupHint}
  Otherwise set DATABASE_URL in .env (see .env.local-dev.example).`);
  process.exit(1);
}

let where = 'the database';
try {
  const u = new URL(url);
  where = `${u.hostname}:${u.port || '5432'}${u.pathname}`;
} catch {
  // postgres.js reports a malformed URL below.
}

let sql;
try {
  sql = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} });
  const [{ migrations }] = await sql`SELECT to_regclass('_migrations') IS NOT NULL AS migrations`;
  const shipped = readdirSync(path.join(process.cwd(), 'drizzle')).filter((f) => f.endsWith('.sql')).length;
  const applied = migrations ? (await sql`SELECT count(*)::int AS n FROM _migrations`)[0].n : 0;
  if (applied < shipped) {
    warn(`${where}: ${shipped - applied} of ${shipped} migration(s) not applied. Run: npm run db:migrate`);
  } else {
    const [{ users }] = await sql`SELECT count(*)::int AS users FROM users`;
    if (users === 0) {
      warn(`${where} has no user accounts yet. Run: npm run db:seed:demo (demo data) or npm run db:seed (one administrator)`);
    } else {
      console.log(`${paint(32, '✓')} Database ${where}: up to date, ${users} account(s).`);
    }
  }
} catch (error) {
  const code = error?.code ?? error?.errors?.[0]?.code;
  const detail = error?.message || code || String(error);
  const hint =
    code === 'ECONNREFUSED'
      ? 'Is PostgreSQL running? For the project-local one: npm run db:local -- start'
      : code === '3D000'
        ? 'The server is up but the database does not exist. Run: npm run setup'
        : code === '28P01' || code === '28000'
          ? 'Check the user name and password in DATABASE_URL.'
          : code === 'ENOTFOUND' || code === 'EAI_AGAIN'
            ? 'Unknown host. Is .env a copy of the Docker template (host "postgres")? For this machine use .env.local-dev.example.'
            : 'Check DATABASE_URL in .env.';
  warn(`Cannot reach ${where} (${detail}). Pages will fail until it is.\n  ${hint}`);
} finally {
  await sql?.end({ timeout: 1 }).catch(() => {});
}

if (!process.env.STORAGE_ROOT) {
  warn('STORAGE_ROOT is not set: file uploads and downloads will fail. Set it in .env, e.g. STORAGE_ROOT=./storage');
}

// Last on purpose: see the header.
const backupPolicy = fileBackupPolicy(process.env);
if (backupPolicy === 'unconfigured') {
  const message = `RESTIC_REPOSITORY is not set, so the uploaded files are not backed up anywhere (brief §44 makes file backups mandatory).
  Set RESTIC_REPOSITORY and RESTIC_PASSWORD in .env — docs/runbook.md, "Setting up the NAS target" (Docker) or "Backups without Docker".
  To run without file backups on purpose (database dumps only), set BACKUP_FILES_DISABLED=1 explicitly.`;
  if (dev) {
    warn(`${message}\n  \`npm start\` refuses to run until one of them is set; \`npm run dev\` only warns.`);
  } else {
    console.error(`${paint(31, '✗')} ${message}\n  Not starting.`);
    process.exit(1);
  }
} else if (backupPolicy === 'disabled') {
  warn('BACKUP_FILES_DISABLED=1: file backups are switched off on purpose. Database dumps only — the uploaded files are not backed up.');
}
