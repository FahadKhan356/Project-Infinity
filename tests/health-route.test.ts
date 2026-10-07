/**
 * What the unauthenticated /api/health says when the database is down: the
 * failure's code and a fixed sentence, never the driver's text, which names
 * the host, port, role and database. The refused connection is real (nothing
 * listens on port 1); the missing-database case needs DATABASE_URL, only for
 * the server's address.
 *
 * And what it says when the database is up: a `jobs` block naming each
 * scheduled job's last run and whether it is stale, read from the records
 * the jobs leave under STORAGE_ROOT/jobs (src/lib/jobs) — timestamps,
 * status and summary, never the error text, which stays behind the login.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import postgres from 'postgres';
import { describeDbFailure } from '../src/app/api/health/describe-failure';
import { recordJobRun } from '../src/lib/jobs/runs';

const skip = process.env.DATABASE_URL ? false : 'set DATABASE_URL to reach a real server';

/** What postgres.js rejects with for `url`. */
async function failureFor(url: string): Promise<unknown> {
  const sql = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await sql`SELECT 1`;
    assert.fail('expected the connection to fail');
  } catch (error) {
    return error;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

describe('the /api/health failure text', () => {
  test('a refused connection says so, without the address or the credentials', async () => {
    const error = await failureFor('postgres://portal_2083:Hunter2-2083-secret@localhost:1/vault_2083');
    const text = describeDbFailure(error);
    assert.match(text, /connection refused/);
    assert.match(text, /\(ECONNREFUSED\)$/);
    for (const secret of ['localhost', '127.0.0.1', '::1', ':1', 'portal_2083', 'Hunter2', 'vault_2083']) {
      assert.ok(!text.includes(secret), `"${text}" names ${secret}`);
    }
  });

  test('server-side refusals are named by code, not by the names in the message', () => {
    const missingDb = Object.assign(new Error('database "aktivacity" does not exist'), { code: '3D000' });
    assert.equal(describeDbFailure(missingDb), 'the database does not exist (3D000)');
    const badPassword = Object.assign(
      new Error('password authentication failed for user "aktivacity"'), { code: '28P01' });
    assert.equal(describeDbFailure(badPassword), 'password authentication failed (28P01)');
    const unmigrated = Object.assign(new Error('relation "_migrations" does not exist'), { code: '42P01' });
    assert.match(describeDbFailure(unmigrated), /no migrations yet.*\(42P01\)/);
  });

  test('an unfamiliar code is passed on bare; no code at all says where to look', () => {
    assert.equal(describeDbFailure(Object.assign(new Error('internal: host db-7'), { code: 'XX000' })),
      'database error XX000');
    assert.equal(describeDbFailure(new Error('getaddrinfo failed for db.internal.example')),
      'unexpected error; the server log has the details');
    assert.equal(describeDbFailure('not even an Error'), 'unexpected error; the server log has the details');
    // src/db's own refusal names nothing but the variable.
    assert.equal(describeDbFailure(new Error('DATABASE_URL is not set')), 'DATABASE_URL is not set');
  });

  test('a database that does not exist, on a real server', { skip: !process.env.DATABASE_URL && 'set DATABASE_URL to reach a real server' }, async () => {
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = '/health_probe_missing_2083';
    const text = describeDbFailure(await failureFor(url.toString()));
    assert.equal(text, 'the database does not exist (3D000)');
  });
});

describe('the jobs block of /api/health', { skip }, () => {
  // Its own STORAGE_ROOT, and an empty BACKUP_STATUS_DIR so the backup
  // verdict does not depend on the developer's ./backups; both restored.
  const saved = { STORAGE_ROOT: process.env.STORAGE_ROOT, BACKUP_STATUS_DIR: process.env.BACKUP_STATUS_DIR };
  let storageRoot: string;
  let statusDir: string;
  let GET: () => Promise<Response>;
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  before(async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), 'aktivacity-health-'));
    statusDir = await mkdtemp(path.join(tmpdir(), 'aktivacity-health-status-'));
    process.env.STORAGE_ROOT = storageRoot;
    process.env.BACKUP_STATUS_DIR = statusDir;
    await recordJobRun({
      name: 'nightly', started_at: hoursAgo(1 + 2 / 60), finished_at: hoursAgo(1), status: 'ok',
      summary: 'Reminders: 3 sent across 4 people. Archive: 0 month(s) closed.', error: null,
    });
    await recordJobRun({
      name: 'recurring', started_at: hoursAgo(37.1), finished_at: hoursAgo(37), status: 'ok',
      summary: '0 filed, 0 skipped.', error: null,
    });
    ({ GET } = await import('../src/app/api/health/route'));
  });

  after(async () => {
    await (globalThis as { __sql?: { end(): Promise<void> } }).__sql?.end();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(storageRoot, { recursive: true, force: true });
    await rm(statusDir, { recursive: true, force: true });
  });

  test('the 200 body names each job with its last run and whether it is stale', async () => {
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.backups, 'unknown');
    // The state's reason, one token (src/lib/backup/health.ts): an empty
    // status directory is a backup that has never run.
    assert.equal(body.backupsReason, 'never_run');
    assert.deepEqual(Object.keys(body.jobs), ['sweep', 'recurring', 'nightly']);
    assert.equal(body.jobs.nightly.stale, false);
    assert.equal(body.jobs.nightly.lastRun.status, 'ok');
    assert.match(body.jobs.nightly.lastRun.summary, /Reminders/);
    assert.ok(body.jobs.nightly.lastRun.startedAt < body.jobs.nightly.lastRun.finishedAt);
    assert.ok(!('error' in body.jobs.nightly.lastRun), 'the error text stays behind the login');
    assert.equal(body.jobs.recurring.stale, true);
    assert.equal(body.jobs.recurring.lastRun.status, 'ok');
    assert.equal(body.jobs.sweep.stale, true);
    assert.equal(body.jobs.sweep.lastRun, null);
  });
});
