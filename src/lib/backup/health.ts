import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Whether the backups are actually happening (brief §44–45).
 *
 * The backup job (the `backup` container, or `npm run backup`) writes its
 * results to BACKUP_STATUS_DIR (mounted read-only into the app at
 * /backups/status; see docs/runbook.md). A backup nobody notices failing is
 * not a backup, so management sees the verdict on the dashboard rather than
 * having to read JSON on the server. The states, best to worst:
 *
 *   ok            the last run and the weekly rehearsal are recent and clean
 *   unknown       nothing has run yet, or the status directory is not mounted
 *   disabled      BACKUP_FILES_DISABLED=1: database dumps only, on purpose
 *                 (last-run.json says `status: disabled`)
 *   warning       same-disk repository (`degraded`), a stale success or
 *                 dump, or a failed / stale rehearsal
 *   unconfigured  RESTIC_REPOSITORY is not set: the run failed with
 *                 `offsite: unconfigured` and the files are not backed up
 *   failed        the last run failed for any other reason
 *
 * Beside the state, one machine-readable reason: the worst finding, for an
 * external monitor reading /api/health (`backupsReason`), which otherwise
 * could not tell a same-disk repository from a stale backup or a failed
 * rehearsal — all three read `warning`. REASONS lists them best to worst
 * with the state each produces; when several apply, the worst wins, so a
 * standing condition (the same-disk repository) never hides a new one (the
 * backups going stale beside it). The dashboard keeps its sentences; this
 * is the token.
 */
export type BackupState = 'ok' | 'unknown' | 'disabled' | 'warning' | 'unconfigured' | 'failed';

const REASONS = {
  /** the last run and the weekly rehearsal are recent and clean */
  ok: 'ok',
  /** nothing has run yet, or the status directory is not mounted */
  never_run: 'unknown',
  /** BACKUP_FILES_DISABLED=1: database dumps only, on purpose */
  disabled: 'disabled',
  /** the restic repository is on the same disk as the server (`degraded`) */
  same_disk_repository: 'warning',
  /** the weekly rehearsal is over 8 days old, or has never run */
  rehearsal_stale: 'warning',
  /** no complete backup — or, dumps only, no dump — for over 36 hours */
  stale: 'warning',
  /** the last restore rehearsal failed */
  rehearsal_failed: 'warning',
  /** RESTIC_REPOSITORY is not set: the files are not backed up anywhere */
  unconfigured: 'unconfigured',
  /** there has never been a complete backup with an off-site copy */
  never_completed: 'failed',
  /** the last run failed for any other reason */
  run_failed: 'failed',
} as const satisfies Record<string, BackupState>;

export type BackupReason = keyof typeof REASONS;

/** Best to worst: the key order of REASONS. */
const REASON_RANK = Object.keys(REASONS) as BackupReason[];

export interface BackupHealth {
  state: BackupState;
  /** Why, as one token; `ok` when the state is `ok`. */
  reason: BackupReason;
  lastSuccessAt: string | null;
  lastVerifiedAt: string | null;
  /** Plain sentences, worst first. Empty when all is well. */
  problems: string[];
}

interface RunFile { status?: string; finished_at?: string; error?: string | null; offsite?: string }

/** A nightly schedule missed once is a warning; this is a day and a half. */
const SUCCESS_MAX_AGE_H = 36;
/** The restore rehearsal is weekly. */
const VERIFY_MAX_AGE_H = 8 * 24;

/** Pure, so the rules are tested without files. */
export function judgeBackups(
  files: { lastRun: RunFile | null; lastSuccess: RunFile | null; lastVerify: RunFile | null },
  now = new Date(),
): BackupHealth {
  const { lastRun, lastSuccess, lastVerify } = files;
  const ageH = (iso?: string) => (iso ? (now.getTime() - new Date(iso).getTime()) / 3_600_000 : Infinity);
  const problems: string[] = [];
  // The state follows the reason (REASONS), so worsening one worsens both.
  let reason: BackupReason = 'ok';
  const worsen = (to: BackupReason) => {
    if (REASON_RANK.indexOf(to) > REASON_RANK.indexOf(reason)) reason = to;
  };

  if (!lastRun) {
    return {
      state: 'unknown', reason: 'never_run', lastSuccessAt: null, lastVerifiedAt: lastVerify?.finished_at ?? null,
      problems: ['No backup has run yet — or the status directory is not mounted.'],
    };
  }
  const unconfigured = lastRun.status === 'failed' && lastRun.offsite === 'unconfigured';
  const filesOff = lastRun.status === 'disabled';
  if (unconfigured) {
    worsen('unconfigured');
    problems.push('File backups are not configured: RESTIC_REPOSITORY is not set, so the uploaded files are not backed up anywhere and the last run failed. '
      + 'Set RESTIC_REPOSITORY and RESTIC_PASSWORD (docs/runbook.md, “Setting up the NAS target”), or set BACKUP_FILES_DISABLED=1 to run without file backups on purpose.');
  } else if (lastRun.status === 'failed') {
    worsen('run_failed');
    problems.push(`The last backup failed${lastRun.error ? `: ${lastRun.error}` : '.'}`);
  } else if (filesOff) {
    worsen('disabled');
    problems.push('File backups are switched off (BACKUP_FILES_DISABLED=1): database dumps only — the uploaded files are not backed up.');
  } else if (lastRun.status === 'degraded') {
    worsen('same_disk_repository');
    problems.push('The last backup has no off-site copy — it is on the same disk as the server.');
  }
  if (filesOff) {
    // Dumps only, by decision: there is never a "complete" run to date from,
    // so the freshness rule applies to the dump the last run made.
    if (ageH(lastRun.finished_at) > SUCCESS_MAX_AGE_H) {
      worsen('stale');
      problems.push(`No database dump for ${Math.floor(ageH(lastRun.finished_at) / 24)} day(s).`);
    }
  } else if (ageH(lastSuccess?.finished_at) > SUCCESS_MAX_AGE_H) {
    worsen(lastSuccess ? 'stale' : unconfigured ? 'unconfigured' : 'never_completed');
    problems.push(lastSuccess
      ? `No complete backup for ${Math.floor(ageH(lastSuccess.finished_at) / 24)} day(s).`
      : 'There has never been a complete backup with an off-site copy.');
  }
  if (lastVerify?.status === 'failed') {
    worsen('rehearsal_failed');
    problems.push(`The last restore rehearsal failed${lastVerify.error ? `: ${lastVerify.error}` : '.'}`);
  } else if (ageH(lastVerify?.finished_at) > VERIFY_MAX_AGE_H) {
    worsen('rehearsal_stale');
    problems.push(lastVerify ? 'The weekly restore rehearsal has not run for over a week.' : 'No restore rehearsal has run yet.');
  }

  return {
    state: REASONS[reason],
    reason,
    lastSuccessAt: lastSuccess?.finished_at ?? null,
    lastVerifiedAt: lastVerify?.status === 'ok' ? lastVerify.finished_at ?? null : null,
    problems,
  };
}

async function readJson(file: string): Promise<RunFile | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as RunFile;
  } catch {
    return null;
  }
}

export async function backupHealth(dir = process.env.BACKUP_STATUS_DIR ?? '/backups/status'): Promise<BackupHealth> {
  const [lastRun, lastSuccess, lastVerify] = await Promise.all([
    readJson(path.join(dir, 'last-run.json')),
    readJson(path.join(dir, 'last-success.json')),
    readJson(path.join(dir, 'last-verify.json')),
  ]);
  return judgeBackups({ lastRun, lastSuccess, lastVerify });
}
