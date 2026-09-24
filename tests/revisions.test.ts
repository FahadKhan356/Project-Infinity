/**
 * Revisions (brief §15, §16, §17) — Phase 1b, first piece.
 *
 * Sales opens a revision on delivered work; it reaches the right Team Lead
 * and nobody else's; the lead hands it to an Executive; the Executive's
 * upload answers it as a new version of the same slot; QA and delivery run
 * as before; Sales closes it. Throughout, the project status says
 * "revision required" and returns to following the work when it is done.
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
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run revision tests';

let sql: ReturnType<typeof postgres>;
let storageRoot: string;
let uploads: typeof import('../src/lib/files/uploads');
let createRevision: typeof import('../src/lib/revisions/revisions').createRevision;
let assignRevision: typeof import('../src/lib/revisions/revisions').assignRevision;
let closeRevision: typeof import('../src/lib/revisions/revisions').closeRevision;
let RevisionError: typeof import('../src/lib/revisions/revisions').RevisionError;
let revisionList: typeof import('../src/lib/revisions/queries').revisionList;
let loadRevision: typeof import('../src/lib/revisions/queries').loadRevision;
let reviewDeliverable: typeof import('../src/lib/qa/review').reviewDeliverable;
let deliveryQueue: typeof import('../src/lib/delivery/deliveries').deliveryQueue;
let updateDelivery: typeof import('../src/lib/delivery/deliveries').updateDelivery;
let loadWorkspace: typeof import('../src/lib/workspace/workspace').loadWorkspace;
let addComment: typeof import('../src/lib/workspace/comments').addComment;
let myWork: typeof import('../src/lib/workspace/my-work').myWork;

const ids: Record<string, number> = {};

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0, email: `${role}@m8test.local`, fullName: role, role,
    isActive: true, mustChangePassword: false,
    leadDepartmentIds: [], departmentIds: [], permissions: new Set<Permission>(), ...over,
  };
}
const sales = () => actor('sales', { id: ids.sales });
const otherSales = () => actor('sales', { id: ids.otherSales });
const pm = () => actor('project_manager', { id: ids.pm });
const leadVideo = () => actor('team_lead', { id: ids.leadVideo, leadDepartmentIds: [ids.video], departmentIds: [ids.video] });
const leadDesign = () => actor('team_lead', { id: ids.leadDesign, leadDepartmentIds: [ids.design], departmentIds: [ids.design] });
const ahmed = () => actor('executive', { id: ids.ahmed, departmentIds: [ids.video] });
const omar = () => actor('executive', { id: ids.omar, departmentIds: [ids.video] });
const sara = () => actor('executive', { id: ids.sara, departmentIds: [ids.design] });

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
const slotStatus = async (id: number) => (await sql`SELECT status FROM deliverables WHERE id = ${id}`)[0].status as string;
const projectStatus = async (id: number) => (await sql`SELECT status FROM projects WHERE id = ${id}`)[0].status as string;
const revisionStatus = async (id: number) => (await sql`SELECT status FROM revisions WHERE id = ${id}`)[0].status as string;

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE '%@m8test.local'`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM upload_sessions WHERE created_by IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'M8 Test%')`;
  await sql`DELETE FROM clients WHERE name LIKE 'M8 Test%'`;
  await sql`DELETE FROM files WHERE uploaded_by IN (${users})`;
  await sql`DELETE FROM department_members WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE '%@m8test.local'`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2093`;
}

before(async () => {
  if (skip) return;
  try { await setUp(); } catch (error) {
    console.error('\n[revisions.test] fixture setup failed:', error);
    throw error;
  }
});

async function setUp() {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'aktivacity-m8-'));
  process.env.STORAGE_ROOT = storageRoot;
  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });

  uploads = await import('../src/lib/files/uploads');
  ({ createRevision, assignRevision, closeRevision, RevisionError } = await import('../src/lib/revisions/revisions'));
  ({ revisionList, loadRevision } = await import('../src/lib/revisions/queries'));
  ({ reviewDeliverable } = await import('../src/lib/qa/review'));
  ({ deliveryQueue, updateDelivery } = await import('../src/lib/delivery/deliveries'));
  ({ loadWorkspace } = await import('../src/lib/workspace/workspace'));
  ({ addComment } = await import('../src/lib/workspace/comments'));
  ({ myWork } = await import('../src/lib/workspace/my-work'));
  const { fileProject } = await import('../src/lib/projects/file-project');
  const { triageProject } = await import('../src/lib/projects/triage');
  const { createAssignment } = await import('../src/lib/planning/assign');
  await purge();

  for (const slug of ['video', 'design']) {
    ids[slug] = Number((await sql`SELECT id FROM departments WHERE slug = ${slug}`)[0].id);
  }
  const mkUser = async (key: string, role: string) => {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES (${`${key}@m8test.local`}, 'x', ${key}, ${role}) RETURNING id`;
    ids[key] = Number(row.id);
  };
  for (const [k, r] of [
    ['sales', 'sales'], ['otherSales', 'sales'], ['pm', 'project_manager'],
    ['leadVideo', 'team_lead'], ['leadDesign', 'team_lead'],
    ['ahmed', 'executive'], ['omar', 'executive'], ['sara', 'executive'],
  ] as const) await mkUser(k, r);

  const member = (key: string, slug: string, isLead = false) =>
    sql`INSERT INTO department_members (user_id, department_id, is_lead) VALUES (${ids[key]}, ${ids[slug]}, ${isLead})`;
  await member('leadVideo', 'video', true);
  await member('leadDesign', 'design', true);
  await member('ahmed', 'video');
  await member('omar', 'video');
  await member('sara', 'design');

  const [client] = await sql<{ id: number }[]>`
    INSERT INTO clients (name, owner_user_id, created_by) VALUES ('M8 Test Client', ${ids.sales}, ${ids.sales}) RETURNING id`;
  ids.client = Number(client.id);

  // One delivered project: Video 01 (Ahmed) and Thumbnail 01 (Sara), no PM QA.
  const filed = await fileProject(sales(), {
    clientId: ids.client, period: '2093-09', title: 'Product launch film', requiresPmQa: false,
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
  [ids.thumb01] = d.deliverableIds;

  await upload(ahmed(), ids.video01, 'Film_v1.mp4');
  await upload(sara(), ids.thumb01, 'Thumb_v1.png');
  const a1 = await reviewDeliverable(leadVideo(), { deliverableId: ids.video01, decision: 'approved' });
  const a2 = await reviewDeliverable(leadDesign(), { deliverableId: ids.thumb01, decision: 'approved' });
  await updateDelivery(sales(), { deliveryId: a1.deliveryId!, status: 'delivered' });
  await updateDelivery(sales(), { deliveryId: a2.deliveryId!, status: 'delivered' });
  ids.video01Delivery = a1.deliveryId!;

  // A second project only Omar is on, so "another executive" exists on the Video team.
  const other = await fileProject(sales(), {
    clientId: ids.client, period: '2093-09', title: 'Omar only',
    departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
  });
  ids.otherProject = other.projectId;
  await triageProject(pm(), {
    projectId: ids.otherProject,
    teams: [{ departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 }],
  });
  const [otherTeam] = await sql<{ id: number }[]>`SELECT id FROM project_departments WHERE project_id = ${ids.otherProject}`;
  const o = await createAssignment(leadVideo(), {
    projectDepartmentId: Number(otherTeam.id), assigneeId: ids.omar, title: 'Other', deliverableCount: 1,
  });
  [ids.otherSlot] = o.deliverableIds;
}

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('opening a revision (brief §15)', { skip }, () => {
  test('the fixture is a delivered project', async () => {
    assert.equal(await projectStatus(ids.project), 'delivered');
    assert.equal(await slotStatus(ids.video01), 'delivered');
  });

  test('Sales opens revision #1 on Video 01; the slot, its delivery and the project all say so', async () => {
    const result = await createRevision(sales(), {
      projectId: ids.project,
      title: 'Opening scene and logo',
      clientFeedback: 'Please change the opening scene and update the logo placement.',
      details: 'Logo top-left, 3s opening.',
      priority: 'high',
      deadline: '2093-10-05',
      deliverableIds: [ids.video01],
    });
    ids.rev1 = result.revisionId;
    assert.equal(result.revisionNo, 1);
    assert.deepEqual(result.deliverableIds, [ids.video01]);

    assert.equal(await revisionStatus(ids.rev1), 'new');
    assert.equal(await slotStatus(ids.video01), 'changes_requested', 'the slot needs a new version');
    const [delivery] = await sql`SELECT status FROM deliveries WHERE id = ${ids.video01Delivery}`;
    assert.equal(delivery.status, 'revision_required', 'the delivery that came back says so (§14)');
    assert.equal(await projectStatus(ids.project), 'revision_required', '§18');
    assert.equal(await slotStatus(ids.thumb01), 'delivered', 'the untouched slot is untouched');
  });

  test('numbering is per project: the next one is #2', async () => {
    const result = await createRevision(sales(), {
      projectId: ids.project, title: 'Thumbnail colour', clientFeedback: 'Make it blue.',
      deliverableIds: [ids.thumb01],
    });
    ids.rev2 = result.revisionId;
    assert.equal(result.revisionNo, 2);
  });

  test('a Team Lead or an Executive cannot open one', async () => {
    for (const who of [leadVideo(), ahmed()]) {
      await assert.rejects(
        createRevision(who, { projectId: ids.project, title: 'Fix it', clientFeedback: 'x', deliverableIds: [ids.video01] }),
        /not permitted/,
      );
    }
  });

  test('a rep who cannot see the project gets "no such project"', async () => {
    await assert.rejects(
      createRevision(otherSales(), { projectId: ids.project, title: 'Fix it', clientFeedback: 'x', deliverableIds: [ids.video01] }),
      /No such project/,
    );
  });

  test('a deliverable from another project cannot be attached', async () => {
    await assert.rejects(
      createRevision(sales(), { projectId: ids.project, title: 'Fix it', clientFeedback: 'x', deliverableIds: [ids.otherSlot] }),
      /not on this project/,
    );
  });

  test('feedback and at least one deliverable are required', async () => {
    await assert.rejects(
      createRevision(sales(), { projectId: ids.project, title: 'Fix it', clientFeedback: '  ', deliverableIds: [ids.video01] }),
      RevisionError,
    );
    await assert.rejects(
      createRevision(sales(), { projectId: ids.project, title: 'Fix it', clientFeedback: 'x', deliverableIds: [] }),
      /at least one deliverable/,
    );
  });
});

describe('who sees a revision (brief §16)', { skip }, () => {
  const numbers = async (who: Actor) => (await revisionList(who)).filter((r) => r.projectId === ids.project).map((r) => r.revisionNo).sort();

  test('the Project Manager sees every revision', async () => {
    assert.deepEqual(await numbers(pm()), [1, 2]);
  });
  test('the Video lead sees the video one, the Design lead the design one', async () => {
    assert.deepEqual(await numbers(leadVideo()), [1]);
    assert.deepEqual(await numbers(leadDesign()), [2]);
  });
  test('an Executive sees the revisions on projects they are assigned to', async () => {
    assert.deepEqual(await numbers(ahmed()), [1, 2]);
    assert.deepEqual(await numbers(omar()), []);
  });
  test('Sales sees their client’s; another rep does not', async () => {
    assert.deepEqual(await numbers(sales()), [1, 2]);
    assert.deepEqual(await numbers(otherSales()), []);
  });
  test('opening one directly obeys the same rule', async () => {
    const mine = await loadRevision(leadVideo(), ids.rev1);
    assert.ok(mine);
    assert.equal(mine.title, 'Opening scene and logo');
    assert.equal(mine.clientFeedback, 'Please change the opening scene and update the logo placement.');
    assert.equal(mine.deliverables.length, 1);
    assert.equal(mine.deliverables[0].name, 'Video 01');
    assert.equal(mine.deliverables[0].department, 'Video');
    assert.equal(await loadRevision(leadDesign(), ids.rev1), null);
    assert.equal(await loadRevision(omar(), ids.rev1), null);
  });
  test('the workspace shows the open revision on its slot (brief §9)', async () => {
    const ws = await loadWorkspace(ahmed(), ids.project);
    const slot = ws!.teams.find((t) => t.department === 'Video')!.deliverables.find((d) => d.id === ids.video01)!;
    assert.ok(slot.openRevision);
    assert.equal(slot.openRevision.revisionNo, 1);
    assert.equal(slot.openRevision.clientFeedback, 'Please change the opening scene and update the logo placement.');
    assert.deepEqual(ws!.revisions.map((r) => r.revisionNo), [2, 1], 'newest first');
  });
});

describe('working the revision (brief §17)', { skip }, () => {
  test('the Team Lead hands the revision to a different Executive', async () => {
    const result = await assignRevision(leadVideo(), {
      revisionId: ids.rev1, deliverableId: ids.video01, assigneeId: ids.omar,
    });
    assert.equal(result.assigneeId, ids.omar);
    assert.equal(result.created, true, 'Omar had no open assignment on this team, so one was created');
    ids.omarAssignment = result.assignmentId;
    assert.equal(await revisionStatus(ids.rev1), 'assigned');

    const [slot] = await sql`SELECT assignment_id FROM deliverables WHERE id = ${ids.video01}`;
    assert.equal(Number(slot.assignment_id), ids.omarAssignment);
    const [asg] = await sql`SELECT title, priority, to_char(end_date, 'YYYY-MM-DD') AS end_date FROM assignments WHERE id = ${ids.omarAssignment}`;
    assert.match(asg.title, /Revision #1/);
    assert.equal(asg.priority, 'high');
    assert.equal(asg.end_date, '2093-10-05');

    const work = await myWork(omar());
    assert.ok(work.current.some((w) => w.assignmentId === ids.omarAssignment), 'it is on Omar’s desk');
    assert.ok(!(await myWork(ahmed())).current.some((w) => w.assignmentId === ids.ahmedAssignment && w.total > 0)
      || (await myWork(ahmed())).current.find((w) => w.assignmentId === ids.ahmedAssignment)!.total === 0,
      'and off Ahmed’s');
  });

  test('a lead cannot hand out another team’s slot, nor to someone outside the team', async () => {
    // The Design lead cannot even see the video revision (§16), so the answer
    // is the same as for a revision that does not exist.
    await assert.rejects(
      assignRevision(leadDesign(), { revisionId: ids.rev1, deliverableId: ids.video01, assigneeId: ids.omar }),
      /No such revision/,
    );
    await assert.rejects(
      assignRevision(leadVideo(), { revisionId: ids.rev1, deliverableId: ids.video01, assigneeId: ids.sara }),
      /not a member/,
    );
  });

  test('Omar’s upload answers the revision: v2 of the same slot, tagged with it', async () => {
    const result = await upload(omar(), ids.video01, 'Film_v2.mp4');
    assert.equal(result.versionNo, 2);
    const [version] = await sql`SELECT revision_id FROM deliverable_versions WHERE deliverable_id = ${ids.video01} AND is_current`;
    assert.equal(Number(version.revision_id), ids.rev1);
    assert.equal(await slotStatus(ids.video01), 'awaiting_lead_qa');
    assert.equal(await revisionStatus(ids.rev1), 'awaiting_qa');
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM deliverables WHERE project_id = ${ids.project}`;
    assert.equal(n, 2, 'still two slots');
  });

  test('a rejection in QA puts the revision back in progress; approval and delivery finish it', async () => {
    await reviewDeliverable(leadVideo(), { deliverableId: ids.video01, decision: 'changes_requested', comments: 'Logo still off.' });
    assert.equal(await revisionStatus(ids.rev1), 'in_progress');

    await upload(omar(), ids.video01, 'Film_v3.mp4');
    const approved = await reviewDeliverable(leadVideo(), { deliverableId: ids.video01, decision: 'approved' });
    assert.equal(approved.newStatus, 'approved');
    assert.equal(await revisionStatus(ids.rev1), 'approved');

    const queue = await deliveryQueue(sales());
    const rows = queue.filter((d) => d.deliverableId === ids.video01);
    assert.equal(rows.length, 1, 'only the newest delivery of a slot is in the queue');
    assert.equal(rows[0].versionNo, 3);
    assert.equal(rows[0].status, 'pending_delivery');

    await updateDelivery(sales(), { deliveryId: rows[0].deliveryId, status: 'delivered' });
    assert.equal(await revisionStatus(ids.rev1), 'delivered');
    assert.equal(await projectStatus(ids.project), 'revision_required', 'revision #2 is still open');
  });

  test('a revision can be discussed', async () => {
    const posted = await addComment(omar(), { revisionId: ids.rev1, body: 'Logo moved as asked.' });
    assert.equal(posted.projectId, ids.project);
    const detail = await loadRevision(sales(), ids.rev1);
    assert.ok(detail!.comments.some((c) => c.id === posted.commentId));
    // Sara is on the project, so she may read and discuss it; Omar's other
    // project gives him no standing here even though he holds the slot's work.
    await addComment(sara(), { revisionId: ids.rev1, body: 'Thumbnail unaffected.' });
    await assert.rejects(
      addComment(actor('executive', { id: ids.otherSales }), { revisionId: ids.rev1, body: 'Hi' }),
      /No such revision/,
    );
  });

  test('closing: Sales closes #1; cancelling #2 lets the project follow the work again', async () => {
    const closed = await closeRevision(sales(), { revisionId: ids.rev1, outcome: 'closed' });
    assert.equal(closed.status, 'closed');
    const [row] = await sql`SELECT closed_at FROM revisions WHERE id = ${ids.rev1}`;
    assert.ok(row.closed_at);

    await assert.rejects(closeRevision(leadVideo(), { revisionId: ids.rev2, outcome: 'cancelled' }), /not permitted/);
    await closeRevision(pm(), { revisionId: ids.rev2, outcome: 'cancelled' });
    assert.equal(await revisionStatus(ids.rev2), 'cancelled');
    assert.equal(await slotStatus(ids.thumb01), 'delivered', 'a cancelled revision gives the slot back its delivered state');
    assert.equal(await projectStatus(ids.project), 'delivered');
  });
});
