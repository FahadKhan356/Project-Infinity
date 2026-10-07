import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * What each scheduled job leaves behind (brief §20, §36, §44).
 *
 * The retention sweep, the recurring projects and the nightly housekeeping
 * (scripts/sweep-files.ts, run-recurring.ts, nightly.ts) each record their
 * last run as STORAGE_ROOT/jobs/<name>.json: when it started and finished,
 * whether it worked, one line of what it did, and the error when it did
 * not. The dashboard and /api/health read those files (./health.ts), the
 * way they read the backup's status files, so a job that quietly stopped
 * running is noticed the next morning rather than at month end.
 *
 * Deliberately NOT `server-only`: scripts/sweep-files.ts runs without the
 * react-server condition, under which that import throws. Nothing here
 * touches the database or the request scope either.
 */

export const JOB_NAMES = ['sweep', 'recurring', 'nightly'] as const;
export type JobName = (typeof JOB_NAMES)[number];

export const JOB_TITLES: Record<JobName, string> = {
  sweep: 'Retention sweep',
  recurring: 'Recurring projects',
  nightly: 'Nightly housekeeping',
};

export interface JobRun {
  name: JobName;
  /** ISO instants. */
  started_at: string;
  finished_at: string;
  status: 'ok' | 'failed';
  /** The job's own closing line, e.g. "3 filed, 0 skipped." Empty on failure. */
  summary: string;
  error: string | null;
}

/** Where the records live: STORAGE_ROOT/jobs, resolved like the file store. */
export function jobsDir(root = process.env.STORAGE_ROOT): string {
  if (!root) throw new Error('STORAGE_ROOT is not set');
  return path.join(path.resolve(root), 'jobs');
}

/**
 * Writes the record atomically (temp file, then rename) and world-readable.
 * The modes are set explicitly: in Docker the scheduler writes as root under
 * the umask its entrypoint needs for the env file, and the app reads the
 * record as its own unprivileged user.
 */
export async function recordJobRun(run: JobRun, dir = jobsDir()): Promise<void> {
  await mkdir(dir, { recursive: true });
  try {
    await chmod(dir, 0o755);
  } catch {
    // Not ours to change (a pre-existing directory owned by someone else);
    // the file itself is still made readable below.
  }
  const target = path.join(dir, `${run.name}.json`);
  const temp = `${target}.tmp`;
  await writeFile(temp, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  await chmod(temp, 0o644);
  await rename(temp, target);
}

function isJobRun(value: unknown, name: JobName): value is JobRun {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.name === name
    && typeof v.started_at === 'string'
    && typeof v.finished_at === 'string'
    && (v.status === 'ok' || v.status === 'failed')
    && typeof v.summary === 'string'
    && (v.error === null || typeof v.error === 'string');
}

/** The last recorded run, or null when there is none or the file is not a record. */
export async function readJobRun(name: JobName, dir = jobsDir()): Promise<JobRun | null> {
  let text: string;
  try {
    text = await readFile(path.join(dir, `${name}.json`), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isJobRun(parsed, name) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Runs a job's real work and records the outcome. `work` returns the summary
 * line. A failure is recorded best-effort (the record must never hide the
 * job's own error, which is rethrown); a success that cannot be recorded is
 * an error in its own right, since an unrecorded run reads as "never ran".
 */
export async function runJob(name: JobName, work: () => Promise<string>): Promise<string> {
  const started_at = new Date().toISOString();
  let summary: string;
  try {
    summary = await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await recordJobRun({
        name, started_at, finished_at: new Date().toISOString(),
        status: 'failed', summary: '', error: message.slice(0, 500),
      });
    } catch (recordError) {
      console.error(`[jobs] could not record the failed ${name} run:`, recordError);
    }
    throw error;
  }
  await recordJobRun({
    name, started_at, finished_at: new Date().toISOString(),
    status: 'ok', summary, error: null,
  });
  return summary;
}
