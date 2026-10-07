/**
 * Retention sweep.
 *
 * Soft-deleted files keep their bytes so an accidental delete is recoverable.
 * This removes the bytes once the retention window has passed, and clears
 * abandoned upload sessions. In Docker the `scheduler` service runs it
 * nightly before the backup; without Docker, schedule it yourself
 * (docs/runbook.md, "Scheduled jobs").
 *
 *   tsx scripts/sweep-files.ts [--retention-days 30] [--dry-run]
 *
 * A real run records its result under STORAGE_ROOT/jobs/sweep.json for the
 * dashboard and /api/health (src/lib/jobs); a dry run records nothing.
 * Runs without the react-server condition, so src/lib/jobs/runs is the only
 * portal module it may import.
 */
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { runJob } from '../src/lib/jobs/runs';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const root = process.env.STORAGE_ROOT;
  if (!root) throw new Error('STORAGE_ROOT is not set');
  const storageRoot = path.resolve(root);

  const retentionDays = Number(arg('retention-days', '30'));
  const dryRun = process.argv.includes('--dry-run');

  const sql = postgres(url, { max: 1 });

  const remove = async (relative: string): Promise<boolean> => {
    const resolved = path.resolve(storageRoot, relative);
    if (resolved !== storageRoot && !resolved.startsWith(storageRoot + path.sep)) {
      console.error(`  refusing path outside STORAGE_ROOT: ${relative}`);
      return false;
    }
    if (dryRun) return true;
    try {
      await unlink(resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return true;
  };

  const sweep = async (): Promise<string> => {
    const expired = await sql<{ id: number; storage_path: string }[]>`
      SELECT id, storage_path FROM files
      WHERE deleted_at IS NOT NULL
        AND deleted_at < now() - ${`${retentionDays} days`}::interval
    `;

    let purged = 0;
    for (const file of expired) {
      if (await remove(file.storage_path)) purged++;
    }
    if (!dryRun && purged > 0) {
      await sql`
        UPDATE files SET storage_path = ''
        WHERE id IN ${sql(expired.map((f) => f.id))} AND deleted_at IS NOT NULL
      `;
    }

    const stale = await sql<{ id: string; temp_path: string }[]>`
      SELECT id, temp_path FROM upload_sessions
      WHERE completed_at IS NULL AND expires_at < now()
    `;
    for (const session of stale) {
      await remove(session.temp_path);
    }
    if (!dryRun && stale.length > 0) {
      await sql`DELETE FROM upload_sessions WHERE id IN ${sql(stale.map((s) => s.id))}`;
    }

    const summary = `purged ${purged} deleted file(s) past ${retentionDays} days, cleared ${stale.length} abandoned upload(s).`;
    console.log(`${dryRun ? '[dry run] ' : ''}${summary}`);
    return summary;
  };

  try {
    // A dry run is not a run: it leaves no record behind.
    if (dryRun) await sweep();
    else await runJob('sweep', sweep);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error('Sweep failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
