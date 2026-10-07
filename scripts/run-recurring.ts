/**
 * Files this month's copy of every recurring project (brief §29).
 *
 * Idempotent: a second run the same month finds nothing to do. In Docker the
 * `scheduler` service runs it nightly; without Docker, schedule it yourself
 * (docs/runbook.md, "Scheduled jobs"). On the 1st it files the new month's
 * orders, and on any other night it catches up whatever a missed run left.
 *
 *   npm run projects:recurring [-- --dry-run]
 *
 * A real run records its result under STORAGE_ROOT/jobs/recurring.json for
 * the dashboard and /api/health (src/lib/jobs), so STORAGE_ROOT must be set;
 * a dry run records nothing.
 *
 * Must run with the react-server condition (the npm script sets it), since
 * it reuses the portal's own modules rather than re-implementing the copy.
 */
import postgres from 'postgres';
import { runJob } from '../src/lib/jobs/runs';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  // One run at a time, across machines: a session lock on its own connection.
  const lock = postgres(url, { max: 1, onnotice: () => {} });
  const [{ locked }] = await lock<{ locked: boolean }[]>`
    SELECT pg_try_advisory_lock(hashtext('aktivacity:recurring')) AS locked`;
  if (!locked) {
    console.log('Another run is in progress; nothing to do.');
    await lock.end();
    return;
  }

  try {
    if (process.argv.includes('--dry-run')) {
      const due = await lock<{ project_code: string; client: string }[]>`
        SELECT p.project_code, c.name AS client
        FROM projects p JOIN client_months cm ON cm.id = p.client_month_id JOIN clients c ON c.id = p.client_id
        WHERE p.recurs_monthly AND p.status <> 'cancelled'
          AND cm.period_year * 12 + cm.period_month
              < extract(year FROM now() AT TIME ZONE 'UTC')::int * 12 + extract(month FROM now() AT TIME ZONE 'UTC')::int
          AND NOT EXISTS (SELECT 1 FROM projects n WHERE n.copied_from_project_id = p.id)
        ORDER BY c.name`;
      for (const d of due) console.log(`  would copy  ${d.project_code}  ${d.client}`);
      console.log(`${due.length} recurring order(s) due.`);
      return;
    }

    const { runRecurring } = await import('../src/lib/projects/recurring');
    await runJob('recurring', async () => {
      const outcome = await runRecurring();
      for (const c of outcome.created) console.log(`  filed    ${c.projectCode}  from ${c.sourceCode}  ${c.clientName}`);
      for (const s of outcome.skipped) console.log(`  skipped  ${s.sourceCode}  ${s.clientName}: ${s.reason}`);
      const summary = `${outcome.created.length} filed, ${outcome.skipped.length} skipped.`;
      console.log(summary);
      return summary;
    });
  } finally {
    await lock`SELECT pg_advisory_unlock(hashtext('aktivacity:recurring'))`;
    await lock.end();
    // The portal's pool keeps the process alive until it is closed.
    const g = globalThis as unknown as { __sql?: { end: () => Promise<void> } };
    await g.__sql?.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
