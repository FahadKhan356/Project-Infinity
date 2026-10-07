import 'server-only';
import { JOB_NAMES, JOB_TITLES, jobsDir, readJobRun, type JobName, type JobRun } from './runs';

/**
 * Whether the scheduled jobs are actually running (brief §20, §36, §44),
 * judged from the records they leave (./runs.ts) the way the backup verdict
 * is judged from the backup's status files (src/lib/backup/health.ts).
 *
 * A job is stale when it has never run, or when its last run finished more
 * than 36 hours ago: nightly jobs, so one missed night is flagged the next
 * morning. A fresh run that failed is not stale — the record says `failed`,
 * and the dashboard flags that on its own.
 */

/** A nightly schedule missed once is a warning; this is a day and a half. */
export const JOB_MAX_AGE_H = 36;

export interface JobHealth {
  name: JobName;
  title: string;
  lastRun: JobRun | null;
  stale: boolean;
}

/** Pure, so the rule is tested without files. */
export function judgeJob(name: JobName, run: JobRun | null, now = new Date()): JobHealth {
  const ageH = run ? (now.getTime() - Date.parse(run.finished_at)) / 3_600_000 : Infinity;
  // Written so an unparsable time (NaN) counts as stale rather than fresh.
  const stale = !(ageH <= JOB_MAX_AGE_H);
  return { name, title: JOB_TITLES[name], lastRun: run, stale };
}

/**
 * Every job's verdict, in the order they run each night. Never throws: with
 * no STORAGE_ROOT, or no records, every job reads as never run, and
 * /api/health keeps answering.
 */
export async function jobsHealth(dir?: string, now = new Date()): Promise<Record<JobName, JobHealth>> {
  const resolved = dir ?? (process.env.STORAGE_ROOT ? jobsDir() : null);
  const result = {} as Record<JobName, JobHealth>;
  for (const name of JOB_NAMES) {
    let run: JobRun | null = null;
    if (resolved) {
      try {
        run = await readJobRun(name, resolved);
      } catch {
        run = null;
      }
    }
    result[name] = judgeJob(name, run, now);
  }
  return result;
}
