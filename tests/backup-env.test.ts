/**
 * Backups without Docker (brief §44): the portal's .env mapped onto what
 * scripts/backup/*.sh read, and the pre-flight that refuses a production
 * start without file backups. No database; the pre-flight tests spawn the
 * real scripts/check-env.mjs from a scratch folder with an environment built
 * from nothing, so neither the repo's .env nor the developer's shell (which
 * may carry RESTIC_REPOSITORY or BACKUP_FILES_DISABLED) leaks in.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { backupEnv, connectionFromUrl, fileBackupPolicy, findPgBinDir } from '../scripts/backup-env.mjs';

const ROOT = path.resolve('/srv/portal');
const noPgBin = { pgBinDir: () => null };
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('backup environment', () => {
  test('DATABASE_URL becomes the PG* variables, password decoded', () => {
    assert.deepEqual(
      connectionFromUrl('postgres://aktivacity:p%40ss%3Aw%2Frd@db.local:5433/aktivacity'),
      { PGHOST: 'db.local', PGPORT: '5433', PGUSER: 'aktivacity', PGPASSWORD: 'p@ss:w/rd', PGDATABASE: 'aktivacity' },
    );
  });

  test('the port defaults to 5432; IPv6 loses its brackets; sslmode carries over', () => {
    assert.deepEqual(
      connectionFromUrl('postgres://me@[::1]/portal?sslmode=require'),
      { PGHOST: '::1', PGPORT: '5432', PGUSER: 'me', PGDATABASE: 'portal', PGSSLMODE: 'require' },
    );
  });

  test('a malformed URL is refused without repeating it', () => {
    assert.throws(() => connectionFromUrl('postgres://user:s3cret@[bad'), (error: Error) => {
      assert.doesNotMatch(error.message, /s3cret/);
      return true;
    });
  });

  test('DATABASE_URL wins over stray PG* variables in the shell', () => {
    const env = backupEnv({
      DATABASE_URL: 'postgres://aktivacity@localhost:5433/aktivacity',
      PGDATABASE: 'postgres', PGPASSWORD: 'other', PGHOST: 'elsewhere',
    }, ROOT, noPgBin);
    assert.equal(env.PGDATABASE, 'aktivacity');
    assert.equal(env.PGHOST, 'localhost');
    assert.equal(env.PGPASSWORD, undefined, 'no password in the URL: none is invented');
  });

  test('without DATABASE_URL, PG* pass through', () => {
    const env = backupEnv({ PGDATABASE: 'aktivacity', PGHOST: 'db' }, ROOT, noPgBin);
    assert.equal(env.PGDATABASE, 'aktivacity');
    assert.equal(env.PGHOST, 'db');
  });

  test('storage and backup paths resolve against the project folder', () => {
    const env = backupEnv({ STORAGE_ROOT: './storage', BACKUP_DIR: './backups' }, ROOT, noPgBin);
    assert.equal(env.STORAGE_DIR, path.join(ROOT, 'storage'));
    assert.equal(env.BACKUP_DIR, path.join(ROOT, 'backups'));
    // Where the dashboard looks unless told otherwise.
    assert.equal(env.BACKUP_STATUS_DIR, path.join(ROOT, 'backups', 'status'));
  });

  test('defaults: ./storage and ./backups; an absolute path stays as it is', () => {
    const env = backupEnv({ BACKUP_STATUS_DIR: path.resolve('/var/status') }, ROOT, noPgBin);
    assert.equal(env.STORAGE_DIR, path.join(ROOT, 'storage'));
    assert.equal(env.BACKUP_DIR, path.join(ROOT, 'backups'));
    assert.equal(env.BACKUP_STATUS_DIR, path.resolve('/var/status'));
  });

  test('the same relative BACKUP_STATUS_DIR the portal reads', () => {
    const env = backupEnv({ BACKUP_DIR: './backups', BACKUP_STATUS_DIR: './backups/status' }, ROOT, noPgBin);
    assert.equal(env.BACKUP_STATUS_DIR, path.join(ROOT, 'backups', 'status'));
  });

  test('the PostgreSQL bin directory goes in front of PATH', () => {
    const bin = path.resolve('/opt/pg/bin');
    const env = backupEnv({ PATH: ['/usr/bin', '/bin'].join(path.delimiter) }, ROOT, { pgBinDir: () => bin });
    assert.equal(env.PATH, [bin, '/usr/bin', '/bin'].join(path.delimiter));
    assert.equal(backupEnv({ PATH: '/usr/bin' }, ROOT, noPgBin).PATH, '/usr/bin');
  });

  test('PG_BIN is the bin directory when set', () => {
    assert.equal(findPgBinDir({ PG_BIN: '/custom/pg/bin', PATH: '' }), '/custom/pg/bin');
  });

  test('the caller’s environment is left untouched', () => {
    const original = { DATABASE_URL: 'postgres://a:b@h/d', PGDATABASE: 'x' };
    backupEnv(original, ROOT, noPgBin);
    assert.deepEqual(original, { DATABASE_URL: 'postgres://a:b@h/d', PGDATABASE: 'x' });
  });
});

describe('file backup policy (brief §44: file backups are mandatory)', () => {
  test('RESTIC_REPOSITORY set is configured, whatever the flag says', () => {
    assert.equal(fileBackupPolicy({ RESTIC_REPOSITORY: '/repo' }), 'configured');
    assert.equal(fileBackupPolicy({ RESTIC_REPOSITORY: 'sftp:backup@nas:/aktivacity', BACKUP_FILES_DISABLED: '1' }), 'configured');
  });

  test('only the exact BACKUP_FILES_DISABLED=1 switches file backups off', () => {
    assert.equal(fileBackupPolicy({ BACKUP_FILES_DISABLED: '1' }), 'disabled');
    assert.equal(fileBackupPolicy({ RESTIC_REPOSITORY: '', BACKUP_FILES_DISABLED: '1' }), 'disabled');
    for (const value of ['true', '0', '', 'yes']) {
      assert.equal(fileBackupPolicy({ BACKUP_FILES_DISABLED: value }), 'unconfigured', `BACKUP_FILES_DISABLED=${JSON.stringify(value)}`);
    }
  });

  test('neither variable is unconfigured', () => {
    assert.equal(fileBackupPolicy({}), 'unconfigured');
    assert.equal(fileBackupPolicy({ RESTIC_REPOSITORY: '' }), 'unconfigured');
  });
});

describe('the pre-flight (scripts/check-env.mjs) refuses a production start without file backups', () => {
  // A scratch cwd: @next/env loads .env from the working directory, and the
  // repo's own .env must not decide these tests.
  let scratch: string;
  before(() => { scratch = mkdtempSync(path.join(tmpdir(), 'backup-env-')); });
  after(() => { rmSync(scratch, { recursive: true, force: true }); });

  function preflight(extra: Record<string, string>, ...args: string[]) {
    const result = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'check-env.mjs'), ...args], {
      cwd: scratch,
      encoding: 'utf8',
      timeout: 30_000,
      // Built from scratch on purpose (never ...process.env). NODE_ENV as
      // `npm start` / `npm run dev` would have it.
      env: {
        NODE_ENV: args.includes('--dev') ? 'development' : 'production',
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: scratch,
        // Nothing listens on port 1: a fast, deterministic "cannot reach"
        // warning, which the pre-flight must print before it stops.
        DATABASE_URL: 'postgres://nobody@127.0.0.1:1/nothing',
        STORAGE_ROOT: scratch,
        ...extra,
      },
    });
    assert.equal(result.error, undefined, String(result.error));
    return result;
  }

  test('without RESTIC_REPOSITORY it stops, naming the fix, after every other diagnostic', () => {
    const r = preflight({});
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /RESTIC_REPOSITORY/);
    assert.match(r.stderr, /BACKUP_FILES_DISABLED=1/);
    // The database warning still comes first: the operator sees everything
    // that is wrong, then the stop.
    assert.match(r.stderr, /Cannot reach/);
  });

  test('BACKUP_FILES_DISABLED=1 is the explicit opt-out: it starts, and says file backups are off', () => {
    const r = preflight({ BACKUP_FILES_DISABLED: '1' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /switched off/);
  });

  test('with RESTIC_REPOSITORY it starts without a word about it', () => {
    const r = preflight({ RESTIC_REPOSITORY: '/repo' });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /RESTIC/);
  });

  test('--dev (npm run dev) warns instead of stopping', () => {
    const r = preflight({}, '--dev');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /RESTIC_REPOSITORY/);
  });
});
