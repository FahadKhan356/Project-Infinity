/**
 * The portal's nightly housekeeping, in one run:
 *
 *   1. Deadline reminders (brief §20) — stored notifications for work that
 *      is coming due or overdue, so email/Slack copies can go out and the
 *      header badge lights up for people who have not opened the inbox.
 *   2. Month archive (brief §36) — client months whose period has ended and
 *      whose projects are all completed or cancelled are closed.
 *
 * Idempotent: a second run the same night finds nothing to do. In Docker the
 * `scheduler` service runs it nightly after the recurring-projects run;
 * without Docker, schedule it yourself (docs/runbook.md, "Scheduled jobs"):
 *
 *   npm run jobs:nightly [-- --dry-run]
 *
 * A real run records its result under STORAGE_ROOT/jobs/nightly.json for
 * the dashboard and /api/health (src/lib/jobs), so STORAGE_ROOT must be set;
 * a dry run records nothing.
 *
 * Must run with the react-server condition (the npm script sets it), since
 * it reuses the portal's own modules.
 */
import postgres from 'postgres';
import { runJob } from '../src/lib/jobs/runs';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const dryRun = process.argv.includes('--dry-run');

  const lock = postgres(url, { max: 1, onnotice: () => {} });
  const [{ locked }] = await lock<{ locked: boolean }[]>`
    SELECT pg_try_advisory_lock(hashtext('aktivacity:nightly')) AS locked`;
  if (!locked) {
    console.log('Another run is in progress; nothing to do.');
    await lock.end();
    return;
  }

  try {
    const { closeSettledMonths, settledMonths } = await import('../src/lib/months/lifecycle');
    if (dryRun) {
      const due = await settledMonths();
      for (const m of due) console.log(`  would close  ${m.clientName}  ${m.year}-${String(m.month).padStart(2, '0')}  (${m.projectCount} projects)`);
      console.log(`${due.length} month(s) ready to archive. Reminders are not previewed.`);
      return;
    }

    const { sendDeadlineReminders } = await import('../src/lib/notifications/reminders');
    await runJob('nightly', async () => {
      const reminders = await sendDeadlineReminders();
      const remindersLine = `Reminders: ${reminders.sent} sent across ${reminders.usersChecked} people.`;
      console.log(remindersLine);

      const archived = await closeSettledMonths();
      for (const m of archived.closed) {
        console.log(`  closed  ${m.clientName}  ${m.year}-${String(m.month).padStart(2, '0')}  (${m.projectCount} projects)`);
      }
      const archiveLine = `Archive: ${archived.closed.length} month(s) closed.`;
      console.log(archiveLine);
      return `${remindersLine} ${archiveLine}`;
    });
  } finally {
    await lock`SELECT pg_advisory_unlock(hashtext('aktivacity:nightly'))`;
    await lock.end();
    const g = globalThis as unknown as { __sql?: { end: () => Promise<void> } };
    await g.__sql?.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
