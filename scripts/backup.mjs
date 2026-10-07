/**
 * Backups without Docker (brief §44–45): the same scripts the `backup`
 * container runs, pointed at this machine through the portal's own .env
 * (scripts/backup-env.mjs).
 *
 *   npm run backup          pg_dump + retention + restic off-box copy (nightly)
 *   npm run backup:verify   restore the newest dump into a scratch database
 *                           and compare it with the live one (weekly)
 *   npm run backup:list     local dumps, restic snapshots, status files
 *
 * Automatic only once scheduled: cron or Task Scheduler (the lines are in
 * .env.local-dev.example, "backups"). Every run records its result in
 * BACKUP_STATUS_DIR, where the management dashboard and /api/health read
 * it. The exit status is the script's: 0 for ok, degraded (same-disk
 * repository) or disabled (BACKUP_FILES_DISABLED=1: database dumps only, on
 * purpose), 1 for failed — RESTIC_REPOSITORY unset without
 * BACKUP_FILES_DISABLED=1 is a failure (brief §44).
 *
 *   node --env-file-if-exists=.env scripts/backup.mjs <backup|verify-restore|list>
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { backupEnv } from './backup-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = { backup: 'backup.sh', 'verify-restore': 'verify-restore.sh', list: 'list.sh' };

const [command, ...args] = process.argv.slice(2);
if (!Object.hasOwn(SCRIPTS, command ?? '')) {
  console.error('Usage: node scripts/backup.mjs <backup|verify-restore|list>');
  console.error('  (npm run backup, npm run backup:verify, npm run backup:list)');
  process.exit(2);
}

process.chdir(ROOT);

let env;
try {
  env = backupEnv(process.env, ROOT);
} catch (error) {
  console.error(`backup: ${error.message} Check it in .env.`);
  process.exit(1);
}
if (command !== 'list' && !env.PGDATABASE) {
  // The script still runs, so the failure is recorded where the dashboard
  // looks rather than only on this terminal.
  console.error('backup: DATABASE_URL is not set (in .env or the environment), so there is no database to back up.');
}

const result = spawnSync('sh', [`scripts/backup/${SCRIPTS[command]}`, ...args], { stdio: 'inherit', env });

if (result.error) {
  if (result.error.code === 'ENOENT') {
    console.error(`backup: no \`sh\` found. The backups are POSIX shell scripts (scripts/backup/).
  macOS and Linux have sh already. On Windows, install Git for Windows and run
  this from Git Bash, or use WSL; or run the Docker deployment's backup service.`);
  } else {
    console.error(`backup: could not run sh: ${result.error.message}`);
  }
  process.exit(1);
}
process.exit(result.status ?? 1);
