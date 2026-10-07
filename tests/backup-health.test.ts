/**
 * The backup verdict management sees (brief §44–45). Pure rules over the
 * status files the backup scripts write, reading those files from where a
 * no-Docker install keeps them, and the real scripts/backup/backup.sh and
 * verify-restore.sh run with stub PostgreSQL tools to prove what they record
 * when there is no off-box target; no database.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { backupHealth, judgeBackups } from '../src/lib/backup/health';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const now = new Date('2026-09-24T09:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
const ok = (h: number) => ({ status: 'ok', finished_at: hoursAgo(h) });

describe('backup health', () => {
  test('a recent backup and rehearsal is ok', () => {
    const h = judgeBackups({ lastRun: ok(6), lastSuccess: ok(6), lastVerify: ok(48) }, now);
    assert.equal(h.state, 'ok');
    assert.equal(h.reason, 'ok');
    assert.deepEqual(h.problems, []);
  });

  test('nothing has run yet is unknown, not ok', () => {
    const h = judgeBackups({ lastRun: null, lastSuccess: null, lastVerify: null }, now);
    assert.equal(h.state, 'unknown');
    assert.equal(h.reason, 'never_run');
  });

  test('a failed last run is failed, with the reason', () => {
    const h = judgeBackups({
      lastRun: { status: 'failed', finished_at: hoursAgo(2), error: 'pg_dump: connection refused' },
      lastSuccess: ok(26), lastVerify: ok(24),
    }, now);
    assert.equal(h.state, 'failed');
    assert.equal(h.reason, 'run_failed');
    assert.match(h.problems[0], /connection refused/);
  });

  const degraded = (h: number) => ({ status: 'degraded', finished_at: hoursAgo(h) });

  test('no off-site copy is a warning', () => {
    const h = judgeBackups({ lastRun: degraded(3), lastSuccess: ok(20), lastVerify: ok(24) }, now);
    assert.equal(h.state, 'warning');
    assert.equal(h.reason, 'same_disk_repository');
    assert.match(h.problems.join(' '), /off-site/);
  });

  test('never a complete backup is failed', () => {
    const h = judgeBackups({ lastRun: degraded(3), lastSuccess: null, lastVerify: null }, now);
    assert.equal(h.state, 'failed');
    assert.equal(h.reason, 'never_completed');
  });

  test('a stale success or rehearsal is a warning', () => {
    const staleSuccess = judgeBackups({ lastRun: ok(50), lastSuccess: ok(50), lastVerify: ok(24) }, now);
    assert.equal(staleSuccess.state, 'warning');
    assert.equal(staleSuccess.reason, 'stale');
    const staleDrill = judgeBackups({ lastRun: ok(5), lastSuccess: ok(5), lastVerify: ok(24 * 10) }, now);
    assert.equal(staleDrill.state, 'warning');
    assert.equal(staleDrill.reason, 'rehearsal_stale');
    const noDrill = judgeBackups({ lastRun: ok(5), lastSuccess: ok(5), lastVerify: null }, now);
    assert.equal(noDrill.state, 'warning');
    assert.equal(noDrill.reason, 'rehearsal_stale');
    const failedDrill = judgeBackups({ lastRun: ok(5), lastSuccess: ok(5), lastVerify: { status: 'failed', finished_at: hoursAgo(5) } }, now);
    assert.equal(failedDrill.state, 'warning');
    assert.equal(failedDrill.reason, 'rehearsal_failed');
    assert.equal(failedDrill.lastVerifiedAt, null);
  });

  // /api/health shows the state and the reason only, so a monitor must be
  // able to tell the warnings apart — and a same-disk repository is a
  // standing condition, which must not hide a backup going stale or a
  // rehearsal failing beside it.
  test('with several warnings at once the reason is the worst of them', () => {
    const staleOnSameDisk = judgeBackups({ lastRun: degraded(3), lastSuccess: ok(50), lastVerify: ok(24) }, now);
    assert.equal(staleOnSameDisk.state, 'warning');
    assert.equal(staleOnSameDisk.reason, 'stale');
    assert.equal(staleOnSameDisk.problems.length, 2, 'both are still spelled out for the dashboard');
    const failedDrillOnSameDisk = judgeBackups({ lastRun: degraded(3), lastSuccess: ok(20), lastVerify: { status: 'failed', finished_at: hoursAgo(5) } }, now);
    assert.equal(failedDrillOnSameDisk.reason, 'rehearsal_failed');
    const staleAndFailedDrill = judgeBackups({ lastRun: ok(50), lastSuccess: ok(50), lastVerify: { status: 'failed', finished_at: hoursAgo(5) } }, now);
    assert.equal(staleAndFailedDrill.reason, 'rehearsal_failed');
    // Across states the worse state wins, as before.
    assert.equal(judgeBackups({ lastRun: degraded(3), lastSuccess: null, lastVerify: { status: 'failed', finished_at: hoursAgo(5) } }, now).reason, 'never_completed');
  });

  // brief §44: file backups are mandatory. A run with no RESTIC_REPOSITORY
  // fails and says why, so the dashboard names the fix rather than "failed".
  const unconfiguredRun = (h: number) => ({
    status: 'failed', offsite: 'unconfigured', finished_at: hoursAgo(h),
    error: 'RESTIC_REPOSITORY is not set: the uploaded files were not backed up',
  });

  test('no RESTIC_REPOSITORY is unconfigured, naming the variable and the opt-out', () => {
    const h = judgeBackups({ lastRun: unconfiguredRun(2), lastSuccess: null, lastVerify: ok(24) }, now);
    assert.equal(h.state, 'unconfigured');
    assert.equal(h.reason, 'unconfigured');
    assert.match(h.problems.join(' '), /RESTIC_REPOSITORY/);
    assert.match(h.problems.join(' '), /BACKUP_FILES_DISABLED=1/);
  });

  test('unconfigured outranks a stale-success warning', () => {
    const h = judgeBackups({ lastRun: unconfiguredRun(2), lastSuccess: ok(20), lastVerify: ok(24) }, now);
    assert.equal(h.state, 'unconfigured');
    assert.equal(h.reason, 'unconfigured');
  });

  // BACKUP_FILES_DISABLED=1: the operator chose database dumps only.
  const disabledRun = (h: number) => ({ status: 'disabled', offsite: 'disabled', finished_at: hoursAgo(h) });

  test('file backups switched off on purpose is disabled, not failed', () => {
    const h = judgeBackups({ lastRun: disabledRun(3), lastSuccess: null, lastVerify: ok(24) }, now);
    assert.equal(h.state, 'disabled');
    assert.equal(h.reason, 'disabled');
    assert.match(h.problems.join(' '), /switched off/);
    // By decision there is never a "complete" run, so that sentence would
    // only ever nag; the state itself says files are not backed up.
    assert.doesNotMatch(h.problems.join(' '), /never been a complete backup/);
  });

  test('a disabled install still goes stale when the dumps stop', () => {
    const h = judgeBackups({ lastRun: disabledRun(50), lastSuccess: null, lastVerify: ok(24) }, now);
    assert.equal(h.state, 'warning');
    assert.equal(h.reason, 'stale');
    assert.match(h.problems.join(' '), /No database dump for 2 day\(s\)\./);
  });

  test('a failed rehearsal is a warning even with file backups switched off', () => {
    const h = judgeBackups({ lastRun: disabledRun(3), lastSuccess: null, lastVerify: { status: 'failed', finished_at: hoursAgo(5) } }, now);
    assert.equal(h.state, 'warning');
    assert.equal(h.reason, 'rehearsal_failed');
  });

  test('the state is always the one the reason stands for', () => {
    // Every reason, produced once, maps to the state the module documents.
    const expected: Record<string, string> = {
      ok: 'ok', never_run: 'unknown', disabled: 'disabled', same_disk_repository: 'warning',
      rehearsal_stale: 'warning', stale: 'warning', rehearsal_failed: 'warning',
      unconfigured: 'unconfigured', never_completed: 'failed', run_failed: 'failed',
    };
    const cases = [
      judgeBackups({ lastRun: ok(6), lastSuccess: ok(6), lastVerify: ok(48) }, now),
      judgeBackups({ lastRun: null, lastSuccess: null, lastVerify: null }, now),
      judgeBackups({ lastRun: disabledRun(3), lastSuccess: null, lastVerify: ok(24) }, now),
      judgeBackups({ lastRun: degraded(3), lastSuccess: ok(20), lastVerify: ok(24) }, now),
      judgeBackups({ lastRun: ok(5), lastSuccess: ok(5), lastVerify: null }, now),
      judgeBackups({ lastRun: ok(50), lastSuccess: ok(50), lastVerify: ok(24) }, now),
      judgeBackups({ lastRun: ok(5), lastSuccess: ok(5), lastVerify: { status: 'failed', finished_at: hoursAgo(5) } }, now),
      judgeBackups({ lastRun: unconfiguredRun(2), lastSuccess: null, lastVerify: ok(24) }, now),
      judgeBackups({ lastRun: degraded(3), lastSuccess: null, lastVerify: ok(24) }, now),
      judgeBackups({ lastRun: { status: 'failed', finished_at: hoursAgo(2) }, lastSuccess: ok(26), lastVerify: ok(24) }, now),
    ];
    assert.deepEqual(cases.map((h) => h.reason).sort(), Object.keys(expected).sort(), 'every reason is reachable');
    for (const h of cases) assert.equal(h.state, expected[h.reason], h.reason);
  });
});

describe('backup status files', () => {
  // As scripts/backup/*.sh write them (trimmed): `npm run backup` without
  // restic, then `npm run backup:verify`. backupHealth() judges against the
  // real clock, so these are an hour old from now.
  const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const unconfigured = {
    kind: 'backup', status: 'failed', finished_at: anHourAgo, offsite: 'unconfigured',
    error: 'RESTIC_REPOSITORY is not set: the uploaded files were not backed up',
  };
  const verified = { kind: 'verify', status: 'ok', finished_at: anHourAgo, error: null };

  async function statusDir(files: Record<string, unknown>) {
    const root = await mkdtemp(path.join(tmpdir(), 'aktivacity-backup-status-'));
    const dir = path.join(root, 'backups', 'status');
    await mkdir(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      await writeFile(path.join(dir, name), JSON.stringify(body));
    }
    return { root, dir };
  }

  test('BACKUP_STATUS_DIR may be relative, as in .env.local-dev.example', async () => {
    const { root, dir } = await statusDir({ 'last-run.json': unconfigured, 'last-verify.json': verified });
    const saved = process.env.BACKUP_STATUS_DIR;
    process.env.BACKUP_STATUS_DIR = path.relative(process.cwd(), dir);
    try {
      const h = await backupHealth();
      // Not "unknown": the local run is seen, and judged honestly. With no
      // RESTIC_REPOSITORY the run failed and the dashboard says file backups
      // are not configured, as the backups block of .env.local-dev.example
      // warns.
      assert.equal(h.state, 'unconfigured');
      assert.match(h.problems.join(' '), /not configured/);
      assert.match(h.problems.join(' '), /never been a complete backup with an off-site copy/);
      assert.ok(h.lastVerifiedAt, 'the rehearsal is read too');
    } finally {
      if (saved === undefined) delete process.env.BACKUP_STATUS_DIR;
      else process.env.BACKUP_STATUS_DIR = saved;
      await rm(root, { recursive: true, force: true });
    }
  });

  test('with an off-box copy the same files read as ok', async () => {
    const complete = { ...unconfigured, status: 'ok', offsite: 'ok', error: null };
    const { root, dir } = await statusDir({
      'last-run.json': complete, 'last-success.json': complete, 'last-verify.json': verified,
    });
    try {
      assert.equal((await backupHealth(dir)).state, 'ok');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a directory nobody has written to is unknown', async () => {
    const { root, dir } = await statusDir({});
    try {
      assert.equal((await backupHealth(dir)).state, 'unknown');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('backup.sh without an off-box target', { skip: process.platform === 'win32' && 'POSIX sh' }, () => {
  // The real script, with pg_dump / pg_restore replaced by stubs on PATH so
  // no database is needed: the dump step "succeeds", and what the offsite
  // step then records is the point. The environment is built from scratch:
  // the shell running the tests may carry RESTIC_* or BACKUP_FILES_DISABLED.
  async function runBackup(extra: Record<string, string>) {
    const root = await mkdtemp(path.join(tmpdir(), 'backup-sh-'));
    const bin = path.join(root, 'bin');
    const backups = path.join(root, 'backups');
    const storage = path.join(root, 'storage');
    await mkdir(bin, { recursive: true });
    await mkdir(storage, { recursive: true });
    await writeFile(path.join(bin, 'pg_dump'), `#!/bin/sh
for a in "$@"; do case $a in --file=*) printf 'stub dump\\n' >"\${a#--file=}" ;; esac; done
`);
    await writeFile(path.join(bin, 'pg_restore'), `#!/bin/sh
echo '123; 0 0 TABLE DATA public users postgres'
`);
    await chmod(path.join(bin, 'pg_dump'), 0o755);
    await chmod(path.join(bin, 'pg_restore'), 0o755);
    const result = spawnSync('sh', [path.join(REPO, 'scripts', 'backup', 'backup.sh')], {
      encoding: 'utf8',
      timeout: 60_000,
      // Built from scratch on purpose (never ...process.env). NODE_ENV means
      // nothing to sh; Next's ProcessEnv type requires it.
      env: {
        NODE_ENV: 'test',
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: root,
        TMPDIR: root,
        PGDATABASE: 'stub',
        BACKUP_DIR: backups,
        STORAGE_DIR: storage,
        ...extra,
      },
    });
    assert.equal(result.error, undefined, String(result.error));
    const statusDir = path.join(backups, 'status');
    const lastRun = JSON.parse(await readFile(path.join(statusDir, 'last-run.json'), 'utf8'));
    const lastSuccess = await stat(path.join(statusDir, 'last-success.json')).then(() => true, () => false);
    // Judge the run on its own: a rehearsal that has never run is a warning
    // in its own right, and would hide the run's verdict.
    const verdict = judgeBackups({ lastRun, lastSuccess: null, lastVerify: { status: 'ok', finished_at: new Date().toISOString() } });
    return { root, result, lastRun, lastSuccess, verdict };
  }

  test('no RESTIC_REPOSITORY: the run fails loudly, keeps the dump, and records why', async () => {
    const { root, result, lastRun, lastSuccess, verdict } = await runBackup({});
    try {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /BACKUP FAILED/);
      assert.match(result.stderr, /RESTIC_REPOSITORY/);
      assert.equal(lastRun.status, 'failed');
      assert.equal(lastRun.offsite, 'unconfigured');
      assert.match(lastRun.error, /RESTIC_REPOSITORY/);
      assert.ok(lastRun.dump_file, 'the database dump is kept: a misconfigured file target does not throw away the DB safety net');
      assert.equal(lastSuccess, false, 'no last-success.json');
      assert.equal(verdict.state, 'unconfigured');
      assert.equal(verdict.reason, 'unconfigured');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BACKUP_FILES_DISABLED=1: database dump only, recorded as disabled, exit 0', async () => {
    const { root, result, lastRun, lastSuccess, verdict } = await runBackup({ BACKUP_FILES_DISABLED: '1' });
    try {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(lastRun.status, 'disabled');
      assert.equal(lastRun.offsite, 'disabled');
      assert.match(lastRun.warnings.join(' '), /BACKUP_FILES_DISABLED/);
      assert.ok(lastRun.dump_file);
      assert.equal(lastSuccess, false, 'dumps only is never a complete backup');
      assert.equal(verdict.state, 'disabled');
      assert.equal(verdict.reason, 'disabled');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('verify-restore.sh without an off-box target', { skip: process.platform === 'win32' && 'POSIX sh' }, () => {
  // The real rehearsal against a stub PostgreSQL: pg_restore, createdb and
  // dropdb succeed, psql says every core table exists with 0 rows on both
  // sides, so the database part passes — and what the offsite step then
  // records is the point: the same rule as backup.sh (brief §44).
  async function runVerify(extra: Record<string, string>) {
    const root = await mkdtemp(path.join(tmpdir(), 'verify-sh-'));
    const bin = path.join(root, 'bin');
    const backups = path.join(root, 'backups');
    const db = path.join(backups, 'db');
    await mkdir(bin, { recursive: true });
    await mkdir(db, { recursive: true });
    // A fresh dump, named as backup.sh names them: a UTC stamp.
    const stamp = new Date().toISOString().replace(/[-:]|\.\d+/g, '');
    const dump = `aktivacity-${stamp}.dump`;
    await writeFile(path.join(db, dump), 'stub dump\n');
    const stubs: Record<string, string> = {
      pg_restore: 'exit 0',
      createdb: 'exit 0',
      dropdb: 'exit 0',
      // The to_regclass probe says the table exists; every count is 0.
      psql: 'case "$*" in *to_regclass*) echo t ;; *) echo 0 ;; esac',
      // A repository whose newest db snapshot holds the dump and checks clean.
      restic: `case $1 in ls) echo "/backups/db/${dump}" ;; esac`,
    };
    for (const [name, body] of Object.entries(stubs)) {
      await writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`);
      await chmod(path.join(bin, name), 0o755);
    }
    const result = spawnSync('sh', [path.join(REPO, 'scripts', 'backup', 'verify-restore.sh')], {
      encoding: 'utf8',
      timeout: 60_000,
      // Built from scratch on purpose (never ...process.env), as for backup.sh.
      env: {
        NODE_ENV: 'test',
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: root,
        TMPDIR: root,
        PGDATABASE: 'stub',
        BACKUP_DIR: backups,
        ...extra,
      },
    });
    assert.equal(result.error, undefined, String(result.error));
    const lastVerify = JSON.parse(await readFile(path.join(backups, 'status', 'last-verify.json'), 'utf8'));
    // Judged beside a clean nightly run: what the rehearsal alone does to the verdict.
    const fresh = { status: 'ok', finished_at: new Date().toISOString() };
    const verdict = judgeBackups({ lastRun: fresh, lastSuccess: fresh, lastVerify });
    return { root, result, dump, lastVerify, verdict };
  }

  test('no RESTIC_REPOSITORY: the rehearsal fails, keeps the database result, and records why', async () => {
    const { root, result, dump, lastVerify, verdict } = await runVerify({});
    try {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /RESTORE REHEARSAL FAILED/);
      assert.match(result.stderr, /RESTIC_REPOSITORY/);
      assert.equal(lastVerify.status, 'failed');
      assert.equal(lastVerify.offsite, 'unconfigured');
      assert.match(lastVerify.error, /RESTIC_REPOSITORY/);
      assert.match(lastVerify.error, /BACKUP_FILES_DISABLED=1/);
      // The database part ran first and is on record: the dump restores.
      assert.equal(lastVerify.dump_file, dump);
      assert.equal(lastVerify.tables.users.ok, true);
      assert.equal(lastVerify.tables._migrations.ok, true);
      assert.equal(lastVerify.offsite_has_dump, 'skipped');
      assert.equal(lastVerify.restic_check, 'skipped');
      assert.equal(verdict.state, 'warning');
      assert.equal(verdict.reason, 'rehearsal_failed');
      assert.equal(verdict.lastVerifiedAt, null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BACKUP_FILES_DISABLED=1: the database rehearsal passes, the file part is recorded disabled, exit 0', async () => {
    const { root, result, lastVerify, verdict } = await runVerify({ BACKUP_FILES_DISABLED: '1' });
    try {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /BACKUP_FILES_DISABLED=1/, 'said out loud, as backup.sh says it');
      assert.match(result.stdout, /restore rehearsal passed/);
      assert.equal(lastVerify.status, 'ok');
      assert.equal(lastVerify.offsite, 'disabled');
      assert.equal(lastVerify.offsite_has_dump, 'skipped');
      assert.equal(lastVerify.restic_check, 'skipped');
      assert.equal(lastVerify.error, null);
      assert.equal(verdict.state, 'ok');
      assert.ok(verdict.lastVerifiedAt, 'counts as a rehearsal');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('with RESTIC_REPOSITORY the repository is checked and the opt-out is ignored', async () => {
    const { root, result, lastVerify, verdict } = await runVerify({
      RESTIC_REPOSITORY: '/repo', RESTIC_PASSWORD: 'stub', BACKUP_FILES_DISABLED: '1',
    });
    try {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /BACKUP_FILES_DISABLED=1 is ignored/);
      assert.equal(lastVerify.status, 'ok');
      assert.equal(lastVerify.offsite, 'ok');
      assert.equal(lastVerify.offsite_has_dump, 'ok');
      assert.equal(lastVerify.restic_check, 'ok');
      assert.equal(verdict.state, 'ok');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
