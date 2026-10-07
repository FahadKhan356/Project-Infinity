/**
 * The file layer end to end: resumable upload, interruption and resume,
 * checksum, versioning, who may read the bytes afterwards, and who may
 * delete them.
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
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
// First of the Next imports, as in Next's own server: it provides the
// AsyncLocalStorage that request scopes (cookies(), headers()) live in.
import 'next/dist/server/node-environment-baseline';
import { NextRequest } from 'next/server';
import { workAsyncStorage } from 'next/dist/server/app-render/work-async-storage.external';
import { workUnitAsyncStorage } from 'next/dist/server/app-render/work-unit-async-storage.external';
import { createRequestStoreForAPI } from 'next/dist/server/async-storage/request-store';
import { createWorkStore } from 'next/dist/server/async-storage/work-store';
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
let attachments: typeof import('../src/lib/files/attachments');
let route: typeof import('../src/app/api/files/[storageKey]/route');

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
  attachments = await import('../src/lib/files/attachments');

  // Next compiles route handlers for its server layer, where
  // `next/navigation` is the react-server build (see next's
  // build/create-compiler-aliases.js). Plain Node has no such alias, so the
  // same substitution is made here before the route loads.
  const load = createRequire(__filename);
  const serverNavigation = load.resolve('next/dist/client/components/navigation.react-server');
  load(serverNavigation);
  load.cache[load.resolve('next/navigation')] = load.cache[serverNavigation];
  route = await import('../src/app/api/files/[storageKey]/route');

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

/**
 * /api/files/:storageKey as `userId`, run the way Next runs it: inside a
 * request scope whose cookie is a real session, so the actor is resolved by
 * the data access layer exactly as in production. The scope is built with
 * Next's own store factories (next 16.3).
 */
async function requestAs(
  userId: number,
  storageKey: string,
  { method, query = '', headers = {} }: { method: 'GET' | 'DELETE'; query?: string; headers?: Record<string, string> },
): Promise<Response> {
  const [session] = await sql<{ id: string }[]>`
    INSERT INTO sessions (user_id, expires_at) VALUES (${userId}, now() + interval '1 hour')
    RETURNING id::text AS id`;
  const request = new NextRequest(`http://portal.test/api/files/${storageKey}${query}`, {
    method,
    headers: { cookie: `aktivacity_session=${session.id}`, ...headers },
  });
  const requestStore = createRequestStoreForAPI(
    request, request.nextUrl, undefined as never, undefined, undefined as never, undefined,
  );
  const workStore = createWorkStore({
    page: '/api/files/[storageKey]/route',
    renderOpts: { experimental: {}, supportsDynamicResponse: true } as never,
    buildId: 'test',
    deploymentId: 'test',
    previouslyRevalidatedTags: [],
  });
  const ctx = { params: Promise.resolve({ storageKey }) };
  try {
    return await workUnitAsyncStorage.run(requestStore, () =>
      workAsyncStorage.run(workStore, () =>
        method === 'DELETE' ? route.DELETE(request, ctx) : route.GET(request, ctx)));
  } finally {
    await sql`DELETE FROM sessions WHERE id = ${session.id}::uuid`;
  }
}

const deleteAs = (userId: number, storageKey: string) => requestAs(userId, storageKey, { method: 'DELETE' });
const getAs = (userId: number, storageKey: string, opts: { query?: string; headers?: Record<string, string> } = {}) =>
  requestAs(userId, storageKey, { method: 'GET', ...opts });

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

describe('a slot past QA does not take new versions (brief §12, §14, §19)', { skip }, () => {
  const ahmed = () => actor('executive', { id: ids.ahmed });
  const setSlot = (status: string) => sql`UPDATE deliverables SET status = ${status}::deliverable_status WHERE id = ${ids.deliverable}`;

  after(async () => { if (!skip) await setSlot('awaiting_lead_qa'); });

  test('while the Project Manager is reviewing, an upload would erase the lead’s sign-off', async () => {
    await setSlot('awaiting_pm_qa');
    const decision = await access.canUploadToDeliverable(ahmed(), ids.deliverable);
    assert.equal(decision.allowed, false);
    assert.match(decision.reason ?? '', /Project Manager/);
  });

  test('an approved deliverable needs a revision before it can be replaced', async () => {
    await setSlot('approved');
    const decision = await access.canUploadToDeliverable(ahmed(), ids.deliverable);
    assert.equal(decision.allowed, false);
    assert.match(decision.reason ?? '', /revision/i);
  });

  test('so does a delivered one', async () => {
    await setSlot('delivered');
    assert.equal((await access.canUploadToDeliverable(ahmed(), ids.deliverable)).allowed, false);
  });

  test('a slot sent back for changes takes the next version', async () => {
    await setSlot('changes_requested');
    assert.equal((await access.canUploadToDeliverable(ahmed(), ids.deliverable)).allowed, true);
  });

  test('an upload in flight is refused at completion if the slot was approved meanwhile', async () => {
    await setSlot('changes_requested');
    const bytes = randomBytes(1024);
    const { session } = await uploads.createUploadSession(ahmed(), {
      target: 'deliverable', deliverableId: ids.deliverable, filename: 'late.mp4', size: bytes.length,
    });
    await uploads.appendChunk(ahmed(), session.id, 0, streamOf(bytes));
    await setSlot('approved');
    await assert.rejects(uploads.completeUpload(ahmed(), session.id), /revision/i);
  });

  test('the pure rule the workspace button uses agrees', () => {
    assert.equal(access.uploadBlockedReason('pending'), null);
    assert.equal(access.uploadBlockedReason('awaiting_lead_qa'), null);
    assert.notEqual(access.uploadBlockedReason('awaiting_pm_qa'), null);
    assert.notEqual(access.uploadBlockedReason('approved'), null);
    assert.notEqual(access.uploadBlockedReason('delivered'), null);
    assert.notEqual(access.uploadBlockedReason('cancelled'), null);
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

describe('deleting a file (brief §36, §43)', { skip }, () => {
  before(async () => {
    if (skip) return;
    // The lead holds neither files.delete by role nor month.reopen: the
    // per-user grant is what lets them delete at all. Ahmed's row is one an
    // Executive cannot hold (brief §23), and must count for nothing.
    await sql`
      INSERT INTO user_permissions (user_id, permission, granted_by)
      VALUES (${ids.leadVideo}, 'delete_files', ${ids.pm}), (${ids.ahmed}, 'delete_files', ${ids.pm})`;
    // A session actor leads what department_members says, not what the
    // project row names; the fixture above only set the latter.
    await sql`
      INSERT INTO department_members (user_id, department_id, is_lead)
      VALUES (${ids.leadVideo}, ${ids.video}, true) ON CONFLICT DO NOTHING`;
    // Past the first-login password change, which the API would otherwise demand.
    await sql`UPDATE users SET must_change_password = false WHERE id IN (${ids.leadVideo}, ${ids.ahmed})`;
  });

  after(async () => {
    if (skip || !sql) return;
    await sql`DELETE FROM user_permissions WHERE user_id IN (${ids.leadVideo}, ${ids.ahmed})`;
    await sql`DELETE FROM department_members WHERE user_id = ${ids.leadVideo}`;
  });

  const isDeleted = async (fileId: number) =>
    (await sql`SELECT deleted_at IS NOT NULL AS deleted FROM files WHERE id = ${fileId}`)[0].deleted;

  test('a closed month refuses it, even to someone allowed to delete files', async () => {
    const { storageKey } = await fileContextFor(ids.fileV1);
    await sql`
      UPDATE client_months SET status = 'closed', closed_at = now(), closed_by = ${ids.pm}
      WHERE id = ${ids.month}`;
    try {
      const response = await deleteAs(ids.leadVideo, storageKey);
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /month is closed/);
      assert.equal(await isDeleted(ids.fileV1), false, 'the archive is unchanged');
      // Logged like every other refused delete.
      const [denied] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM activity_log
        WHERE actor_id = ${ids.leadVideo} AND action = 'file.delete_denied' AND entity_id = ${ids.fileV1}
          AND metadata->>'reason' = 'month_closed'`;
      assert.equal(denied.n, 1);
    } finally {
      await sql`
        UPDATE client_months SET status = 'open', closed_at = NULL, closed_by = NULL
        WHERE id = ${ids.month}`;
    }
  });

  test('a grant an Executive cannot hold counts for nothing (brief §23)', async () => {
    const { storageKey } = await fileContextFor(ids.fileV1);
    const response = await deleteAs(ids.ahmed, storageKey);
    assert.equal(response.status, 403);
    assert.equal(await isDeleted(ids.fileV1), false);
  });

  test('in an open month, on a visible project, it is a soft delete', async () => {
    const { storageKey } = await fileContextFor(ids.fileV1);
    try {
      const response = await deleteAs(ids.leadVideo, storageKey);
      assert.equal(response.status, 204);
      assert.equal(await isDeleted(ids.fileV1), true);
    } finally {
      await sql`UPDATE files SET deleted_at = NULL, deleted_by = NULL WHERE id = ${ids.fileV1}`;
    }
  });

  test('deleting it again keeps the record of who deleted it, and when', async () => {
    const { storageKey } = await fileContextFor(ids.fileV1);
    const [first] = await sql<{ at: string }[]>`
      UPDATE files SET deleted_at = now() - interval '1 day', deleted_by = ${ids.pm}
      WHERE id = ${ids.fileV1} RETURNING deleted_at::text AS at`;
    try {
      const response = await deleteAs(ids.leadVideo, storageKey);
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /already been deleted/);
      const [row] = await sql<{ by: number; at: string }[]>`
        SELECT deleted_by::int AS by, deleted_at::text AS at FROM files WHERE id = ${ids.fileV1}`;
      assert.deepEqual(row, { by: ids.pm, at: first.at });
    } finally {
      await sql`UPDATE files SET deleted_at = NULL, deleted_by = NULL WHERE id = ${ids.fileV1}`;
    }
  });
});

/**
 * Downloading is a right of its own (brief §43): the portal decides who may
 * keep a copy of a file separately from who may see it. A `no_download` row
 * withholds it from one account; viewing in place is untouched, and the
 * restriction is decided after visibility, so it reveals nothing about
 * files the account cannot see.
 */
describe('downloading is a right of its own (brief §43)', { skip }, () => {
  const sara = () => actor('executive', {
    id: ids.sara, departmentIds: [ids.design], permissions: new Set<Permission>(['no_download']),
  });
  let zipKey: string;

  before(async () => {
    if (skip) return;
    // Past the first-login password change, which the API would otherwise
    // refuse with a 403 of its own — the very status asserted below.
    await sql`UPDATE users SET must_change_password = false WHERE id IN (${ids.sara}, ${ids.ahmed})`;
    await sql`
      INSERT INTO user_permissions (user_id, permission, granted_by)
      VALUES (${ids.sara}, 'no_download', ${ids.pm})`;
    // Something with nothing to show inline: an archive on Sara's own slot.
    const bytes = randomBytes(256);
    const { session } = await uploads.createUploadSession(sara(), {
      target: 'deliverable', deliverableId: ids.designDeliverable,
      filename: 'thumbs.zip', size: bytes.length, mimeType: 'application/zip',
    });
    await uploads.appendChunk(sara(), session.id, 0, streamOf(bytes));
    const result = await uploads.completeUpload(sara(), session.id);
    ids.zipFile = result.fileId;
    zipKey = (await fileContextFor(result.fileId)).storageKey;
  });

  after(async () => {
    if (skip || !sql) return;
    await sql`DELETE FROM user_permissions WHERE user_id = ${ids.sara}`;
  });

  test('the rule: viewing stays, keeping a copy is withheld', async () => {
    const file = await fileContextFor(ids.fileV1);
    assert.deepEqual(await access.decideFileAccess(sara(), file, 'read'), { allowed: true });
    assert.deepEqual(await access.decideFileAccess(sara(), file), { allowed: true });
    assert.deepEqual(
      await access.decideFileAccess(sara(), file, 'download'),
      { allowed: false, reason: 'download_withheld' },
    );
  });

  test('decided last: a restricted user learns nothing about files they cannot see', async () => {
    const omar = actor('executive', { id: ids.omar, permissions: new Set<Permission>(['no_download']) });
    const file = await fileContextFor(ids.fileV1);
    assert.deepEqual(
      await access.decideFileAccess(omar, file, 'download'),
      { allowed: false, reason: 'out_of_scope' },
    );
  });

  test('GET without ?inline=1 is refused with 403, and the refusal is on the record', async () => {
    const { storageKey } = await fileContextFor(ids.fileV1);
    const response = await getAs(ids.sara, storageKey);
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.match(body.error, /download/i);
    assert.doesNotMatch(body.error, /password/i, 'refused for the right reason');
    const [denied] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM activity_log
      WHERE actor_id = ${ids.sara} AND action = 'file.download_denied' AND entity_id = ${ids.fileV1}
        AND metadata->>'reason' = 'download_withheld'`;
    assert.equal(denied.n, 1);
    const [served] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM activity_log
      WHERE actor_id = ${ids.sara} AND action = 'file.downloaded' AND entity_id = ${ids.fileV1}`;
    assert.equal(served.n, 0, 'nothing left the server');
  });

  test('inline viewing and scrubbing previews keep working', async () => {
    const { storageKey } = await fileContextFor(ids.fileV1);
    const response = await getAs(ids.sara, storageKey, { query: '?inline=1' });
    assert.equal(response.status, 200);
    assert.ok((response.headers.get('content-disposition') ?? '').startsWith('inline;'));
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    await response.arrayBuffer();
    const rows = await sql<{ inline: boolean }[]>`
      SELECT (metadata->>'inline')::boolean AS inline FROM activity_log
      WHERE actor_id = ${ids.sara} AND action = 'file.downloaded' AND entity_id = ${ids.fileV1}`;
    assert.deepEqual(rows.map((r) => r.inline), [true]);

    const partial = await getAs(ids.sara, storageKey, { query: '?inline=1', headers: { range: 'bytes=0-9' } });
    assert.equal(partial.status, 206);
    await partial.arrayBuffer();
  });

  test('a file with nothing to show inline is a download even with ?inline=1; colleagues are unaffected', async () => {
    const refused = await getAs(ids.sara, zipKey, { query: '?inline=1' });
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error, /download/i);

    const served = await getAs(ids.ahmed, zipKey);
    assert.equal(served.status, 200);
    assert.ok((served.headers.get('content-disposition') ?? '').startsWith('attachment;'));
    await served.arrayBuffer();
  });
});

/**
 * The purchase order is a document of its own (brief §3 "PO / project
 * requirements"): filed by Sales or the PM as kind 'po', always on the
 * project itself, and shown beside the PO reference rather than among the
 * references. Reading it follows the same project rule as every file.
 */
describe('the PO document (brief §3)', { skip }, () => {
  const pm = () => actor('project_manager', { id: ids.pm });

  async function attach(
    who: Actor, projectId: number, filename: string,
    parent: { assignmentId?: number; revisionId?: number; kind?: 'po' | 'reference' } = {},
  ) {
    const bytes = randomBytes(96);
    const { session } = await uploads.createUploadSession(who, {
      target: 'attachment', projectId, ...parent, filename, size: bytes.length,
    });
    await uploads.appendChunk(who, session.id, 0, streamOf(bytes));
    return { result: await uploads.completeUpload(who, session.id), sessionId: session.id };
  }

  test('Sales or the PM file the PO as its own kind, and it is listed as the PO', async () => {
    const { result, sessionId } = await attach(pm(), ids.project, 'PO-4411.pdf', { kind: 'po' });
    assert.equal(result.kind, 'po');
    ids.poFile = result.fileId;

    const [row] = await sql`
      SELECT kind, purpose, project_id::int AS project_id, assignment_id::int AS assignment_id
      FROM attachments WHERE file_id = ${result.fileId}`;
    assert.deepEqual([row.kind, row.purpose, row.project_id, row.assignment_id], ['po', 'po', ids.project, null]);

    const listed = (await attachments.listProjectAttachments(pm(), ids.project))
      .find((a) => a.originalFilename === 'PO-4411.pdf');
    assert.equal(listed?.kind, 'po');
    assert.deepEqual(listed?.parent, { kind: 'project' });

    // The session is the pending attachment: it carries the kind to completion.
    const [session] = await sql`SELECT kind FROM upload_sessions WHERE id = ${sessionId}::uuid`;
    assert.equal(session.kind, 'po');
  });

  test('the PO is served under the project rule like any attachment (access rules unchanged)', async () => {
    const file = await fileContextFor(ids.poFile);
    assert.equal(file.projectId, ids.project);
    assert.equal(file.versionNo, null);
    assert.equal(file.projectCode, 'M2T-0001');

    const sara = actor('executive', { id: ids.sara });
    assert.deepEqual(await access.decideFileAccess(sara, file), { allowed: true });
    const omar = actor('executive', { id: ids.omar });
    assert.deepEqual(await access.decideFileAccess(omar, file), { allowed: false, reason: 'out_of_scope' });
  });

  test('an executive cannot file the PO, and a PO cannot hang off an assignment or revision', async () => {
    const ahmed = actor('executive', { id: ids.ahmed, departmentIds: [ids.video] });
    const refused = await access.canAttachToProject(ahmed, ids.project, { kind: 'po' });
    assert.equal(refused.allowed, false);
    assert.match(refused.reason ?? '', /Sales or the Project Manager/);

    const misplaced = await access.canAttachToProject(pm(), ids.project, { assignmentId: ids.asgVideo, kind: 'po' });
    assert.equal(misplaced.allowed, false);
    assert.match(misplaced.reason ?? '', /belongs to the project/);

    // The database holds the line too, whatever code path writes the row.
    await assert.rejects(
      sql`INSERT INTO attachments (file_id, assignment_id, kind) VALUES (${ids.fileV1}, ${ids.asgVideo}, 'po')`,
      /attachments_po_on_project|check constraint/i,
    );
  });

  test('an attachment without a kind is a plain reference', async () => {
    const { result } = await attach(pm(), ids.project, 'brand-guide.pdf');
    assert.equal(result.kind, 'reference');
    const [row] = await sql`SELECT kind, purpose FROM attachments WHERE file_id = ${result.fileId}`;
    assert.deepEqual([row.kind, row.purpose], ['reference', 'reference']);
    const listed = (await attachments.listProjectAttachments(pm(), ids.project))
      .find((a) => a.originalFilename === 'brand-guide.pdf');
    assert.equal(listed?.kind, 'reference');
  });
});

/**
 * A row whose bytes are gone. The handler used to build the Response around
 * a stream that had not opened the file yet, so the ENOENT fired after the
 * status was already committed: Next logged "failed to pipe response", the
 * client got no HTTP status at all (browser: network error; curl: exit 52),
 * and the activity log claimed a download that never happened.
 */
describe('a row whose bytes are gone', { skip }, () => {
  const ahmed = () => actor('executive', { id: ids.ahmed, departmentIds: [ids.video] });
  let storageKey: string;
  let fileId: number;
  let storagePath: string;

  const served = async () => (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM activity_log
    WHERE actor_id = ${ids.ahmed} AND action = 'file.downloaded' AND entity_id = ${fileId}`)[0].n;
  const denied = async (reason: string) => (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM activity_log
    WHERE actor_id = ${ids.ahmed} AND action = 'file.download_denied' AND entity_id = ${fileId}
      AND metadata->>'reason' = ${reason}`)[0].n;

  before(async () => {
    if (skip) return;
    // Past the first-login password change, which the API would otherwise refuse.
    await sql`UPDATE users SET must_change_password = false WHERE id = ${ids.ahmed}`;
    // Something previewable, so ?inline=1 really takes the inline path.
    const bytes = randomBytes(64);
    const { session } = await uploads.createUploadSession(ahmed(), {
      target: 'attachment', projectId: ids.project,
      filename: 'frame.png', size: bytes.length, mimeType: 'image/png',
    });
    await uploads.appendChunk(ahmed(), session.id, 0, streamOf(bytes));
    const result = await uploads.completeUpload(ahmed(), session.id);
    fileId = result.fileId;
    storagePath = result.storagePath;
    storageKey = (await fileContextFor(fileId)).storageKey;
    // The row stays; the bytes go — a disk restored from an older backup.
    await rm(storage.absolutePath(storagePath));
  });

  test('a download answers 404 with a body, and nothing is recorded as served', async () => {
    const response = await getAs(ids.ahmed, storageKey);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Not found.' });
    assert.equal(await served(), 0, 'nothing left the server');
    assert.equal(await denied('missing_on_disk'), 1, 'the refusal is on the record');
  });

  test('so does viewing it inline', async () => {
    const response = await getAs(ids.ahmed, storageKey, { query: '?inline=1' });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Not found.' });
    assert.equal(await served(), 0, 'nothing left the server');
    assert.equal(await denied('missing_on_disk'), 2);
  });

  test('bytes the retention sweep removed are gone for good: 410', async () => {
    // The sweep leaves the row with an empty path (scripts/sweep-files.ts).
    await sql`UPDATE files SET storage_path = '' WHERE id = ${fileId}`;
    try {
      const response = await getAs(ids.ahmed, storageKey);
      assert.equal(response.status, 410);
      assert.match((await response.json()).error, /retention sweep/);
      assert.equal(await served(), 0, 'nothing left the server');
      assert.equal(await denied('purged'), 1);
    } finally {
      await sql`UPDATE files SET storage_path = ${storagePath} WHERE id = ${fileId}`;
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
