/**
 * The record each scheduled job leaves behind (brief §20, §36, §44): the
 * retention sweep, the recurring projects and the nightly housekeeping each
 * write STORAGE_ROOT/jobs/<name>.json when they run, and the dashboard and
 * /api/health judge those files — stale after 36 hours, or when a job has
 * never run. Pure rules and a scratch directory; no database.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

type Runs = typeof import('../src/lib/jobs/runs');
type Health = typeof import('../src/lib/jobs/health');

let root: string;
let runs: Runs;
let health: Health;
const savedStorageRoot = process.env.STORAGE_ROOT;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aktivacity-jobs-'));
  process.env.STORAGE_ROOT = root;
  runs = await import('../src/lib/jobs/runs');
  health = await import('../src/lib/jobs/health');
});

after(async () => {
  if (savedStorageRoot === undefined) delete process.env.STORAGE_ROOT;
  else process.env.STORAGE_ROOT = savedStorageRoot;
  await rm(root, { recursive: true, force: true });
});

const now = new Date('2026-09-24T09:00:00Z');
const hoursAgo = (h: number, from = now) => new Date(from.getTime() - h * 3_600_000).toISOString();

describe('the job run recorder', () => {
  test('a run is recorded and read back unchanged, readable by another user', async () => {
    const run = {
      name: 'nightly' as const,
      started_at: hoursAgo(1.05),
      finished_at: hoursAgo(1),
      status: 'ok' as const,
      summary: 'Reminders: 2 sent across 5 people. Archive: 1 month(s) closed.',
      error: null,
    };
    await runs.recordJobRun(run);
    assert.deepEqual(await runs.readJobRun('nightly'), run);

    // The scheduler writes as root under a 077 umask; the app reads the file
    // as its own user, so the recorder sets the modes itself.
    const dir = path.join(root, 'jobs');
    const file = path.join(dir, 'nightly.json');
    assert.equal((await stat(file)).mode & 0o777, 0o644);
    assert.equal((await stat(dir)).mode & 0o777, 0o755);
    assert.ok(!(await readdir(dir)).includes('nightly.json.tmp'), 'the temp file is renamed away');
  });

  test('never recorded, or unreadable, is null', async () => {
    assert.equal(await runs.readJobRun('sweep'), null);
    await writeFile(path.join(root, 'jobs', 'sweep.json'), '{ not json');
    assert.equal(await runs.readJobRun('sweep'), null);
    await writeFile(path.join(root, 'jobs', 'sweep.json'), JSON.stringify({ name: 'sweep', status: 'ok' }));
    assert.equal(await runs.readJobRun('sweep'), null, 'a record missing its timestamps is not a record');
  });

  test('runJob records success with the summary and failure with the error, and rethrows', async () => {
    const before = Date.now();
    assert.equal(await runs.runJob('recurring', async () => '1 filed, 0 skipped.'), '1 filed, 0 skipped.');
    const ok = await runs.readJobRun('recurring');
    assert.ok(ok);
    assert.equal(ok.status, 'ok');
    assert.equal(ok.summary, '1 filed, 0 skipped.');
    assert.equal(ok.error, null);
    assert.ok(Date.parse(ok.started_at) >= before - 1000);
    assert.ok(Date.parse(ok.started_at) <= Date.parse(ok.finished_at));

    await assert.rejects(runs.runJob('recurring', async () => { throw new Error('boom'); }), /boom/);
    const failed = await runs.readJobRun('recurring');
    assert.ok(failed);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'boom');
    assert.equal(failed.summary, '');
  });

  test('a successful run that cannot be recorded fails loudly', async () => {
    delete process.env.STORAGE_ROOT;
    let worked = false;
    try {
      await assert.rejects(
        runs.runJob('nightly', async () => { worked = true; return 'done'; }),
        /STORAGE_ROOT is not set/,
      );
      assert.equal(worked, true, 'the work itself ran');
    } finally {
      process.env.STORAGE_ROOT = root;
    }
  });
});

describe('the stale rule', () => {
  const run = (finished_at: string, status: 'ok' | 'failed' = 'ok') => ({
    name: 'nightly' as const, started_at: finished_at, finished_at, status, summary: '', error: null,
  });

  test('never run is stale, with no last run', () => {
    const h = health.judgeJob('nightly', null, now);
    assert.equal(h.stale, true);
    assert.equal(h.lastRun, null);
    assert.equal(h.title, 'Nightly housekeeping');
  });

  test('fresh is not stale; 36 hours is the line', () => {
    assert.equal(health.judgeJob('nightly', run(hoursAgo(1)), now).stale, false);
    assert.equal(health.judgeJob('nightly', run(hoursAgo(35)), now).stale, false);
    assert.equal(health.judgeJob('nightly', run(hoursAgo(37)), now).stale, true);
  });

  test('a fresh failure is not stale (the banner flags failed on its own)', () => {
    assert.equal(health.judgeJob('nightly', run(hoursAgo(1), 'failed'), now).stale, false);
  });

  test('a record with an unreadable time is stale', () => {
    assert.equal(health.judgeJob('nightly', run('garbage'), now).stale, true);
  });
});

describe('jobsHealth', () => {
  test('reads every job from the directory, in the nightly order', async () => {
    const dir = path.join(root, 'health-dir');
    await runs.recordJobRun({
      name: 'nightly', started_at: hoursAgo(1.1), finished_at: hoursAgo(1), status: 'ok',
      summary: 'Reminders: 0 sent across 0 people. Archive: 0 month(s) closed.', error: null,
    }, dir);
    await runs.recordJobRun({
      name: 'recurring', started_at: hoursAgo(37.1), finished_at: hoursAgo(37), status: 'ok',
      summary: '0 filed, 0 skipped.', error: null,
    }, dir);

    const result = await health.jobsHealth(dir, now);
    assert.deepEqual(Object.keys(result), ['sweep', 'recurring', 'nightly']);
    assert.equal(result.sweep.lastRun, null);
    assert.equal(result.sweep.stale, true);
    assert.equal(result.recurring.stale, true);
    assert.equal(result.recurring.lastRun?.summary, '0 filed, 0 skipped.');
    assert.equal(result.nightly.stale, false);
    assert.equal(result.nightly.title, 'Nightly housekeeping');
  });

  test('with no STORAGE_ROOT every job reads as never run, and nothing throws', async () => {
    delete process.env.STORAGE_ROOT;
    try {
      const result = await health.jobsHealth();
      for (const name of ['sweep', 'recurring', 'nightly'] as const) {
        assert.equal(result[name].stale, true);
        assert.equal(result[name].lastRun, null);
      }
    } finally {
      process.env.STORAGE_ROOT = root;
    }
  });
});
