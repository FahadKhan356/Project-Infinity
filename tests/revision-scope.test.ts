/**
 * Executive revision scope (brief §16, §23) — audit item A4.
 *
 * An Executive sees the revisions related to their current work: an open
 * assignment (planned, in progress or submitted) on the project, or a slot
 * of theirs the revision touches. Being on a project once is not enough —
 * a completed assignment on it no longer shows every later revision in the
 * list, on its page, in the dashboard count or through search, and the
 * notification goes to whoever holds the touched slot. History (§8) stays:
 * the project page and the month archive still list every revision on a
 * project the person may open, just without a link they could not follow.
 *
 * Needs DATABASE_URL pointing at a migrated database.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import postgres from 'postgres';
import type { Actor, Permission, Role } from '../src/lib/authz/types';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run revision scope tests';

const YEAR = 2062;
const PERIOD = { year: YEAR, month: 9 };

let sql: ReturnType<typeof postgres>;
let storageRoot: string;
let uploads: typeof import('../src/lib/files/uploads');
let createRevision: typeof import('../src/lib/revisions/revisions').createRevision;
let closeRevision: typeof import('../src/lib/revisions/revisions').closeRevision;
let revisionList: typeof import('../src/lib/revisions/queries').revisionList;
let loadRevision: typeof import('../src/lib/revisions/queries').loadRevision;
let loadWorkspace: typeof import('../src/lib/workspace/workspace').loadWorkspace;
let loadDashboard: typeof import('../src/lib/dashboard/dashboard').loadDashboard;
let searchProjects: typeof import('../src/lib/search/search').searchProjects;
let loadClientReport: typeof import('../src/lib/reports/monthly').loadClientReport;
let listProjectAttachments: typeof import('../src/lib/files/attachments').listProjectAttachments;
let createAssignment: typeof import('../src/lib/planning/assign').createAssignment;
let reviewDeliverable: typeof import('../src/lib/qa/review').reviewDeliverable;
let deliveryQueue: typeof import('../src/lib/delivery/deliveries').deliveryQueue;
let updateDelivery: typeof import('../src/lib/delivery/deliveries').updateDelivery;

const ids: Record<string, number> = {};

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0, email: `${role}@a4scope.local`, fullName: role, role,
    isActive: true, mustChangePassword: false,
    leadDepartmentIds: [], departmentIds: [], permissions: new Set<Permission>(), ...over,
  };
}
const sales = () => actor('sales', { id: ids.sales });
const pm = () => actor('project_manager', { id: ids.pm });
const leadVideo = () => actor('team_lead', { id: ids.leadVideo, leadDepartmentIds: [ids.video], departmentIds: [ids.video] });
const leadDesign = () => actor('team_lead', { id: ids.leadDesign, leadDepartmentIds: [ids.design], departmentIds: [ids.design] });
const ahmed = () => actor('executive', { id: ids.ahmed, departmentIds: [ids.video] });
const sara = () => actor('executive', { id: ids.sara, departmentIds: [ids.design] });
const omar = () => actor('executive', { id: ids.omar, departmentIds: [ids.video] });

function streamOf(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close(); },
  });
}
async function upload(who: Actor, deliverableId: number, filename: string) {
  const bytes = randomBytes(256);
  const { session } = await uploads.createUploadSession(who, {
    target: 'deliverable', deliverableId, filename, size: bytes.length,
  });
  await uploads.appendChunk(who, session.id, 0, streamOf(bytes));
  return uploads.completeUpload(who, session.id);
}
async function attach(who: Actor, projectId: number, filename: string, revisionId: number) {
  const bytes = randomBytes(64);
  const { session } = await uploads.createUploadSession(who, {
    target: 'attachment', projectId, revisionId, filename, size: bytes.length,
  });
  await uploads.appendChunk(who, session.id, 0, streamOf(bytes));
  return uploads.completeUpload(who, session.id);
}

const projectStatus = async (id: number) => (await sql`SELECT status FROM projects WHERE id = ${id}`)[0].status as string;
const assignmentStatus = async (id: number) => (await sql`SELECT status FROM assignments WHERE id = ${id}`)[0].status as string;
/** Revision numbers on P this person is shown, ascending. */
const numbers = async (who: Actor, includeClosed = false) =>
  (await revisionList(who, { includeClosed })).filter((r) => r.projectId === ids.project).map((r) => r.revisionNo).sort();
const received = async (userId: number) =>
  (await sql<{ type: string; title: string }[]>`
    SELECT type, title FROM notifications WHERE user_id = ${userId} AND type = 'revision.created' ORDER BY id`)
    .map((r) => ({ type: r.type, title: r.title }));

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE '%@a4scope.local'`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM upload_sessions WHERE created_by IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'A4 Scope %')`;
  await sql`DELETE FROM clients WHERE name LIKE 'A4 Scope %'`;
  await sql`DELETE FROM files WHERE uploaded_by IN (${users})`;
  await sql`DELETE FROM department_members WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE '%@a4scope.local'`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = ${YEAR}`;
}

before(async () => {
  if (skip) return;
  try { await setUp(); } catch (error) {
    console.error('\n[revision-scope.test] fixture setup failed:', error);
    throw error;
  }
});

async function setUp() {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'aktivacity-a4scope-'));
  process.env.STORAGE_ROOT = storageRoot;
  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });

  uploads = await import('../src/lib/files/uploads');
  ({ createRevision, closeRevision } = await import('../src/lib/revisions/revisions'));
  ({ revisionList, loadRevision } = await import('../src/lib/revisions/queries'));
  ({ loadWorkspace } = await import('../src/lib/workspace/workspace'));
  ({ loadDashboard } = await import('../src/lib/dashboard/dashboard'));
  ({ searchProjects } = await import('../src/lib/search/search'));
  ({ loadClientReport } = await import('../src/lib/reports/monthly'));
  ({ listProjectAttachments } = await import('../src/lib/files/attachments'));
  ({ createAssignment } = await import('../src/lib/planning/assign'));
  ({ reviewDeliverable } = await import('../src/lib/qa/review'));
  ({ deliveryQueue, updateDelivery } = await import('../src/lib/delivery/deliveries'));
  const { fileProject } = await import('../src/lib/projects/file-project');
  const { triageProject } = await import('../src/lib/projects/triage');
  await purge();

  for (const slug of ['video', 'design']) {
    ids[slug] = Number((await sql`SELECT id FROM departments WHERE slug = ${slug}`)[0].id);
  }
  const mkUser = async (key: string, role: string) => {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES (${`${key}@a4scope.local`}, 'x', ${key}, ${role}) RETURNING id`;
    ids[key] = Number(row.id);
  };
  for (const [k, r] of [
    ['sales', 'sales'], ['pm', 'project_manager'],
    ['leadVideo', 'team_lead'], ['leadDesign', 'team_lead'],
    ['ahmed', 'executive'], ['sara', 'executive'], ['omar', 'executive'],
  ] as const) await mkUser(k, r);

  const member = (key: string, slug: string, isLead = false) =>
    sql`INSERT INTO department_members (user_id, department_id, is_lead) VALUES (${ids[key]}, ${ids[slug]}, ${isLead})`;
  await member('leadVideo', 'video', true);
  await member('leadDesign', 'design', true);
  await member('ahmed', 'video');
  await member('omar', 'video');
  await member('sara', 'design');

  const [client] = await sql<{ id: number }[]>`
    INSERT INTO clients (name, owner_user_id, created_by) VALUES ('A4 Scope Client', ${ids.sales}, ${ids.sales}) RETURNING id`;
  ids.client = Number(client.id);

  // One project P: Video 01 (Ahmed) and Thumbnail 01 (Sara), no PM QA,
  // both uploaded, approved, delivered and completed — so P is completed
  // and both assignments are, too.
  const filed = await fileProject(sales(), {
    clientId: ids.client, period: `${YEAR}-09`, title: 'Scope film', requiresPmQa: false,
    departments: [
      { departmentId: ids.video, plannedDeliverables: 1 },
      { departmentId: ids.design, plannedDeliverables: 1 },
    ],
  });
  ids.project = filed.projectId;
  await triageProject(pm(), {
    projectId: ids.project,
    teams: [
      { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 },
      { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 1 },
    ],
  });
  for (const t of await sql<{ id: number; department_id: number }[]>`
      SELECT id, department_id FROM project_departments WHERE project_id = ${ids.project}`) {
    if (Number(t.department_id) === ids.video) ids.videoTeam = Number(t.id);
    if (Number(t.department_id) === ids.design) ids.designTeam = Number(t.id);
  }
  const v = await createAssignment(leadVideo(), {
    projectDepartmentId: ids.videoTeam, assigneeId: ids.ahmed, title: 'Cut the film',
    deliverableCount: 1, deliverableBaseName: 'Video',
  });
  ids.ahmedAssignment = v.assignmentId;
  [ids.video01] = v.deliverableIds;
  const d = await createAssignment(leadDesign(), {
    projectDepartmentId: ids.designTeam, assigneeId: ids.sara, title: 'Thumbnail',
    deliverableCount: 1, deliverableBaseName: 'Thumbnail',
  });
  ids.saraAssignment = d.assignmentId;
  [ids.thumb01] = d.deliverableIds;

  await upload(ahmed(), ids.video01, 'Film_v1.mp4');
  await upload(sara(), ids.thumb01, 'Thumb_v1.png');
  const a1 = await reviewDeliverable(leadVideo(), { deliverableId: ids.video01, decision: 'approved' });
  const a2 = await reviewDeliverable(leadDesign(), { deliverableId: ids.thumb01, decision: 'approved' });
  await updateDelivery(sales(), { deliveryId: a1.deliveryId!, status: 'delivered' });
  await updateDelivery(sales(), { deliveryId: a2.deliveryId!, status: 'delivered' });
  const open = (await deliveryQueue(sales())).filter((x) => x.projectId === ids.project);
  for (const x of open) await updateDelivery(sales(), { deliveryId: x.deliveryId, status: 'completed' });
}

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('the fixture', { skip }, () => {
  test('P is completed and both assignments are completed', async () => {
    assert.equal(await projectStatus(ids.project), 'completed');
    assert.equal(await assignmentStatus(ids.ahmedAssignment), 'completed');
    assert.equal(await assignmentStatus(ids.saraAssignment), 'completed');
    assert.deepEqual(await revisionList(ahmed()), []);
  });

  test('Sales opens R1 on Thumbnail 01: Sara’s assignment reopens, Ahmed’s stays completed, P is revision_required', async () => {
    const r1 = await createRevision(sales(), {
      projectId: ids.project, title: 'Thumbnail colour', clientFeedback: 'Make it blue.',
      deliverableIds: [ids.thumb01],
    });
    ids.rev1 = r1.revisionId;
    assert.equal(r1.revisionNo, 1);
    assert.equal(await projectStatus(ids.project), 'revision_required');
    assert.equal(await assignmentStatus(ids.saraAssignment), 'in_progress', 'the slot came back to her');
    assert.equal(await assignmentStatus(ids.ahmedAssignment), 'completed', 'his work is done and untouched');
    const [slot] = await sql`SELECT assignment_id FROM deliverables WHERE id = ${ids.thumb01}`;
    assert.equal(Number(slot.assignment_id), ids.saraAssignment, 'Sara holds the touched slot');
  });
});

describe('what an Executive sees of a revision (brief §16)', { skip }, () => {
  test('the list: Ahmed, completed on P, does not see R1; Sara does', async () => {
    assert.deepEqual(await numbers(ahmed()), []);
    assert.deepEqual(await numbers(sara()), [1]);
  });

  test('the revision page obeys the same rule', async () => {
    assert.equal(await loadRevision(ahmed(), ids.rev1), null);
    const hers = await loadRevision(sara(), ids.rev1);
    assert.ok(hers);
    assert.equal(hers.title, 'Thumbnail colour');
  });

  test('the dashboard count', async () => {
    // Exact counts are safe here: these executives’ scope is their own
    // assignments, all of which live in this suite.
    assert.equal((await loadDashboard(ahmed())).openRevisions, 0);
    assert.equal((await loadDashboard(sara())).openRevisions, 1);
  });

  test('search (§22): the text match, the open-revision filter and the count on the row', async () => {
    assert.deepEqual(await searchProjects(ahmed(), { q: 'Make it blue' }), []);
    const byTitle = await searchProjects(ahmed(), { q: 'Scope film' });
    assert.equal(byTitle.length, 1, 'the project itself is still his to find (§8)');
    assert.equal(byTitle[0].openRevisions, 0);
    assert.ok(!byTitle[0].matchedOn.includes('revision'));
    assert.deepEqual(await searchProjects(ahmed(), { openRevisions: true }), []);

    const hers = await searchProjects(sara(), { q: 'Make it blue' });
    assert.equal(hers.length, 1);
    assert.equal(hers[0].id, ids.project);
    assert.deepEqual(hers[0].matchedOn, ['revision']);
    assert.equal(hers[0].openRevisions, 1);
  });

  test('notifications go to whoever holds the touched slot — the same rule', async () => {
    assert.deepEqual(await received(ids.ahmed), []);
    const rows = await received(ids.sara);
    assert.equal(rows.length, 1);
    assert.match(rows[0].title, /Revision #01: Thumbnail colour/);
  });

  test('history stays intact (§8): the project page and the month archive still list R1', async () => {
    const his = (await loadWorkspace(ahmed(), ids.project))!;
    assert.deepEqual(his.revisions.map((r) => ({ revisionNo: r.revisionNo, canOpen: r.canOpen })),
      [{ revisionNo: 1, canOpen: false }], 'listed for reference, without a link he could not follow');
    const slot = his.teams.find((t) => t.department === 'Design')!.deliverables.find((d) => d.id === ids.thumb01)!;
    assert.ok(slot.openRevision);
    assert.equal(slot.openRevision.revisionNo, 1);
    assert.equal(slot.openRevision.canOpen, false);

    const hers = (await loadWorkspace(sara(), ids.project))!;
    assert.equal(hers.revisions[0].canOpen, true);
    const herSlot = hers.teams.find((t) => t.department === 'Design')!.deliverables.find((d) => d.id === ids.thumb01)!;
    assert.equal(herSlot.openRevision!.canOpen, true);

    // The month archive (§33) lists it too and, like the project page, links
    // only what /revisions/[id] would open.
    const report = (await loadClientReport(ahmed(), ids.client, PERIOD))!;
    assert.deepEqual(report.revisions.map((r) => ({ revisionNo: r.revisionNo, canOpen: r.canOpen })),
      [{ revisionNo: 1, canOpen: false }], 'the month archive is history (§33), without a dead link');
    const herReport = (await loadClientReport(sara(), ids.client, PERIOD))!;
    assert.deepEqual(herReport.revisions.map((r) => ({ revisionNo: r.revisionNo, canOpen: r.canOpen })),
      [{ revisionNo: 1, canOpen: true }]);

    // A reference attached to the revision is listed on that same page.
    await attach(sales(), ids.project, 'blue-swatch.png', ids.rev1);
    const refs = (await listProjectAttachments(ahmed(), ids.project)).filter((a) => a.parent.kind === 'revision');
    assert.deepEqual(refs.map((a) => a.originalFilename), ['blue-swatch.png']);
  });

  test('the PM and the leads are unchanged: the PM sees it, the Design lead sees it, the Video lead does not', async () => {
    assert.deepEqual(await numbers(pm()), [1]);
    assert.deepEqual(await numbers(leadDesign()), [1]);
    assert.deepEqual(await numbers(leadVideo()), []);
  });
});

describe('as the work moves on', { skip }, () => {
  test('closing R1: P is completed again; Ahmed still sees nothing; Sara keeps sight of the closed one on her slot', async () => {
    const closed = await closeRevision(sales(), { revisionId: ids.rev1, outcome: 'closed' });
    assert.equal(closed.projectStatus, 'completed');
    assert.equal(await assignmentStatus(ids.saraAssignment), 'completed');

    assert.deepEqual(await numbers(ahmed(), true), []);
    assert.deepEqual(await numbers(sara()), [], 'nothing open');
    assert.deepEqual(await numbers(sara(), true), [1], 'her slot was in it');
    assert.deepEqual((await loadWorkspace(ahmed(), ids.project))!.revisions.map((r) => r.revisionNo), [1]);
  });

  test('R2 on Video 01 makes Ahmed current again, and Sara is now the one outside it', async () => {
    const r2 = await createRevision(sales(), {
      projectId: ids.project, title: 'Sound mix', clientFeedback: 'The music is too loud.',
      deliverableIds: [ids.video01],
    });
    ids.rev2 = r2.revisionId;
    assert.equal(r2.revisionNo, 2);
    assert.equal(await assignmentStatus(ids.ahmedAssignment), 'in_progress');

    assert.deepEqual(await numbers(ahmed()), [2]);
    assert.deepEqual(await numbers(ahmed(), true), [1, 2], 'an open assignment on P shows every revision on it');
    assert.ok(await loadRevision(ahmed(), ids.rev2));
    const his = await received(ids.ahmed);
    assert.equal(his.length, 1);
    assert.match(his[0].title, /Revision #02: Sound mix/);

    assert.deepEqual(await numbers(sara()), []);
    assert.deepEqual(await numbers(sara(), true), [1]);
    assert.equal(await loadRevision(sara(), ids.rev2), null);
    assert.equal((await received(ids.sara)).length, 1, 'still only R1');
  });

  test('a planned assignment counts as current work', async () => {
    const extra = await createAssignment(leadVideo(), {
      projectDepartmentId: ids.videoTeam, assigneeId: ids.omar, title: 'Extra cut', deliverableCount: 1,
    });
    assert.equal(await assignmentStatus(extra.assignmentId), 'planned');
    assert.deepEqual(await numbers(omar(), true), [1, 2]);
    assert.ok(await loadRevision(omar(), ids.rev1));
    assert.equal((await loadDashboard(omar())).openRevisions, 1);
    assert.deepEqual(await received(ids.omar), [], 'he was not on it when they were opened');

    // Cancelled, that assignment is no longer current work and P's revisions
    // leave his list — under the project rule alone (any assignment, ever)
    // he would keep both. The project itself stays open to him (§8).
    await sql`UPDATE assignments SET status = 'cancelled' WHERE id = ${extra.assignmentId}`;
    assert.deepEqual(await numbers(omar(), true), []);
    assert.equal(await loadRevision(omar(), ids.rev1), null);
    assert.equal((await loadDashboard(omar())).openRevisions, 0);
    assert.deepEqual((await loadWorkspace(omar(), ids.project))!.revisions.map((r) => r.revisionNo), [2, 1]);
  });
});
