/**
 * QA verdicts, the delivery panel, revisions and file versioning
 * (brief §12–§19) — the gaps closed in the third pass, and the behaviours
 * that were built before but never asserted.
 *
 * A rejection is owed a reason; a change request is not. Every version
 * keeps every QA round and its uploader's note, on the workspace and on the
 * revision page. "Revision required" is a delivery status the revision sets
 * and the revision resolves — Sales cannot mark the old file delivered
 * again. Sales opens a revision with a comment and the client's reference
 * files in one step, and cannot end one in an archived month. Downloads
 * carry the version in the name. Revisions are numbered #01 everywhere.
 *
 * Needs DATABASE_URL pointing at a migrated database. Owns the year 2073,
 * the @w3qa.local users and the "W3 qa " clients.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
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
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run the QA and revision tests';

let sql: ReturnType<typeof postgres>;
let storageRoot: string;

let uploads: typeof import('../src/lib/files/uploads');
let access: typeof import('../src/lib/files/access');
let attachments: typeof import('../src/lib/files/attachments');
let deliveries: typeof import('../src/lib/delivery/deliveries');
let revisions: typeof import('../src/lib/revisions/revisions');
let lifecycle: typeof import('../src/lib/months/lifecycle');
let reviewDeliverable: typeof import('../src/lib/qa/review').reviewDeliverable;
let loadRevision: typeof import('../src/lib/revisions/queries').loadRevision;
let loadWorkspace: typeof import('../src/lib/workspace/workspace').loadWorkspace;
let fileProject: typeof import('../src/lib/projects/file-project').fileProject;
let triageProject: typeof import('../src/lib/projects/triage').triageProject;
let createAssignment: typeof import('../src/lib/planning/assign').createAssignment;
let changeProjectStatus: typeof import('../src/lib/projects/status').changeProjectStatus;

const ids: Record<string, number> = {};
const keys: Record<string, string> = {};
const codes: Record<string, string> = {};

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0, email: `${role}@w3qa.local`, fullName: role, role,
    isActive: true, mustChangePassword: false,
    leadDepartmentIds: [], departmentIds: [], permissions: new Set<Permission>(), ...over,
  };
}
const sales = () => actor('sales', { id: ids.sales });
const otherSales = () => actor('sales', { id: ids.otherSales });
const pm = () => actor('project_manager', { id: ids.pm });
const ceo = () => actor('ceo', { id: ids.ceo });
const leadVideo = () => actor('team_lead', { id: ids.leadVideo, leadDepartmentIds: [ids.video], departmentIds: [ids.video] });
const leadDesign = () => actor('team_lead', { id: ids.leadDesign, leadDepartmentIds: [ids.design], departmentIds: [ids.design] });
const ahmed = () => actor('executive', { id: ids.ahmed, departmentIds: [ids.video] });
const omar = () => actor('executive', { id: ids.omar, departmentIds: [ids.video] });
const nadia = () => actor('executive', { id: ids.nadia, departmentIds: [ids.video] });

const stream = (b: Buffer) =>
  new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(b)); c.close(); } });

async function upload(who: Actor, deliverableId: number, filename: string, extra: { notes?: string; mimeType?: string } = {}) {
  const b = randomBytes(512);
  const { session } = await uploads.createUploadSession(who, {
    target: 'deliverable', deliverableId, filename, size: b.length, notes: extra.notes ?? null, mimeType: extra.mimeType ?? null,
  });
  await uploads.appendChunk(who, session.id, 0, stream(b));
  return uploads.completeUpload(who, session.id);
}

async function attach(
  who: Actor, projectId: number, filename: string,
  parent: { assignmentId?: number; revisionId?: number; purpose?: string } = {},
) {
  const b = randomBytes(96);
  const { session } = await uploads.createUploadSession(who, {
    target: 'attachment', projectId, ...parent, filename, size: b.length,
  });
  await uploads.appendChunk(who, session.id, 0, stream(b));
  return uploads.completeUpload(who, session.id);
}

const slotStatus = async (id: number) => (await sql`SELECT status FROM deliverables WHERE id = ${id}`)[0].status as string;
const projectStatus = async (id: number) => (await sql`SELECT status FROM projects WHERE id = ${id}`)[0].status as string;
const revisionStatus = async (id: number) => (await sql`SELECT status FROM revisions WHERE id = ${id}`)[0].status as string;
const deliveryStatus = async (id: number) => (await sql`SELECT status FROM deliveries WHERE id = ${id}`)[0].status as string;
/** QA rounds recorded on a slot, or on one of its versions. */
async function rounds(deliverableId: number, versionNo?: number): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM qa_reviews q JOIN deliverable_versions v ON v.id = q.deliverable_version_id
    WHERE v.deliverable_id = ${deliverableId} AND ${versionNo === undefined ? sql`true` : sql`v.version_no = ${versionNo}`}`;
  return n;
}
/** Notices of one kind to one person about one thing (the October order in the fixture has its own). */
async function noticesOf(userId: number, type: string, entityId: number): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM notifications
    WHERE user_id = ${userId} AND type = ${type} AND entity_id = ${entityId}`;
  return n;
}
async function teamOf(projectId: number, slug: string) {
  return Number((await sql`SELECT id FROM project_departments WHERE project_id = ${projectId} AND department_id = ${ids[slug]}`)[0].id);
}

/**
 * Runs `fn` the way Next runs a route handler or a server action: inside a
 * request scope for `request`, so headers() and cookies() read it exactly
 * as in production. The scope is built with Next's own store factories
 * (next 16.3); revalidatePath() needs an incremental cache on the work
 * store, so a stub is supplied.
 */
async function inRequest<T>(request: NextRequest, fn: () => Promise<T>): Promise<T> {
  const requestStore = createRequestStoreForAPI(
    request, request.nextUrl, undefined as never, undefined, undefined as never, undefined,
  );
  const workStore = createWorkStore({
    page: '/test',
    renderOpts: { experimental: {}, supportsDynamicResponse: true, incrementalCache: {} } as never,
    buildId: 'test',
    deploymentId: 'test',
    previouslyRevalidatedTags: [],
  });
  return workUnitAsyncStorage.run(requestStore, () => workAsyncStorage.run(workStore, fn));
}

/**
 * The same, with a cookie that is a real session for `userId`, so the actor
 * is resolved by the data access layer exactly as in production.
 */
async function asUser<T>(userId: number, url: string, fn: (request: NextRequest) => Promise<T>): Promise<T> {
  const [session] = await sql<{ id: string }[]>`
    INSERT INTO sessions (user_id, expires_at) VALUES (${userId}, now() + interval '1 hour')
    RETURNING id::text AS id`;
  const request = new NextRequest(url, { headers: { cookie: `aktivacity_session=${session.id}` } });
  try {
    return await inRequest(request, () => fn(request));
  } finally {
    await sql`DELETE FROM sessions WHERE id = ${session.id}::uuid`;
  }
}

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE '%@w3qa.local'`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM notifications WHERE user_id IN (${users})`;
  await sql`DELETE FROM sessions WHERE user_id IN (${users})`;
  await sql`DELETE FROM upload_sessions WHERE created_by IN (${users})`;
  // The portal login points at the client, so it goes before the client does.
  await sql`DELETE FROM users WHERE email LIKE '%@w3qa.local' AND role = 'client'`;
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'W3 qa %')`;
  await sql`DELETE FROM clients WHERE name LIKE 'W3 qa %'`;
  await sql`DELETE FROM files WHERE uploaded_by IN (${users})`;
  await sql`DELETE FROM department_members WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE '%@w3qa.local'`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2073`;
}

before(async () => {
  if (skip) return;
  try { await setUp(); } catch (error) {
    // node:test can hang rather than report a rejected before() hook.
    console.error('\n[w3-qa.test] fixture setup failed:', error);
    throw error;
  }
});

async function setUp() {
  // Next compiles pages, actions and route handlers for its server layer,
  // where `next/navigation` is the react-server build (see next's
  // build/create-compiler-aliases.js). Plain Node has no such alias, so the
  // same substitution is made here before anything that redirects loads.
  const load = createRequire(__filename);
  const serverNavigation = load.resolve('next/dist/client/components/navigation.react-server');
  load(serverNavigation);
  load.cache[load.resolve('next/navigation')] = load.cache[serverNavigation];

  storageRoot = await mkdtemp(path.join(tmpdir(), 'aktivacity-w3qa-'));
  process.env.STORAGE_ROOT = storageRoot;
  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });

  uploads = await import('../src/lib/files/uploads');
  access = await import('../src/lib/files/access');
  attachments = await import('../src/lib/files/attachments');
  deliveries = await import('../src/lib/delivery/deliveries');
  revisions = await import('../src/lib/revisions/revisions');
  lifecycle = await import('../src/lib/months/lifecycle');
  ({ reviewDeliverable } = await import('../src/lib/qa/review'));
  ({ loadRevision } = await import('../src/lib/revisions/queries'));
  ({ loadWorkspace } = await import('../src/lib/workspace/workspace'));
  ({ fileProject } = await import('../src/lib/projects/file-project'));
  ({ triageProject } = await import('../src/lib/projects/triage'));
  ({ createAssignment } = await import('../src/lib/planning/assign'));
  ({ changeProjectStatus } = await import('../src/lib/projects/status'));
  await purge();

  for (const slug of ['video', 'design']) {
    ids[slug] = Number((await sql`SELECT id FROM departments WHERE slug = ${slug}`)[0].id);
  }
  for (const [key, role] of [
    ['sales', 'sales'], ['otherSales', 'sales'], ['pm', 'project_manager'], ['ceo', 'ceo'],
    ['leadVideo', 'team_lead'], ['leadDesign', 'team_lead'],
    ['ahmed', 'executive'], ['omar', 'executive'], ['nadia', 'executive'], ['sara', 'executive'],
  ] as const) {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role, must_change_password)
      VALUES (${`${key}@w3qa.local`}, 'x', ${key}, ${role}, false) RETURNING id`;
    ids[key] = Number(row.id);
  }
  for (const [key, slug, lead] of [
    ['leadVideo', 'video', true], ['leadDesign', 'design', true],
    ['ahmed', 'video', false], ['omar', 'video', false], ['nadia', 'video', false], ['sara', 'design', false],
  ] as const) {
    await sql`INSERT INTO department_members (user_id, department_id, is_lead) VALUES (${ids[key]}, ${ids[slug]}, ${lead})`;
  }
  const [client] = await sql<{ id: number }[]>`
    INSERT INTO clients (name, owner_user_id, created_by) VALUES ('W3 qa Client', ${ids.sales}, ${ids.sales}) RETURNING id`;
  ids.client = Number(client.id);
  // The client's portal login (§29): told of deliveries, and of nothing else here.
  const [portal] = await sql<{ id: number }[]>`
    INSERT INTO users (email, password_hash, full_name, role, client_id)
    VALUES ('portal@w3qa.local', 'x', 'portal', 'client', ${ids.client}) RETURNING id`;
  ids.portalLogin = Number(portal.id);

  // The main project: Video ×2 (Ahmed) needs PM QA, Design ×1 (Sara) does not (§13).
  const main = await fileProject(sales(), {
    clientId: ids.client, period: '2073-09', title: 'Autumn reel',
    departments: [
      { departmentId: ids.video, plannedDeliverables: 2 },
      { departmentId: ids.design, plannedDeliverables: 1 },
    ],
  });
  ids.project = main.projectId;
  codes.project = main.projectCode;
  await triageProject(pm(), {
    projectId: ids.project, requiresPmQa: true,
    teams: [
      { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 2 },
      { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 1 },
    ],
  });
  ids.videoTeam = await teamOf(ids.project, 'video');
  ids.designTeam = await teamOf(ids.project, 'design');
  await sql`UPDATE project_departments SET requires_pm_qa = false WHERE id = ${ids.designTeam}`;
  const videoWork = await createAssignment(leadVideo(), {
    projectDepartmentId: ids.videoTeam, assigneeId: ids.ahmed, title: 'Edit the cuts',
    deliverableCount: 2, deliverableBaseName: 'Video',
  });
  ids.ahmedAssignment = videoWork.assignmentId;
  [ids.video01, ids.video02] = videoWork.deliverableIds;
  const designWork = await createAssignment(leadDesign(), {
    projectDepartmentId: ids.designTeam, assigneeId: ids.sara, title: 'Thumbnail',
    deliverableCount: 1, deliverableBaseName: 'Thumb',
  });
  [ids.thumb01] = designWork.deliverableIds;

  // An October order, delivered, with a revision open on it — its month is
  // closed by hand below, which is how an archive comes to hold an open one.
  const october = await fileProject(sales(), {
    clientId: ids.client, period: '2073-10', title: 'October reel', requiresPmQa: false,
    departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
  });
  ids.octProject = october.projectId;
  ids.octMonth = october.clientMonthId;
  await triageProject(pm(), {
    projectId: ids.octProject,
    teams: [{ departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 }],
  });
  const reelWork = await createAssignment(leadVideo(), {
    projectDepartmentId: await teamOf(ids.octProject, 'video'), assigneeId: ids.ahmed, title: 'Reel',
    deliverableCount: 1, deliverableBaseName: 'Reel',
  });
  [ids.reel01] = reelWork.deliverableIds;
  await upload(ahmed(), ids.reel01, 'Reel.mp4');
  const reel = await reviewDeliverable(leadVideo(), { deliverableId: ids.reel01, decision: 'approved' });
  ids.reelDelivery = reel.deliveryId!;
  await deliveries.updateDelivery(sales(), { deliveryId: ids.reelDelivery, status: 'delivered' });
  ids.octRevision = (await revisions.createRevision(sales(), {
    projectId: ids.octProject, title: 'Shorter', clientFeedback: 'Shorter, please.', deliverableIds: [ids.reel01],
  })).revisionId;
  await sql`UPDATE client_months SET status = 'closed', closed_at = now(), closed_by = ${ids.pm} WHERE id = ${ids.octMonth}`;
}

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('a rejection is owed a reason; a change request is not (brief §12, §13)', { skip }, () => {
  test('a rejection without a comment is refused before anything is written', async () => {
    const v1 = await upload(ahmed(), ids.video01, 'Video_01.mp4', { mimeType: 'video/mp4' });
    ids.fileV1 = v1.fileId;
    keys.v1 = v1.storageKey;
    assert.equal(await slotStatus(ids.video01), 'awaiting_lead_qa');

    await assert.rejects(reviewDeliverable(leadVideo(), { deliverableId: ids.video01, decision: 'rejected' }), /Say why/);
    await assert.rejects(
      reviewDeliverable(leadVideo(), { deliverableId: ids.video01, decision: 'rejected', comments: '   ' }),
      /Say why/, 'blank counts as no reason',
    );
    assert.equal(await slotStatus(ids.video01), 'awaiting_lead_qa', 'still in the lead’s queue');
    assert.equal(await rounds(ids.video01), 0, 'no round was recorded');
    assert.equal(await noticesOf(ids.ahmed, 'qa.rejected', ids.video01), 0, 'and Ahmed heard nothing');
  });

  test('a change request without a comment goes through and sends the slot back', async () => {
    const result = await reviewDeliverable(leadVideo(), { deliverableId: ids.video01, decision: 'changes_requested' });
    assert.equal(result.stage, 'team_lead');
    assert.equal(result.roundNo, 1);
    assert.equal(result.newStatus, 'changes_requested');
    assert.equal(await slotStatus(ids.video01), 'changes_requested');
    const [row] = await sql`
      SELECT q.decision, q.comments FROM qa_reviews q JOIN deliverable_versions v ON v.id = q.deliverable_version_id
      WHERE v.deliverable_id = ${ids.video01}`;
    assert.deepEqual([row.decision, row.comments], ['changes_requested', null]);
    assert.equal(await noticesOf(ids.ahmed, 'qa.rejected', ids.video01), 1, 'Ahmed is told to upload a new version');
  });

  test('the same rule holds at the PM stage', async () => {
    const v2 = await upload(ahmed(), ids.video01, 'Video_01.mp4', { mimeType: 'video/mp4' });
    keys.v2 = v2.storageKey;
    const lead = await reviewDeliverable(leadVideo(), {
      deliverableId: ids.video01, decision: 'approved', comments: 'Cut is tight.',
    });
    assert.equal(lead.newStatus, 'awaiting_pm_qa', 'Video needs PM QA');

    await assert.rejects(reviewDeliverable(pm(), { deliverableId: ids.video01, decision: 'rejected' }), /Say why/);
    assert.equal(await slotStatus(ids.video01), 'awaiting_pm_qa', 'still with the PM');
    assert.equal(await rounds(ids.video01, 2), 1, 'only the lead’s round on v2');

    const rejected = await reviewDeliverable(pm(), {
      deliverableId: ids.video01, decision: 'rejected', comments: 'Wrong logo.',
    });
    assert.equal(rejected.stage, 'project_manager');
    assert.equal(rejected.newStatus, 'changes_requested');
    assert.equal(await rounds(ids.video01, 2), 2);
  });

  test('third time through: both approve, and a delivery waits for Sales', async () => {
    const v3 = await upload(ahmed(), ids.video01, 'Video_01.mp4', {
      mimeType: 'video/mp4', notes: 'Logo swapped for the new mark.',
    });
    keys.v3 = v3.storageKey;
    const lead = await reviewDeliverable(leadVideo(), { deliverableId: ids.video01, decision: 'approved', comments: 'Good to go.' });
    assert.equal(lead.newStatus, 'awaiting_pm_qa');
    const final = await reviewDeliverable(pm(), { deliverableId: ids.video01, decision: 'approved', comments: 'Approved for delivery.' });
    assert.equal(final.newStatus, 'approved');
    assert.ok(final.deliveryId, 'a deliveries row was opened');
    ids.video01Delivery = final.deliveryId!;
    assert.equal(await deliveryStatus(ids.video01Delivery), 'pending_delivery');
  });
});

describe('every version keeps its QA rounds and its note (brief §19)', { skip }, () => {
  const video01 = async (who: Actor) => {
    const ws = await loadWorkspace(who, ids.project);
    assert.ok(ws);
    return ws.teams.find((t) => t.department === 'Video')!.deliverables.find((d) => d.id === ids.video01)!;
  };

  test('the workspace lists every round per version, newest first, and the newest as the slot’s last review', async () => {
    const slot = await video01(ahmed());
    assert.deepEqual(
      slot.versions.map((v) => [v.versionNo, v.reviews.map((r) => [r.stage, r.decision, r.comments])]),
      [
        [3, [['project_manager', 'approved', 'Approved for delivery.'], ['team_lead', 'approved', 'Good to go.']]],
        [2, [['project_manager', 'rejected', 'Wrong logo.'], ['team_lead', 'approved', 'Cut is tight.']]],
        [1, [['team_lead', 'changes_requested', null]]],
      ],
    );
    assert.ok(slot.versions.every((v) => v.reviews.every((r) => r.versionNo === v.versionNo)), 'each round names its version');
    assert.ok(slot.versions.every((v) => v.reviews.every((r) => r.reviewer === (r.stage === 'team_lead' ? 'leadVideo' : 'pm'))));
    assert.equal(slot.currentVersion?.versionNo, 3);
    assert.equal(slot.currentVersion?.reviews.length, 2, 'the version under review carries both verdicts, not only the last');
    assert.equal(slot.currentVersion?.notes, 'Logo swapped for the new mark.');
    assert.deepEqual(
      [slot.lastReview?.stage, slot.lastReview?.decision, slot.lastReview?.versionNo, slot.lastReview?.reviewer, slot.lastReview?.comments],
      ['project_manager', 'approved', 3, 'pm', 'Approved for delivery.'],
    );
  });

  test('the uploader’s note travels with the version; an unreviewed version has no rounds', async () => {
    await upload(ahmed(), ids.video02, 'Video_02.mp4', { notes: 'Trimmed opening' });
    const ws = await loadWorkspace(leadVideo(), ids.project);
    const slot = ws!.teams.find((t) => t.department === 'Video')!.deliverables.find((d) => d.id === ids.video02)!;
    assert.equal(slot.status, 'awaiting_lead_qa');
    assert.equal(slot.currentVersion?.notes, 'Trimmed opening');
    assert.deepEqual(slot.currentVersion?.reviews, []);
    assert.equal(slot.lastReview, null);
  });

  test('an Executive on another project sees none of it', async () => {
    assert.equal(await loadWorkspace(omar(), ids.project), null);
    assert.equal(await loadWorkspace(nadia(), ids.project), null);
  });
});

describe('the Sales delivery panel (brief §14)', { skip }, () => {
  test('the allowed moves: revision required is neither entered nor left by hand', () => {
    assert.deepEqual(deliveries.DELIVERY_TRANSITIONS, {
      pending_delivery: ['delivered'],
      delivered: ['client_feedback_received', 'completed'],
      client_feedback_received: ['completed'],
      revision_required: [],
      completed: [],
    });
  });

  test('delivered, then client feedback: neither may be marked revision required', async () => {
    const { updateDelivery } = deliveries;
    await updateDelivery(sales(), { deliveryId: ids.video01Delivery, status: 'delivered', notes: 'Sent by WeTransfer.' });
    assert.equal(await slotStatus(ids.video01), 'delivered');
    assert.equal(await noticesOf(ids.portalLogin, 'portal.delivered', ids.project), 1, 'the client’s portal login hears of the delivery');

    await assert.rejects(
      updateDelivery(sales(), { deliveryId: ids.video01Delivery, status: 'revision_required' }),
      /cannot go from delivered to revision required/,
    );
    await updateDelivery(sales(), {
      deliveryId: ids.video01Delivery, status: 'client_feedback_received', clientFeedback: 'Love it, but the logo is too small.',
    });
    await assert.rejects(
      updateDelivery(sales(), { deliveryId: ids.video01Delivery, status: 'revision_required' }),
      /cannot go from client feedback received to revision required/,
    );
    const [row] = await sql`SELECT status, delivered_by, client_feedback FROM deliveries WHERE id = ${ids.video01Delivery}`;
    assert.deepEqual(
      [row.status, Number(row.delivered_by), row.client_feedback],
      ['client_feedback_received', ids.sales, 'Love it, but the logo is too small.'],
    );
  });

  test('the Project Manager reads the list but cannot mark it; another rep does not see it', async () => {
    const forPm = (await deliveries.deliveryQueue(pm())).find((d) => d.deliveryId === ids.video01Delivery);
    assert.ok(forPm, 'the PM sees the row');
    assert.equal(forPm.canUpdate, false);
    assert.deepEqual(
      forPm.qaApprovals.map((a) => [a.stage, a.reviewer, a.comments]),
      [['team_lead', 'leadVideo', 'Good to go.'], ['project_manager', 'pm', 'Approved for delivery.']],
      'with both sign-offs on v3',
    );
    await assert.rejects(
      deliveries.updateDelivery(pm(), { deliveryId: ids.video01Delivery, status: 'completed' }),
      /not permitted/,
    );
    assert.ok(!(await deliveries.deliveryQueue(otherSales())).some((d) => d.deliveryId === ids.video01Delivery));
  });
});

describe('opening a revision with a comment and the client’s files (brief §15)', { skip }, () => {
  test('Sales opens #01 with an internal comment; it is the first thing on the thread', async () => {
    const opened = await revisions.createRevision(sales(), {
      projectId: ids.project,
      title: 'Logo size',
      clientFeedback: 'Love it, but the logo is too small.',
      details: 'Scale the logo to 120% and keep the safe area.',
      priority: 'high',
      deadline: '2073-10-03',
      deliverableIds: [ids.video01],
      comment: '  The client is sensitive about the brand — check the guide before re-exporting.  ',
    });
    ids.rev1 = opened.revisionId;
    assert.equal(opened.revisionNo, 1);
    assert.equal(opened.projectStatus, 'revision_required');

    const detail = await loadRevision(sales(), ids.rev1);
    assert.ok(detail);
    assert.deepEqual(
      detail.comments.map((c) => [c.authorId, c.author, c.body]),
      [[ids.sales, 'sales', 'The client is sensitive about the brand — check the guide before re-exporting.']],
      'trimmed, by the opener',
    );
    const [row] = await sql`SELECT project_id, deliverable_id, assignment_id FROM comments WHERE revision_id = ${ids.rev1}`;
    assert.deepEqual([row.project_id, row.deliverable_id, row.assignment_id], [null, null, null], 'pinned to the revision alone');

    // The Video lead reads it with the revision; the Design lead has no part in it (§16).
    assert.equal((await loadRevision(leadVideo(), ids.rev1))?.comments.length, 1);
    assert.equal(await loadRevision(leadDesign(), ids.rev1), null);
    assert.equal(await loadRevision(omar(), ids.rev1), null, 'not yet handed to Omar');
    assert.equal(await noticesOf(ids.leadVideo, 'revision.created', ids.rev1), 1);
    assert.equal(await noticesOf(ids.ahmed, 'revision.created', ids.rev1), 1, 'the slot’s executive');
    assert.equal(await noticesOf(ids.pm, 'revision.created', ids.rev1), 1);
    assert.equal(await noticesOf(ids.leadDesign, 'revision.created', ids.rev1), 0);
    assert.equal(await noticesOf(ids.sales, 'revision.created', ids.rev1), 0, 'not the opener');
  });

  test('an over-long comment is refused before the revision exists; a blank one is no comment', async () => {
    const count = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM revisions WHERE project_id = ${ids.project}`)[0].n;
    const before = await count();
    await assert.rejects(
      revisions.createRevision(sales(), {
        projectId: ids.project, title: 'Too much', clientFeedback: 'x', deliverableIds: [ids.video01],
        comment: 'y'.repeat(4001),
      }),
      /under 4000 characters/,
    );
    assert.equal(await count(), before, 'nothing was opened');

    const form = new FormData();
    form.append('projectId', String(ids.project));
    form.append('title', 'Blank');
    form.append('clientFeedback', 'x');
    form.append('deliverableId', String(ids.video01));
    form.append('comment', '   ');
    assert.equal(revisions.parseRevisionForm(form).comment, null);
    form.set('comment', ' A note ');
    assert.equal(revisions.parseRevisionForm(form).comment, 'A note');
  });

  test('a reference file is pinned to the revision as a client reference', async () => {
    const done = await attach(sales(), ids.project, 'client-markup.png', { revisionId: ids.rev1, purpose: 'client_reference' });
    assert.equal(done.revisionNo, 1);
    ids.markupFile = done.fileId;
    keys.markup = done.storageKey;
    const [row] = await sql`SELECT purpose, project_id, assignment_id, revision_id FROM attachments WHERE file_id = ${done.fileId}`;
    assert.deepEqual([row.purpose, row.project_id, row.assignment_id, Number(row.revision_id)], ['client_reference', null, null, ids.rev1]);

    const listed = (await attachments.listProjectAttachments(sales(), ids.project)).find((a) => a.originalFilename === 'client-markup.png');
    assert.ok(listed);
    assert.equal(listed.purpose, 'client_reference');
    assert.deepEqual(listed.parent, { kind: 'revision', id: ids.rev1, revisionNo: 1, title: 'Logo size' });

    // The Design lead sees the project's files, not the video revision's markup, and cannot add to it.
    assert.ok(!(await attachments.listProjectAttachments(leadDesign(), ids.project)).some((a) => a.originalFilename === 'client-markup.png'));
    assert.equal((await access.canAttachToProject(leadDesign(), ids.project, { revisionId: ids.rev1 })).allowed, false);
    assert.equal((await access.canAttachToProject(ahmed(), ids.project, { revisionId: ids.rev1 })).allowed, true, 'the executive on it may');
  });

  test('the delivery it came back on says revision required, and stays so until the revision decides (§14, §17)', async () => {
    assert.equal(await deliveryStatus(ids.video01Delivery), 'revision_required');
    assert.equal(await slotStatus(ids.video01), 'changes_requested');
    assert.equal(await projectStatus(ids.project), 'revision_required');
    const [before] = await sql`SELECT delivered_at::text AS at FROM deliveries WHERE id = ${ids.video01Delivery}`;

    await assert.rejects(
      deliveries.updateDelivery(sales(), { deliveryId: ids.video01Delivery, status: 'delivered' }),
      /cannot go from revision required to delivered/,
    );
    await assert.rejects(
      deliveries.updateDelivery(sales(), { deliveryId: ids.video01Delivery, status: 'completed' }),
      /cannot go from revision required to completed/,
    );
    const [after] = await sql`SELECT status, delivered_at::text AS at FROM deliveries WHERE id = ${ids.video01Delivery}`;
    assert.deepEqual([after.status, after.at], ['revision_required', before.at], 'the record is untouched');
    assert.equal(await slotStatus(ids.video01), 'changes_requested');
    assert.equal(await revisionStatus(ids.rev1), 'new');
    assert.equal(await noticesOf(ids.portalLogin, 'portal.delivered', ids.project), 1, 'the client is not told about the old file again');

    const row = (await deliveries.deliveryQueue(sales())).find((d) => d.deliveryId === ids.video01Delivery);
    assert.ok(row, 'still listed, so Sales sees it is being revised');
    assert.equal(row.status, 'revision_required');
    assert.equal(row.canUpdate, true, 'theirs to mark — once there is a move to make');
    assert.deepEqual(deliveries.DELIVERY_TRANSITIONS[row.status], [], 'and the form offers none');
  });
});

describe('working the revision: QA per version on its page (brief §17, §19)', { skip }, () => {
  test('the Team Lead hands it to Omar; the assignment is titled as the client numbers it', async () => {
    const handed = await revisions.assignRevision(leadVideo(), {
      revisionId: ids.rev1, deliverableId: ids.video01, assigneeId: ids.omar,
    });
    assert.equal(handed.created, true, 'Omar had no open assignment on this team');
    ids.omarAssignment = handed.assignmentId;
    const [asg] = await sql`SELECT title FROM assignments WHERE id = ${ids.omarAssignment}`;
    assert.equal(asg.title, 'Revision #01: Logo size');
    assert.equal(await revisionStatus(ids.rev1), 'assigned');
    assert.ok(await loadRevision(omar(), ids.rev1), 'now on Omar’s desk');
    assert.equal(await loadRevision(nadia(), ids.rev1), null);
  });

  test('v4 is rejected by the PM after the lead approved it; v5 clears — the page shows every round, per version', async () => {
    const v4 = await upload(omar(), ids.video01, 'Video_01.mp4');
    assert.deepEqual([v4.versionNo, v4.revisionNo], [4, 1], 'the upload answers the revision');
    let detail = await loadRevision(pm(), ids.rev1);
    assert.deepEqual(detail!.versions.map((v) => [v.versionNo, v.isCurrent, v.reviews]), [[4, true, []]], 'awaiting QA');

    await reviewDeliverable(leadVideo(), { deliverableId: ids.video01, decision: 'approved' });
    await reviewDeliverable(pm(), { deliverableId: ids.video01, decision: 'rejected', comments: 'Grain in the dark scenes.' });
    assert.equal(await revisionStatus(ids.rev1), 'in_progress');

    await upload(omar(), ids.video01, 'Video_01.mp4');
    await reviewDeliverable(leadVideo(), { deliverableId: ids.video01, decision: 'approved', comments: 'Clean now.' });
    const cleared = await reviewDeliverable(pm(), { deliverableId: ids.video01, decision: 'approved' });
    ids.video01Delivery2 = cleared.deliveryId!;
    assert.equal(await revisionStatus(ids.rev1), 'approved');

    detail = await loadRevision(sales(), ids.rev1);
    assert.deepEqual(
      detail!.versions.map((v) => [
        v.versionNo, v.uploadedBy, v.isCurrent,
        v.reviews.map((r) => [r.stage, r.decision, r.reviewer, r.comments]),
      ]),
      [
        [5, 'omar', true, [['team_lead', 'approved', 'leadVideo', 'Clean now.'], ['project_manager', 'approved', 'pm', null]]],
        [4, 'omar', false, [['team_lead', 'approved', 'leadVideo', null], ['project_manager', 'rejected', 'pm', 'Grain in the dark scenes.']]],
      ],
      'newest version first; the rounds on each in the order they happened',
    );
    assert.ok(detail!.versions.every((v) => v.reviews.every((r) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(r.at))));

    // v1–v3 predate the revision: on the workspace, not on its page.
    const ws = await loadWorkspace(omar(), ids.project);
    const slot = ws!.teams.find((t) => t.department === 'Video')!.deliverables.find((d) => d.id === ids.video01)!;
    assert.deepEqual(slot.versions.map((v) => v.versionNo), [5, 4, 3, 2, 1]);
    assert.deepEqual(slot.versions[1].reviews.map((r) => [r.stage, r.decision]), [['project_manager', 'rejected'], ['team_lead', 'approved']]);
  });

  test('the reworked file arrives as a new delivery; the old one is history, and Sales closes the revision', async () => {
    const queued = (await deliveries.deliveryQueue(sales())).filter((d) => d.deliverableId === ids.video01);
    assert.equal(queued.length, 1, 'one row per slot');
    assert.equal(queued[0].deliveryId, ids.video01Delivery2);
    assert.deepEqual([queued[0].versionNo, queued[0].status], [5, 'pending_delivery']);
    assert.deepEqual(queued[0].qaApprovals.map((a) => [a.stage, a.comments]), [['team_lead', 'Clean now.'], ['project_manager', null]]);

    await deliveries.updateDelivery(sales(), { deliveryId: ids.video01Delivery2, status: 'delivered' });
    assert.equal(await revisionStatus(ids.rev1), 'delivered');
    assert.equal(await deliveryStatus(ids.video01Delivery), 'revision_required', 'the superseded delivery keeps its record');
    assert.equal(await noticesOf(ids.portalLogin, 'portal.delivered', ids.project), 2, 'the client hears of the reworked file');

    const closed = await revisions.closeRevision(sales(), { revisionId: ids.rev1, outcome: 'closed' });
    assert.equal(closed.status, 'closed');
    assert.equal(await slotStatus(ids.video01), 'delivered');
  });
});

describe('an archived month keeps its revisions as they are (brief §36)', { skip }, () => {
  const closed = /month is closed/;

  test('neither Sales nor the PM can close or cancel one, and nothing moves', async () => {
    assert.equal(await revisionStatus(ids.octRevision), 'new');
    for (const who of [sales(), pm()]) {
      for (const outcome of ['closed', 'cancelled'] as const) {
        await assert.rejects(revisions.closeRevision(who, { revisionId: ids.octRevision, outcome }), closed);
      }
    }
    const [rev] = await sql`SELECT status, closed_at FROM revisions WHERE id = ${ids.octRevision}`;
    assert.deepEqual([rev.status, rev.closed_at], ['new', null]);
    assert.equal(await slotStatus(ids.reel01), 'changes_requested');
    assert.equal(await deliveryStatus(ids.reelDelivery), 'revision_required');
    assert.equal(await projectStatus(ids.octProject), 'revision_required');
    assert.ok(await loadRevision(sales(), ids.octRevision), 'the archive is still there to be read');
  });

  test('once management reopens the month, cancelling it gives the slot back its delivered state', async () => {
    await lifecycle.reopenMonth(ceo(), { clientMonthId: ids.octMonth });
    const cancelled = await revisions.closeRevision(sales(), { revisionId: ids.octRevision, outcome: 'cancelled' });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.projectStatus, 'delivered');
    assert.equal(await slotStatus(ids.reel01), 'delivered');
    assert.equal(await deliveryStatus(ids.reelDelivery), 'delivered');
  });
});

describe('a revision ended gives back what it sent back (brief §14, §17, §18)', { skip }, () => {
  // Teaser 01 is delivered; the client comes back; Ahmed's rework is
  // rejected in QA — and then the client says the original is fine after all.
  let projectId: number;
  let slot: number;
  let delivery: number;
  let revisionId: number;
  let assignmentId: number;

  before(async () => {
    if (skip) return;
    const p = await fileProject(sales(), {
      clientId: ids.client, period: '2073-09', title: 'Teaser', requiresPmQa: false,
      departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
    });
    projectId = p.projectId;
    await triageProject(pm(), {
      projectId, teams: [{ departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 }],
    });
    const work = await createAssignment(leadVideo(), {
      projectDepartmentId: await teamOf(projectId, 'video'), assigneeId: ids.ahmed, title: 'Teaser cut',
      deliverableCount: 1, deliverableBaseName: 'Teaser',
    });
    [slot] = work.deliverableIds;
    assignmentId = work.assignmentId;
    await upload(ahmed(), slot, 'Teaser.mp4');
    delivery = (await reviewDeliverable(leadVideo(), { deliverableId: slot, decision: 'approved' })).deliveryId!;
    await deliveries.updateDelivery(sales(), { deliveryId: delivery, status: 'delivered' });
    revisionId = (await revisions.createRevision(sales(), {
      projectId, title: 'Shorter', clientFeedback: 'Cut it to fifteen seconds.', deliverableIds: [slot],
    })).revisionId;
  });

  test('a held project takes no references or hand-offs; the page reads the status the server checks (§18)', async () => {
    await changeProjectStatus(pm(), { projectId, change: 'hold', reason: 'Budget check' });
    const held = await loadRevision(leadVideo(), revisionId);
    assert.equal(held?.projectStatus, 'on_hold');
    assert.equal(held?.status, 'new', 'the revision itself stays open');
    assert.match((await access.canAttachToProject(sales(), projectId, { revisionId })).reason ?? '', /on hold/);
    await assert.rejects(
      revisions.assignRevision(leadVideo(), { revisionId, deliverableId: slot, assigneeId: ids.ahmed }),
      /on hold/,
    );

    await changeProjectStatus(pm(), { projectId, change: 'resume' });
    assert.equal((await loadRevision(leadVideo(), revisionId))?.projectStatus, 'revision_required');
    assert.equal((await access.canAttachToProject(sales(), projectId, { revisionId })).allowed, true);
  });

  test('the Team Lead records the rejection of the rework, in the shape the timeline reads (§12, §25)', async () => {
    const handed = await revisions.assignRevision(leadVideo(), { revisionId, deliverableId: slot, assigneeId: ids.ahmed });
    assert.equal(handed.assignmentId, assignmentId, 'his assignment reopened with the slot');
    await upload(ahmed(), slot, 'Teaser.mp4');
    await reviewDeliverable(leadVideo(), { deliverableId: slot, decision: 'rejected', comments: 'Lost the hook.' });
    assert.equal(await slotStatus(slot), 'changes_requested');
    assert.equal(await deliveryStatus(delivery), 'revision_required');
    assert.equal(await revisionStatus(revisionId), 'in_progress');

    // The library writes the record itself, inside its transaction.
    const [logged] = await sql`
      SELECT actor_id, entity_type, entity_id, project_id, metadata FROM activity_log
      WHERE action = 'qa.reviewed' AND entity_id = ${slot} ORDER BY id DESC LIMIT 1`;
    assert.deepEqual(
      [Number(logged.actor_id), logged.entity_type, Number(logged.entity_id), Number(logged.project_id), logged.metadata],
      [ids.leadVideo, 'deliverable', slot, projectId, {
        stage: 'team_lead', decision: 'rejected', roundNo: 1, deliverableName: 'Teaser 01', versionNo: 2,
        newStatus: 'changes_requested', deliveryId: null, projectStatus: 'revision_required',
      }],
    );
  });

  test('closed after the rejected rework, the delivered file stands and its delivery is back with Sales (§14)', async () => {
    const closed = await revisions.closeRevision(sales(), { revisionId, outcome: 'closed' });
    assert.equal(closed.projectStatus, 'delivered');
    assert.equal(await slotStatus(slot), 'delivered', 'v1 is what the client has');
    assert.equal(await deliveryStatus(delivery), 'delivered', 'no longer flagged for a revision that is over');
    const [asg] = await sql`SELECT status FROM assignments WHERE id = ${assignmentId}`;
    assert.equal(asg.status, 'completed', 'nothing left to redo');

    const row = (await deliveries.deliveryQueue(sales())).find((d) => d.deliveryId === delivery);
    assert.deepEqual([row?.status, row?.versionNo], ['delivered', 1]);
    assert.deepEqual(deliveries.DELIVERY_TRANSITIONS[row!.status], ['client_feedback_received', 'completed']);
    await deliveries.updateDelivery(sales(), { deliveryId: delivery, status: 'completed' });
    assert.equal(await projectStatus(projectId), 'completed');
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM deliveries WHERE project_id = ${projectId} AND status = 'revision_required'`;
    assert.equal(n, 0);
  });

  test('a completed project still takes a hand-off, but no more references; the page reads both rules (§18)', async () => {
    // The client comes back once more, and the rework is delivered and
    // completed before anyone closes the revision: it stands "delivered" on
    // a completed project. A hand-off is still accepted there, a reference
    // file is not, and the page offers exactly what the server takes.
    const again = (await revisions.createRevision(sales(), {
      projectId, title: 'Colour', clientFeedback: 'Warmer.', deliverableIds: [slot],
    })).revisionId;
    await upload(ahmed(), slot, 'Teaser.mp4');
    const redone = (await reviewDeliverable(leadVideo(), { deliverableId: slot, decision: 'approved' })).deliveryId!;
    await deliveries.updateDelivery(sales(), { deliveryId: redone, status: 'delivered' });
    await deliveries.updateDelivery(sales(), { deliveryId: redone, status: 'completed' });
    assert.equal(await projectStatus(projectId), 'completed');
    assert.equal(await revisionStatus(again), 'delivered');
    assert.equal((await loadRevision(leadVideo(), again))?.projectStatus, 'completed');

    assert.equal(revisions.reworkBlockedReason('completed'), null);
    assert.equal(revisions.reworkBlockedReason('revision_required'), null);
    assert.match(revisions.reworkBlockedReason('on_hold') ?? '', /on hold/);
    assert.match(revisions.reworkBlockedReason('cancelled') ?? '', /cancelled/);
    assert.equal(access.mayAttachToProject({ owned: true, monthOpen: true, status: 'completed' }), false);
    assert.match((await access.canAttachToProject(sales(), projectId, { revisionId: again })).reason ?? '', /completed/);
    const handed = await revisions.assignRevision(leadVideo(), { revisionId: again, deliverableId: slot, assigneeId: ids.omar });
    assert.equal(handed.assigneeId, ids.omar, 'the server takes the hand-off the page offers');

    await revisions.closeRevision(sales(), { revisionId: again, outcome: 'closed' });
    assert.equal(await projectStatus(projectId), 'completed');
  });
});

describe('the address a QA decision came from (brief §25)', { skip }, () => {
  // Behind a proxy, X-Forwarded-For is what the record has to go on — and
  // not every proxy writes an address there.
  let slot: number;

  before(async () => {
    if (skip) return;
    const p = await fileProject(sales(), {
      clientId: ids.client, period: '2073-09', title: 'Behind a proxy', requiresPmQa: false,
      departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
    });
    await triageProject(pm(), {
      projectId: p.projectId, teams: [{ departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 }],
    });
    [slot] = (await createAssignment(leadVideo(), {
      projectDepartmentId: await teamOf(p.projectId, 'video'), assigneeId: ids.ahmed, title: 'Cut',
      deliverableCount: 1, deliverableBaseName: 'Cut',
    })).deliverableIds;
  });

  test('the first hop, when it is an address; otherwise none', async () => {
    const { forwardedAddress } = await import('../src/lib/auth/audit');
    assert.equal(forwardedAddress('203.0.113.7, 10.0.0.1'), '203.0.113.7');
    assert.equal(forwardedAddress('2001:db8::1'), '2001:db8::1');
    assert.equal(forwardedAddress('203.0.113.7:4444'), '203.0.113.7', 'a proxy that writes the port');
    assert.equal(forwardedAddress('[2001:db8::1]:4444'), '2001:db8::1');
    assert.equal(forwardedAddress('fe80::1%lo0'), 'fe80::1', 'a zone id node accepts and inet refuses');
    assert.equal(forwardedAddress('[fe80::1%25eth0]:8080'), 'fe80::1');
    assert.equal(forwardedAddress('unknown'), null);
    assert.equal(forwardedAddress('203.0.113'), null);
    assert.equal(forwardedAddress(''), null);
    assert.equal(forwardedAddress(null), null);
  });

  test('a decision behind a proxy that writes "unknown" goes through, recorded without an address', async () => {
    await upload(ahmed(), slot, 'Cut.mp4');
    const request = new NextRequest('http://portal.test/qa', { headers: { 'x-forwarded-for': 'unknown' } });
    const sentBack = await inRequest(request, () =>
      reviewDeliverable(leadVideo(), { deliverableId: slot, decision: 'changes_requested', comments: 'Tighter.' }));
    assert.equal(sentBack.newStatus, 'changes_requested');
    assert.equal(await slotStatus(slot), 'changes_requested');
    const [logged] = await sql`
      SELECT host(ip_address) AS ip, metadata FROM activity_log
      WHERE action = 'qa.reviewed' AND entity_id = ${slot} ORDER BY id DESC LIMIT 1`;
    assert.equal(logged.ip, null);
    assert.equal(logged.metadata.decision, 'changes_requested');
  });

  test('one that writes the address with its port is recorded by the address', async () => {
    await upload(ahmed(), slot, 'Cut.mp4');
    const request = new NextRequest('http://portal.test/qa', { headers: { 'x-forwarded-for': '203.0.113.7:4444, 10.0.0.1' } });
    const approved = await inRequest(request, () => reviewDeliverable(leadVideo(), { deliverableId: slot, decision: 'approved' }));
    assert.ok(approved.deliveryId, 'a delivery waits for Sales');
    const [logged] = await sql`
      SELECT host(ip_address) AS ip FROM activity_log
      WHERE action = 'qa.reviewed' AND entity_id = ${slot} ORDER BY id DESC LIMIT 1`;
    assert.equal(logged.ip, '203.0.113.7');
  });
});

describe('names and numbers (brief §19, §25)', () => {
  test('a version downloads as name_vN.ext; attachments keep their name', async () => {
    const { downloadFilename } = await import('../src/lib/files/storage');
    assert.equal(downloadFilename('Video_Final.mp4', 2), 'Video_Final_v2.mp4');
    assert.equal(downloadFilename('Film_v2.mp4', 2), 'Film_v2.mp4', 'already says so');
    assert.equal(downloadFilename('Film-V2.MP4', 2), 'Film-V2.MP4', 'whatever the case or the dash');
    assert.equal(downloadFilename('Film_v2.mp4', 3), 'Film_v2_v3.mp4', 'a different number is not the same suffix');
    assert.equal(downloadFilename('README', 3), 'README_v3');
    assert.equal(downloadFilename('brand.guide.pdf', 1), 'brand.guide_v1.pdf');
    assert.equal(downloadFilename('.hidden', 1), '.hidden_v1', 'a leading dot is not an extension');
    assert.equal(downloadFilename('x.mp4', null), 'x.mp4');
    // With the project code (§24) it leads; a name already carrying it is not prefixed twice.
    assert.equal(downloadFilename('Video_Final.mp4', 2, 'AKT-2073-0001'), 'AKT-2073-0001_Video_Final_v2.mp4');
    assert.equal(downloadFilename('AKT-2073-0001_Video_Final_v2.mp4', 2, 'AKT-2073-0001'), 'AKT-2073-0001_Video_Final_v2.mp4');
    assert.equal(downloadFilename('brief.pdf', null, 'AKT-2073-0001'), 'AKT-2073-0001_brief.pdf');
  });

  test('activity lines number revisions as the client does', async () => {
    const { describeActivity } = await import('../src/lib/activity/describe');
    const say = (who: string, action: string, metadata: Record<string, unknown>) =>
      describeActivity({ action, actorName: who, metadata });
    assert.equal(say('sales', 'revision.created', { revisionNo: 1, title: 'Logo size' }), 'sales opened revision #01: Logo size');
    assert.equal(say('leadVideo', 'revision.assigned', { revisionNo: 1, deliverableName: 'Video 01', assigneeName: 'omar' }),
      'leadVideo assigned revision #01 (Video 01) to omar');
    assert.equal(say('omar', 'file.uploaded', { deliverableName: 'Video 01', versionNo: 4, revisionNo: 1 }),
      'omar uploaded Video 01 v4 for revision #01');
    assert.equal(say('sales', 'file.uploaded', { filename: 'client-markup.png', revisionNo: 1 }),
      'sales attached client-markup.png to revision #01');
    assert.equal(say('sales', 'revision.closed', { revisionNo: 1, status: 'closed' }), 'sales closed revision #01');
    assert.equal(say('pm', 'revision.closed', { revisionNo: 12, status: 'cancelled' }), 'pm cancelled revision #12');
    assert.equal(say('sales', 'revision.created', {}), 'sales opened revision', 'without a number, no tag');
  });

  test('the tag itself', async () => {
    const { revisionTag } = await import('../src/lib/revisions/revisions');
    assert.deepEqual([1, 3, 12, 100].map(revisionTag), ['#01', '#03', '#12', '#100']);
  });
});

describe('downloads carry the version in the name (brief §19, §43)', { skip }, () => {
  let route: typeof import('../src/app/api/files/[storageKey]/route');

  before(async () => {
    if (skip) return;
    route = await import('../src/app/api/files/[storageKey]/route');
  });

  const getAs = (userId: number, storageKey: string, query = '') =>
    asUser(userId, `http://portal.test/api/files/${storageKey}${query}`, (request) =>
      route.GET(request, { params: Promise.resolve({ storageKey }) }));

  test('the file context says which version a file is, and that an attachment is none', async () => {
    const version = await access.loadFileContext(keys.v1);
    assert.ok(version);
    assert.deepEqual(
      [version.fileId, version.deliverableId, version.versionNo, version.projectId, version.projectCode],
      [ids.fileV1, ids.video01, 1, ids.project, codes.project],
    );
    const markup = await access.loadFileContext(keys.markup);
    assert.ok(markup);
    assert.deepEqual(
      [markup.fileId, markup.deliverableId, markup.versionNo, markup.projectId, markup.projectCode],
      [ids.markupFile, null, null, ids.project, codes.project],
    );
  });

  test('a version downloads as <code>_Video_01_v1.mp4, attached or inline; an attachment keeps its name behind the code', async () => {
    // The project code leads the name (§24), then the version (§19).
    const named = (name: string) => `${codes.project}_${name}`;
    const disposition = (kind: 'attachment' | 'inline', name: string) =>
      `${kind}; filename="${named(name)}"; filename*=UTF-8''${encodeURIComponent(named(name))}`;

    const first = await getAs(ids.ahmed, keys.v1);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-disposition'), disposition('attachment', 'Video_01_v1.mp4'));
    assert.equal(first.headers.get('content-type'), 'video/mp4');
    assert.equal((await first.arrayBuffer()).byteLength, 512);

    const third = await getAs(ids.pm, keys.v3, '?inline=1');
    assert.equal(third.status, 200);
    assert.equal(third.headers.get('content-disposition'), disposition('inline', 'Video_01_v3.mp4'));
    assert.equal(third.headers.get('content-type'), 'video/mp4');
    await third.body?.cancel();

    const markup = await getAs(ids.sales, keys.markup, '?inline=1');
    assert.equal(markup.status, 200);
    assert.equal(markup.headers.get('content-disposition'), disposition('inline', 'client-markup.png'), 'no version on an attachment');
    assert.equal(markup.headers.get('content-type'), 'image/png');
    await markup.body?.cancel();

    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM activity_log
      WHERE action = 'file.downloaded' AND entity_id = ${ids.fileV1} AND actor_id = ${ids.ahmed}`;
    assert.equal(n, 1, 'every download is logged (§43)');
  });

  test('someone off the project gets 404, however exact the key', async () => {
    const denied = await getAs(ids.nadia, keys.v1);
    assert.equal(denied.status, 404);
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM activity_log
      WHERE action = 'file.download_denied' AND entity_id = ${ids.fileV1} AND actor_id = ${ids.nadia}`;
    assert.equal(n, 1);
  });
});

describe('the "Open revision" action (brief §15)', { skip }, () => {
  let actions: typeof import('../src/app/revisions/actions');

  before(async () => {
    if (skip) return;
    actions = await import('../src/app/revisions/actions');
  });

  function form(over: Record<string, string> = {}) {
    const data = new FormData();
    const fields: Record<string, string> = {
      projectId: String(ids.project), title: 'Colour pass', clientFeedback: 'A touch warmer.',
      details: '', priority: 'normal', deadline: '', deliverableId: String(ids.thumb01), ...over,
    };
    for (const [key, value] of Object.entries(fields)) data.append(key, value);
    return data;
  }
  const submit = (userId: number, data: FormData) =>
    asUser(userId, `http://portal.test/projects/${ids.project}/revisions/new`, () => actions.openRevision({}, data));

  test('with files still to attach, it answers with the new revision instead of redirecting', async () => {
    const result = await submit(ids.sales, form({ stayAfterCreate: '1', comment: 'Ask Design for the palette.' }));
    assert.deepEqual(Object.keys(result), ['createdRevision']);
    assert.equal(result.createdRevision?.projectId, ids.project);
    const revisionId = result.createdRevision!.revisionId;
    assert.ok(Number.isInteger(revisionId));

    const detail = await loadRevision(sales(), revisionId);
    assert.ok(detail);
    assert.equal(detail.revisionNo, 2, 'numbered after #01 on this project');
    assert.equal(detail.title, 'Colour pass');
    assert.deepEqual(detail.deliverables.map((d) => d.id), [ids.thumb01]);
    assert.deepEqual(detail.comments.map((c) => [c.author, c.body]), [['sales', 'Ask Design for the palette.']], 'the comment from the form');

    const [logged] = await sql`
      SELECT metadata FROM activity_log
      WHERE action = 'revision.created' AND entity_id = ${revisionId} AND actor_id = ${ids.sales}`;
    assert.equal(logged.metadata.revisionNo, 2, 'recorded for the feed (§25)');
    // Files can now be pinned to it, as the browser goes on to do.
    assert.equal((await access.canAttachToProject(sales(), ids.project, { revisionId })).allowed, true);
  });

  test('without files it redirects to the revision', async () => {
    await assert.rejects(
      submit(ids.sales, form({ title: 'Straight there' })),
      (error: Error & { digest?: string }) =>
        typeof error.digest === 'string' && error.digest.startsWith('NEXT_REDIRECT') && /;\/revisions\/\d+;/.test(error.digest),
    );
    const [rev] = await sql`SELECT revision_no, status FROM revisions WHERE project_id = ${ids.project} AND title = 'Straight there'`;
    assert.deepEqual([Number(rev.revision_no), rev.status], [3, 'new']);
  });

  test('a refusal comes back as a form error, not a redirect, and opens nothing', async () => {
    const count = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM revisions WHERE project_id = ${ids.project}`)[0].n;
    const before = await count();
    assert.deepEqual(await submit(ids.sales, form({ deliverableId: String(ids.reel01) })),
      { error: 'A deliverable you chose is not on this project.' });
    assert.deepEqual(await submit(ids.otherSales, form()), { error: 'No such project.' }, 'a rep on other clients');
    assert.deepEqual(await submit(ids.leadVideo, form()), { error: 'You are not permitted to open revisions.' });
    assert.equal(await count(), before);
  });
});
