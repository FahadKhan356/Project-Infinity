/**
 * The file layer end to end: resumable upload, interruption and resume,
 * checksum, versioning, and who may read the bytes afterwards.
 *
 * Runs against a real PostgreSQL and a real filesystem, because the things
 * worth proving here — atomic promotion, positional chunk writes, project-
 * scoped access — only exist at that level.
 *
 * Needs DATABASE_URL pointing at a migrated database.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import postgres from 'postgres';
import type { Actor, Permission, Role } from '../src/lib/authz/types';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run the file layer tests';

const CHUNK = 4 * 1024 * 1024;
const TOTAL_CHUNKS = 3;

let sql: ReturnType<typeof postgres>;
let storageRoot: string;
let uploads: typeof import('../src/lib/files/uploads');
let access: typeof import('../src/lib/files/access');
let storage: typeof import('../src/lib/files/storage');

const ids: Record<string, number> = {};
let payload: Buffer;
let payloadDigest: string;

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0, email: `${role}@m2test.local`, fullName: role, role,
    isActive: true, mustChangePassword: false,
    leadDepartmentIds: [], departmentIds: [],
    permissions: new Set<Permission>(), ...over,
  };
}

/** A stream that delivers `bytes`, optionally failing partway to model a drop. */
function streamOf(bytes: Buffer, failAfter?: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (failAfter === undefined) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(bytes.subarray(0, failAfter)));
      controller.error(new Error('simulated network drop'));
    },
  });
}

before(async () => {
  if (skip) return;
  try {
    await setUp();
  } catch (error) {
    // node:test can hang rather than report a rejected before() hook.
    console.error('\n[files.test] fixture setup failed:', error);
    throw error;
  }
});

async function setUp() {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'aktivacity-m2-'));
  process.env.STORAGE_ROOT = storageRoot;

  uploads = await import('../src/lib/files/uploads');
  access = await import('../src/lib/files/access');
  storage = await import('../src/lib/files/storage');

  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });
  // Clear anything a previous interrupted run left behind, so the suite is
  // repeatable without manual cleanup.
  await purgeFixtures();

  const one = async (text: string) => (await sql.unsafe(text))[0] as Record<string, number>;
  const dept = async (slug: string) =>
    Number((await sql.unsafe(`SELECT id FROM departments WHERE slug='${slug}'`))[0].id);

  ids.video = await dept('video');
  ids.design = await dept('design');

  for (const [key, role] of [
    ['pm', 'project_manager'], ['ahmed', 'executive'],
    ['sara', 'executive'], ['omar', 'executive'], ['leadVideo', 'team_lead'],
  ] as const) {
    ids[key] = Number(
      (await one(`INSERT INTO users (email, password_hash, full_name, role)
                  VALUES ('${key}@m2test.local','x','${key}','${role}') RETURNING id`)).id,
    );
  }

  ids.client = Number((await one(
    `INSERT INTO clients (name, created_by) VALUES ('M2 Test Client', ${ids.pm}) RETURNING id`)).id);
  ids.month = Number((await one(
    `INSERT INTO client_months (client_id, period_year, period_month, created_by)
     VALUES (${ids.client}, 2026, 9, ${ids.pm}) RETURNING id`)).id);

  // One project spanning Video and Design — the shared workspace of §10.
  ids.project = Number((await one(
    `INSERT INTO projects (project_code, client_id, client_month_id, title, sales_owner_id, created_by)
     VALUES ('M2T-0001', ${ids.client}, ${ids.month}, 'Shared', ${ids.pm}, ${ids.pm}) RETURNING id`)).id);
  // A second project nobody in the first is assigned to.
  ids.otherProject = Number((await one(
    `INSERT INTO projects (project_code, client_id, client_month_id, title, sales_owner_id, created_by)
     VALUES ('M2T-0002', ${ids.client}, ${ids.month}, 'Other', ${ids.pm}, ${ids.pm}) RETURNING id`)).id);

  ids.pdVideo = Number((await one(
    `INSERT INTO project_departments (project_id, department_id, team_lead_id)
     VALUES (${ids.project}, ${ids.video}, ${ids.leadVideo}) RETURNING id`)).id);
  ids.pdDesign = Number((await one(
    `INSERT INTO project_departments (project_id, department_id)
     VALUES (${ids.project}, ${ids.design}) RETURNING id`)).id);
  ids.pdOther = Number((await one(
    `INSERT INTO project_departments (project_id, department_id)
     VALUES (${ids.otherProject}, ${ids.video}) RETURNING id`)).id);

  ids.asgVideo = Number((await one(
    `INSERT INTO assignments (project_department_id, project_id, assignee_id, assigned_by, title)
     VALUES (${ids.pdVideo}, ${ids.project}, ${ids.ahmed}, ${ids.pm}, 'Edit') RETURNING id`)).id);
  ids.asgDesign = Number((await one(
    `INSERT INTO assignments (project_department_id, project_id, assignee_id, assigned_by, title)
     VALUES (${ids.pdDesign}, ${ids.project}, ${ids.sara}, ${ids.pm}, 'Thumbnails') RETURNING id`)).id);
  ids.asgOther = Number((await one(
    `INSERT INTO assignments (project_department_id, project_id, assignee_id, assigned_by, title)
     VALUES (${ids.pdOther}, ${ids.otherProject}, ${ids.omar}, ${ids.pm}, 'Other work') RETURNING id`)).id);

  ids.deliverable = Number((await one(
    `INSERT INTO deliverables (project_id, project_department_id, assignment_id, sequence_no, name, created_by)
     VALUES (${ids.project}, ${ids.pdVideo}, ${ids.asgVideo}, 1, 'Video 01', ${ids.pm}) RETURNING id`)).id);
  ids.designDeliverable = Number((await one(
    `INSERT INTO deliverables (project_id, project_department_id, assignment_id, sequence_no, name, created_by)
     VALUES (${ids.project}, ${ids.pdDesign}, ${ids.asgDesign}, 1, 'Thumb 01', ${ids.pm}) RETURNING id`)).id);

  payload = randomBytes(CHUNK * TOTAL_CHUNKS);
  payloadDigest = createHash('sha256').update(payload).digest('hex');
}

/**
 * Order matters. `projects.client_id` deliberately does NOT cascade — a client
 * carrying years of history should not vanish because someone deleted a row
 * (brief §31, §47) — so projects are removed explicitly first. Everything
 * below a project does cascade.
 */
async function purgeFixtures() {
  const testUsers = sql`SELECT id FROM users WHERE email LIKE '%@m2test.local'`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${testUsers})`;
  await sql`DELETE FROM upload_sessions WHERE created_by IN (${testUsers})`;
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'M2 Test%')`;
  await sql`DELETE FROM clients WHERE name LIKE 'M2 Test%'`;
  await sql`DELETE FROM files WHERE uploaded_by IN (${testUsers})`;
  await sql`DELETE FROM users WHERE email LIKE '%@m2test.local'`;
}

after(async () => {
  if (skip || !sql) return;
  await purgeFixtures();
  await sql.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('resumable upload', { skip }, () => {
  test('survives a dropped connection and resumes from the recorded offset', async () => {
    const ahmed = actor('executive', { id: ids.ahmed, departmentIds: [ids.video] });

    const { session, chunkSize } = await uploads.createUploadSession(ahmed, {
      target: 'deliverable',
      deliverableId: ids.deliverable,
      filename: 'Video_01.mp4',
      size: payload.length,
      mimeType: 'video/mp4',
      checksum: payloadDigest,
    });
    assert.equal(chunkSize, 8 * 1024 * 1024);

    // Chunk 1 lands normally.
    let { offset } = await uploads.appendChunk(ahmed, session.id, 0, streamOf(payload.subarray(0, CHUNK)));
    assert.equal(offset, CHUNK);

    // Chunk 2 dies halfway through — the connection drops.
    await assert.rejects(
      uploads.appendChunk(
        ahmed, session.id, CHUNK,
        streamOf(payload.subarray(CHUNK, CHUNK * 2), CHUNK / 2),
      ),
      /simulated network drop/,
    );

    // The server still reports the last good offset, and the file on disk
    // matches it exactly — nothing partial is left behind.
    const resumed = await uploads.loadOwnSession(ahmed, session.id);
    assert.equal(resumed!.bytesReceived, CHUNK, 'offset must not advance on a failed chunk');
    assert.equal(
      await storage.fileSize(resumed!.tempPath), CHUNK,
      'on-disk length must equal the recorded offset',
    );

    // The client resumes and finishes.
    ({ offset } = await uploads.appendChunk(
      ahmed, session.id, CHUNK, streamOf(payload.subarray(CHUNK, CHUNK * 2)),
    ));
    assert.equal(offset, CHUNK * 2);
    ({ offset } = await uploads.appendChunk(
      ahmed, session.id, CHUNK * 2, streamOf(payload.subarray(CHUNK * 2)),
    ));
    assert.equal(offset, payload.length);

    const result = await uploads.completeUpload(ahmed, session.id);
    ids.fileV1 = result.fileId;

    assert.equal(result.versionNo, 1);
    assert.equal(result.sizeBytes, payload.length);
    assert.equal(result.checksum, payloadDigest, 'the stored bytes must hash to the original');

    const info = await stat(storage.absolutePath(result.storagePath));
    assert.equal(info.size, payload.length);
    assert.ok(
      result.storagePath.includes(`/deliverables/${ids.deliverable}/v1/`),
      `unexpected path: ${result.storagePath}`,
    );
    // The staging file is gone: promotion is a move, not a copy.
    assert.equal(await storage.fileSize(`tmp/${session.id}.part`).catch(() => -1), -1);
  });

  test('a mismatched offset is refused rather than silently appended', async () => {
    const ahmed = actor('executive', { id: ids.ahmed });
    const { session } = await uploads.createUploadSession(ahmed, {
      target: 'deliverable', deliverableId: ids.deliverable,
      filename: 'x.mp4', size: 1024,
    });
    await assert.rejects(
      uploads.appendChunk(ahmed, session.id, 512, streamOf(randomBytes(512))),
      /Offset mismatch/,
    );
    await uploads.abortUpload(ahmed, session.id);
  });

  test('a chunk longer than the declared size is refused', async () => {
    const ahmed = actor('executive', { id: ids.ahmed });
    const { session } = await uploads.createUploadSession(ahmed, {
      target: 'deliverable', deliverableId: ids.deliverable,
      filename: 'x.mp4', size: 100,
    });
    await assert.rejects(
      uploads.appendChunk(ahmed, session.id, 0, streamOf(randomBytes(500))),
      /exceeds the declared size/,
    );
    const after = await uploads.loadOwnSession(ahmed, session.id);
    assert.equal(after!.bytesReceived, 0);
    await uploads.abortUpload(ahmed, session.id);
  });

  test('a truncated upload cannot be completed', async () => {
    const ahmed = actor('executive', { id: ids.ahmed });
    const { session } = await uploads.createUploadSession(ahmed, {
      target: 'deliverable', deliverableId: ids.deliverable,
      filename: 'x.mp4', size: 2048,
    });
    await uploads.appendChunk(ahmed, session.id, 0, streamOf(randomBytes(1024)));
    await assert.rejects(uploads.completeUpload(ahmed, session.id), /Incomplete upload/);
    await uploads.abortUpload(ahmed, session.id);
  });

  test('bytes that do not match the declared checksum are rejected', async () => {
    const ahmed = actor('executive', { id: ids.ahmed });
    const { session } = await uploads.createUploadSession(ahmed, {
      target: 'deliverable', deliverableId: ids.deliverable,
      filename: 'x.mp4', size: 64,
      checksum: createHash('sha256').update('something else').digest('hex'),
    });
    await uploads.appendChunk(ahmed, session.id, 0, streamOf(randomBytes(64)));
    await assert.rejects(uploads.completeUpload(ahmed, session.id), /do not match the checksum/);
  });
});

describe('versioning (brief §7, §11, §19)', { skip }, () => {
  test('a second upload makes v2 of the same slot, not a second slot', async () => {
    const ahmed = actor('executive', { id: ids.ahmed });
    const bytes = randomBytes(2048);

    const { session } = await uploads.createUploadSession(ahmed, {
      target: 'deliverable', deliverableId: ids.deliverable,
      filename: 'Video_01.mp4', size: bytes.length,
    });
    await uploads.appendChunk(ahmed, session.id, 0, streamOf(bytes));
    const result = await uploads.completeUpload(ahmed, session.id);

    assert.equal(result.versionNo, 2);

    const slots = await sql`SELECT count(*)::int AS n FROM deliverables WHERE project_id = ${ids.project}`;
    assert.equal(slots[0].n, 2, 'still two slots: Video 01 and Thumb 01');

    const versions = await sql`
      SELECT version_no, is_current FROM deliverable_versions
      WHERE deliverable_id = ${ids.deliverable} ORDER BY version_no`;
    assert.deepEqual(
      versions.map((v) => [Number(v.version_no), v.is_current]),
      [[1, false], [2, true]],
      'exactly one version is current',
    );
  });

  test('an upload puts the slot back in the QA queue', async () => {
    const rows = await sql`SELECT status FROM deliverables WHERE id = ${ids.deliverable}`;
    assert.equal(rows[0].status, 'awaiting_lead_qa');
  });
});

describe('who may upload', { skip }, () => {
  test('the assignee may upload to their own slot', async () => {
    const ahmed = actor('executive', { id: ids.ahmed });
    const decision = await access.canUploadToDeliverable(ahmed, ids.deliverable);
    assert.equal(decision.allowed, true);
  });

  test('a colleague on the same project may NOT upload to another department’s slot', async () => {
    // Sara can see this project and read its files, but the Video slot is not
    // hers to file work against.
    const sara = actor('executive', { id: ids.sara });
    const decision = await access.canUploadToDeliverable(sara, ids.deliverable);
    assert.equal(decision.allowed, false);
    assert.match(decision.reason!, /not assigned to you/);
  });

  test('the Team Lead of that department may upload', async () => {
    const lead = actor('team_lead', { id: ids.leadVideo, leadDepartmentIds: [ids.video] });
    const decision = await access.canUploadToDeliverable(lead, ids.deliverable);
    assert.equal(decision.allowed, true);
  });

  test('someone outside the project cannot even learn the slot exists', async () => {
    const omar = actor('executive', { id: ids.omar });
    const decision = await access.canUploadToDeliverable(omar, ids.deliverable);
    assert.equal(decision.allowed, false);
    assert.match(decision.reason!, /No such deliverable/);
  });
});

describe('who may download (brief §10, §43)', { skip }, () => {
  test('the uploader can read their own file', async () => {
    const ahmed = actor('executive', { id: ids.ahmed });
    const file = await fileContextFor(ids.fileV1);
    assert.deepEqual(await access.decideFileAccess(ahmed, file), { allowed: true });
  });

  test('a different department on the same project can read it — the shared workspace', async () => {
    const sara = actor('executive', { id: ids.sara });
    const file = await fileContextFor(ids.fileV1);
    assert.deepEqual(await access.decideFileAccess(sara, file), { allowed: true });
  });

  test('an executive on another project cannot, even holding the exact key', async () => {
    const omar = actor('executive', { id: ids.omar });
    const file = await fileContextFor(ids.fileV1);
    assert.deepEqual(
      await access.decideFileAccess(omar, file),
      { allowed: false, reason: 'out_of_scope' },
    );
  });

  test('a deactivated user cannot, whatever their role', async () => {
    const pm = actor('project_manager', { id: ids.pm, isActive: false });
    const file = await fileContextFor(ids.fileV1);
    assert.equal((await access.decideFileAccess(pm, file)).allowed, false);
  });

  test('a soft-deleted file is invisible to ordinary users', async () => {
    await sql`UPDATE files SET deleted_at = now(), deleted_by = ${ids.pm} WHERE id = ${ids.fileV1}`;
    try {
      const file = await fileContextFor(ids.fileV1);
      const ahmed = actor('executive', { id: ids.ahmed });
      assert.deepEqual(
        await access.decideFileAccess(ahmed, file),
        { allowed: false, reason: 'deleted' },
      );

      // Someone who may delete files can still reach it, which is what makes
      // an accidental delete recoverable before the retention sweep.
      const admin = actor('admin', { id: ids.pm });
      assert.deepEqual(await access.decideFileAccess(admin, file), { allowed: true });
    } finally {
      await sql`UPDATE files SET deleted_at = NULL, deleted_by = NULL WHERE id = ${ids.fileV1}`;
    }
  });
});

async function fileContextFor(fileId: number) {
  const [row] = await sql<{ storage_key: string }[]>`
    SELECT storage_key::text AS storage_key FROM files WHERE id = ${fileId}`;
  const context = await access.loadFileContext(row.storage_key);
  assert.ok(context, `no context resolved for file ${fileId}`);
  return context;
}
