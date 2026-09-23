/**
 * QA and delivery (brief §12, §13, §14, §18, §25) — M7.
 *
 * The milestone criteria are the first suite: a deliverable rejected twice
 * still counts as one slot, and the activity feed for a project reads end to
 * end like the example in §25.
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
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run QA tests';

let sql: ReturnType<typeof postgres>;
let storageRoot: string;
let uploads: typeof import('../src/lib/files/uploads');
let reviewDeliverable: typeof import('../src/lib/qa/review').reviewDeliverable;
let QaError: typeof import('../src/lib/qa/review').QaError;
let qaQueue: typeof import('../src/lib/qa/queue').qaQueue;
let deliveryQueue: typeof import('../src/lib/delivery/deliveries').deliveryQueue;
let updateDelivery: typeof import('../src/lib/delivery/deliveries').updateDelivery;
let DeliveryError: typeof import('../src/lib/delivery/deliveries').DeliveryError;
let projectActivity: typeof import('../src/lib/activity/feed').projectActivity;
let loadWorkspace: typeof import('../src/lib/workspace/workspace').loadWorkspace;
let myWork: typeof import('../src/lib/workspace/my-work').myWork;

const ids: Record<string, number> = {};

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0, email: `${role}@m7test.local`, fullName: role, role,
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
const sara = () => actor('executive', { id: ids.sara, departmentIds: [ids.design] });

function streamOf(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

async function upload(who: Actor, deliverableId: number, filename: string) {
  const bytes = randomBytes(512);
  const { session } = await uploads.createUploadSession(who, {
    target: 'deliverable', deliverableId, filename, size: bytes.length,
  });
  await uploads.appendChunk(who, session.id, 0, streamOf(bytes));
  return uploads.completeUpload(who, session.id);
}

async function slotStatus(id: number) {
  return (await sql`SELECT status FROM deliverables WHERE id = ${id}`)[0].status as string;
}
async function projectStatus(id: number) {
  return (await sql`SELECT status FROM projects WHERE id = ${id}`)[0].status as string;
}

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE '%@m7test.local'`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM upload_sessions WHERE created_by IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'M7 Test%')`;
  await sql`DELETE FROM clients WHERE name LIKE 'M7 Test%'`;
  await sql`DELETE FROM files WHERE uploaded_by IN (${users})`;
  await sql`DELETE FROM department_members WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE '%@m7test.local'`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2094`;
}

before(async () => {
  if (skip) return;
  try {
    await setUp();
  } catch (error) {
    console.error('\n[qa.test] fixture setup failed:', error);
    throw error;
  }
});

async function setUp() {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'aktivacity-m7-'));
  process.env.STORAGE_ROOT = storageRoot;

  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });
  uploads = await import('../src/lib/files/uploads');
  ({ reviewDeliverable, QaError } = await import('../src/lib/qa/review'));
  ({ qaQueue } = await import('../src/lib/qa/queue'));
  ({ deliveryQueue, updateDelivery, DeliveryError } = await import('../src/lib/delivery/deliveries'));
  ({ projectActivity } = await import('../src/lib/activity/feed'));
  ({ loadWorkspace } = await import('../src/lib/workspace/workspace'));
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
      VALUES (${`${key}@m7test.local`}, 'x', ${key}, ${role}) RETURNING id`;
    ids[key] = Number(row.id);
  };
  await mkUser('sales', 'sales');
  await mkUser('otherSales', 'sales');
  await mkUser('pm', 'project_manager');
  await mkUser('leadVideo', 'team_lead');
  await mkUser('leadDesign', 'team_lead');
  await mkUser('ahmed', 'executive');
  await mkUser('sara', 'executive');

  const member = async (key: string, slug: string, isLead = false) =>
    sql`INSERT INTO department_members (user_id, department_id, is_lead)
        VALUES (${ids[key]}, ${ids[slug]}, ${isLead})`;
  await member('leadVideo', 'video', true);
  await member('leadDesign', 'design', true);
  await member('ahmed', 'video');
  await member('sara', 'design');

  const [client] = await sql<{ id: number }[]>`
    INSERT INTO clients (name, owner_user_id, created_by)
    VALUES ('M7 Test Client', ${ids.sales}, ${ids.sales}) RETURNING id`;
  ids.client = Number(client.id);

  // Main project: Video needs PM QA, Design does not (§13: configurable).
  const main = await fileProject(sales(), {
    clientId: ids.client, period: '2094-09', title: 'ABC social media videos',
    departments: [
      { departmentId: ids.video, plannedDeliverables: 2 },
      { departmentId: ids.design, plannedDeliverables: 1 },
    ],
  });
  ids.project = main.projectId;
  await triageProject(pm(), {
    projectId: ids.project, requiresPmQa: true,
    teams: [
      { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 2 },
      { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 1 },
    ],
  });
  for (const t of await sql<{ id: number; department_id: number }[]>`
      SELECT id, department_id FROM project_departments WHERE project_id = ${ids.project}`) {
    if (Number(t.department_id) === ids.video) ids.videoTeam = Number(t.id);
    if (Number(t.department_id) === ids.design) ids.designTeam = Number(t.id);
  }
  await sql`UPDATE project_departments SET requires_pm_qa = false WHERE id = ${ids.designTeam}`;

  const videoWork = await createAssignment(leadVideo(), {
    projectDepartmentId: ids.videoTeam, assigneeId: ids.ahmed, title: 'Edit the cuts',
    deliverableCount: 2, deliverableBaseName: 'Video',
  });
  ids.ahmedAssignment = videoWork.assignmentId;
  [ids.video01, ids.video02] = videoWork.deliverableIds;

  const designWork = await createAssignment(leadDesign(), {
    projectDepartmentId: ids.designTeam, assigneeId: ids.sara, title: 'Thumbnail',
    deliverableCount: 1, deliverableBaseName: 'Thumbnail',
  });
  [ids.thumb01] = designWork.deliverableIds;

  // Solo project: one Video slot, no PM QA, to walk the project status to completed.
  const solo = await fileProject(sales(), {
    clientId: ids.client, period: '2094-09', title: 'One-off reel', requiresPmQa: false,
    departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
  });
  ids.soloProject = solo.projectId;
  await triageProject(pm(), {
    projectId: ids.soloProject,
    teams: [{ departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 }],
  });
  const [soloTeam] = await sql<{ id: number }[]>`
    SELECT id FROM project_departments WHERE project_id = ${ids.soloProject}`;
  const soloWork = await createAssignment(leadVideo(), {
    projectDepartmentId: Number(soloTeam.id), assigneeId: ids.ahmed, title: 'Reel',
    deliverableCount: 1, deliverableBaseName: 'Reel',
  });
  [ids.reel01] = soloWork.deliverableIds;
}

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('the milestone criterion: rejected twice, still one slot', { skip }, () => {
  test('an uploaded version lands in its Team Lead’s queue and nobody else’s', async () => {
    await upload(ahmed(), ids.video01, 'Video_01_v1.mp4');

    const mine = await qaQueue(leadVideo());
    const item = mine.find((i) => i.deliverableId === ids.video01);
    assert.ok(item, 'the Video lead sees Video 01');
    assert.equal(item.stage, 'team_lead');
    assert.equal(item.versionNo, 1);
    assert.equal(item.assignee, 'ahmed');
    assert.equal(item.originalFilename, 'Video_01_v1.mp4');

    const theirs = await qaQueue(leadDesign());
    assert.ok(!theirs.some((i) => i.deliverableId === ids.video01), 'the Design lead does not');

    const pms = await qaQueue(pm());
    assert.ok(!pms.some((i) => i.deliverableId === ids.video01), 'not yet the PM’s turn');
  });

  test('the Team Lead requests changes — the slot goes back to the Executive with the comment', async () => {
    const result = await reviewDeliverable(leadVideo(), {
      deliverableId: ids.video01, decision: 'changes_requested', comments: 'Opening scene is too long.',
    });
    assert.equal(result.stage, 'team_lead');
    assert.equal(result.roundNo, 1);
    assert.equal(result.newStatus, 'changes_requested');
    assert.equal(await slotStatus(ids.video01), 'changes_requested');

    const work = await myWork(ahmed());
    const item = work.current.find((i) => i.assignmentId === ids.ahmedAssignment)!;
    assert.equal(item.changesRequested, 1);
    assert.equal(item.approved, 0);

    const ws = await loadWorkspace(ahmed(), ids.project);
    const slot = ws!.teams.find((t) => t.department === 'Video')!.deliverables.find((d) => d.id === ids.video01)!;
    assert.ok(slot.lastReview, 'the executive sees the feedback on the slot');
    assert.equal(slot.lastReview.decision, 'changes_requested');
    assert.equal(slot.lastReview.comments, 'Opening scene is too long.');
    assert.equal(slot.lastReview.reviewer, 'leadVideo');
  });

  test('a rejected slot is out of every queue until a new version arrives', async () => {
    assert.ok(!(await qaQueue(leadVideo())).some((i) => i.deliverableId === ids.video01));
    await upload(ahmed(), ids.video01, 'Video_01_v2.mp4');
    const item = (await qaQueue(leadVideo())).find((i) => i.deliverableId === ids.video01);
    assert.ok(item);
    assert.equal(item.versionNo, 2);
    assert.equal(item.previousRounds, 1, 'the lead can see this slot came back once already');
  });

  test('rejected a second time: still one slot, progress still 0/2', async () => {
    await reviewDeliverable(leadVideo(), {
      deliverableId: ids.video01, decision: 'rejected', comments: 'Wrong logo.',
    });
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM deliverables WHERE assignment_id = ${ids.ahmedAssignment}`;
    assert.equal(n, 2, 'two rejections did not create a third slot');

    const [prog] = await sql`SELECT total, approved FROM v_assignment_progress WHERE assignment_id = ${ids.ahmedAssignment}`;
    assert.equal(Number(prog.total), 2);
    assert.equal(Number(prog.approved), 0);

    const reviews = await sql`
      SELECT v.version_no, q.stage, q.round_no, q.decision
      FROM qa_reviews q JOIN deliverable_versions v ON v.id = q.deliverable_version_id
      WHERE v.deliverable_id = ${ids.video01} ORDER BY v.version_no, q.round_no`;
    assert.deepEqual(
      reviews.map((r) => [Number(r.version_no), r.stage, Number(r.round_no), r.decision]),
      [[1, 'team_lead', 1, 'changes_requested'], [2, 'team_lead', 1, 'rejected']],
      'every round is kept (§19, §25)',
    );
  });

  test('third time: the lead approves and, because this team needs PM QA, it moves to the PM', async () => {
    await upload(ahmed(), ids.video01, 'Video_01_v3.mp4');
    const result = await reviewDeliverable(leadVideo(), {
      deliverableId: ids.video01, decision: 'approved', comments: 'Good to go.',
    });
    assert.equal(result.newStatus, 'awaiting_pm_qa');
    assert.equal(result.deliveryId, null, 'not deliverable until the PM signs off');
    assert.equal(await slotStatus(ids.video01), 'awaiting_pm_qa');

    const pms = await qaQueue(pm());
    const item = pms.find((i) => i.deliverableId === ids.video01);
    assert.ok(item, 'now in the PM queue');
    assert.equal(item.stage, 'project_manager');
    assert.equal(item.versionNo, 3);

    assert.ok(!(await qaQueue(leadVideo())).some((i) => i.deliverableId === ids.video01), 'and out of the lead’s');
  });

  test('the PM approves: slot approved, progress 1/2, a delivery row waits for Sales', async () => {
    const result = await reviewDeliverable(pm(), {
      deliverableId: ids.video01, decision: 'approved', comments: 'Approved for delivery.',
    });
    assert.equal(result.stage, 'project_manager');
    assert.equal(result.newStatus, 'approved');
    assert.ok(result.deliveryId, 'a deliveries row was opened');
    ids.video01Delivery = result.deliveryId!;

    assert.equal(await slotStatus(ids.video01), 'approved');
    const [prog] = await sql`SELECT total, approved FROM v_assignment_progress WHERE assignment_id = ${ids.ahmedAssignment}`;
    assert.equal(`${prog.approved}/${prog.total}`, '1/2');

    const [delivery] = await sql`
      SELECT status, approved_at, deliverable_version_id FROM deliveries WHERE id = ${ids.video01Delivery}`;
    assert.equal(delivery.status, 'pending_delivery');
    assert.ok(delivery.approved_at);
    const [version] = await sql`SELECT version_no FROM deliverable_versions WHERE id = ${delivery.deliverable_version_id}`;
    assert.equal(Number(version.version_no), 3, 'the delivery points at the version that passed');
  });
});

describe('who may review (brief §12, §13, §23)', { skip }, () => {
  test('a lead cannot review another team’s slot', async () => {
    await upload(sara(), ids.thumb01, 'Thumb_01.png');
    await assert.rejects(
      reviewDeliverable(leadVideo(), { deliverableId: ids.thumb01, decision: 'approved' }),
      /not yours to review/,
    );
  });

  test('an Executive cannot review at all, not even their own work', async () => {
    await assert.rejects(
      reviewDeliverable(sara(), { deliverableId: ids.thumb01, decision: 'approved' }),
      QaError,
    );
  });

  test('a slot that is not awaiting review cannot be reviewed', async () => {
    await assert.rejects(
      reviewDeliverable(leadVideo(), { deliverableId: ids.video02, decision: 'approved' }),
      /not awaiting/,
    );
  });

  test('a lead cannot sign off at the PM stage', async () => {
    await upload(ahmed(), ids.video02, 'Video_02_v1.mp4');
    await reviewDeliverable(leadVideo(), { deliverableId: ids.video02, decision: 'approved' });
    assert.equal(await slotStatus(ids.video02), 'awaiting_pm_qa');
    await assert.rejects(
      reviewDeliverable(leadVideo(), { deliverableId: ids.video02, decision: 'approved' }),
      /Project Manager/,
    );
  });

  test('a PM rejection sends the slot back to the Executive', async () => {
    const result = await reviewDeliverable(pm(), {
      deliverableId: ids.video02, decision: 'changes_requested', comments: 'Client wants the blue grade.',
    });
    assert.equal(result.newStatus, 'changes_requested');
    assert.equal(await slotStatus(ids.video02), 'changes_requested');
  });

  test('the PM may also act as a lead (§6), and a team without PM QA approves straight through', async () => {
    const result = await reviewDeliverable(pm(), { deliverableId: ids.thumb01, decision: 'approved' });
    assert.equal(result.stage, 'team_lead');
    assert.equal(result.newStatus, 'approved', 'Design has requires_pm_qa = false');
    assert.ok(result.deliveryId);
    ids.thumbDelivery = result.deliveryId!;
  });

  test('a deactivated lead cannot review', async () => {
    await upload(ahmed(), ids.video02, 'Video_02_v2.mp4');
    await assert.rejects(
      reviewDeliverable(actor('team_lead', { id: ids.leadVideo, leadDepartmentIds: [ids.video], isActive: false }),
        { deliverableId: ids.video02, decision: 'approved' }),
      QaError,
    );
  });
});

describe('Sales delivery panel (brief §14)', { skip }, () => {
  test('the Sales owner sees the approved deliverables with what §14 asks for', async () => {
    const queue = await deliveryQueue(sales());
    const item = queue.find((d) => d.deliveryId === ids.video01Delivery);
    assert.ok(item);
    assert.equal(item.projectTitle, 'ABC social media videos');
    assert.equal(item.clientName, 'M7 Test Client');
    assert.equal(item.deliverableName, 'Video 01');
    assert.equal(item.originalFilename, 'Video_01_v3.mp4');
    assert.equal(item.versionNo, 3);
    assert.equal(item.status, 'pending_delivery');
    assert.equal(item.qaComments, 'Approved for delivery.');
    assert.ok(item.approvedAt);
    assert.match(item.downloadUrl, /^\/api\/files\//);
  });

  test('a rep on other clients does not see it', async () => {
    const queue = await deliveryQueue(otherSales());
    assert.ok(!queue.some((d) => d.deliveryId === ids.video01Delivery));
  });

  test('an Executive cannot manage deliveries', async () => {
    await assert.rejects(
      updateDelivery(ahmed(), { deliveryId: ids.video01Delivery, status: 'delivered' }),
      DeliveryError,
    );
  });

  test('marking delivered records who and when, and the slot becomes delivered', async () => {
    const result = await updateDelivery(sales(), {
      deliveryId: ids.video01Delivery, status: 'delivered', notes: 'Sent via WeTransfer.',
    });
    assert.equal(result.status, 'delivered');
    const [row] = await sql`SELECT delivered_at, delivered_by, notes FROM deliveries WHERE id = ${ids.video01Delivery}`;
    assert.ok(row.delivered_at);
    assert.equal(Number(row.delivered_by), ids.sales);
    assert.equal(row.notes, 'Sent via WeTransfer.');
    assert.equal(await slotStatus(ids.video01), 'delivered');
  });

  test('a delivery cannot skip ahead: pending → completed is refused', async () => {
    await assert.rejects(
      updateDelivery(sales(), { deliveryId: ids.thumbDelivery, status: 'completed' }),
      /cannot go from/,
    );
  });

  test('client feedback is kept with the delivery', async () => {
    const result = await updateDelivery(sales(), {
      deliveryId: ids.video01Delivery, status: 'client_feedback_received',
      clientFeedback: 'Please change the opening scene.',
    });
    assert.equal(result.status, 'client_feedback_received');
    const [row] = await sql`SELECT client_feedback FROM deliveries WHERE id = ${ids.video01Delivery}`;
    assert.equal(row.client_feedback, 'Please change the opening scene.');
  });
});

describe('project status follows the work (brief §18, §26)', { skip }, () => {
  test('approved everywhere → ready for delivery → delivered → completed', async () => {
    await upload(ahmed(), ids.reel01, 'Reel.mp4');
    assert.equal(await projectStatus(ids.soloProject), 'in_progress');

    const approved = await reviewDeliverable(leadVideo(), { deliverableId: ids.reel01, decision: 'approved' });
    assert.equal(approved.newStatus, 'approved', 'no PM QA on this project');
    assert.equal(await projectStatus(ids.soloProject), 'ready_for_delivery');

    await updateDelivery(sales(), { deliveryId: approved.deliveryId!, status: 'delivered' });
    assert.equal(await projectStatus(ids.soloProject), 'delivered');

    await updateDelivery(sales(), { deliveryId: approved.deliveryId!, status: 'completed' });
    assert.equal(await projectStatus(ids.soloProject), 'completed');
    const [row] = await sql`SELECT completed_at FROM projects WHERE id = ${ids.soloProject}`;
    assert.ok(row.completed_at);

    const [asg] = await sql`SELECT status FROM assignments WHERE id = (SELECT assignment_id FROM deliverables WHERE id = ${ids.reel01})`;
    assert.equal(asg.status, 'completed', 'the assignment closed with its last slot');
  });
});

describe('the activity feed (brief §25)', { skip }, () => {
  test('reads end to end like the example in the brief', async () => {
    // Actions are recorded by the server actions and routes, which need a
    // request; here the rows are written directly in the shape they produce.
    const at = (minutes: number) => new Date(Date.UTC(2094, 8, 24, 10, minutes)).toISOString();
    const rows: [number, string, string, Record<string, unknown>, string][] = [
      [ids.sales, 'project.created', 'project', { projectCode: 'AKT-2094-0001' }, at(32)],
      [ids.pm, 'project.triaged', 'project', { status: 'planned', teams: ['Video'] }, at(65)],
      [ids.leadVideo, 'assignment.created', 'assignment', { assigneeName: 'ahmed', deliverables: 2 }, at(90)],
      [ids.ahmed, 'file.uploaded', 'file', { deliverableName: 'Video 01', versionNo: 1 }, at(100)],
      [ids.leadVideo, 'qa.reviewed', 'deliverable', { stage: 'team_lead', decision: 'rejected', deliverableName: 'Video 01', versionNo: 1 }, at(110)],
      [ids.ahmed, 'file.uploaded', 'file', { deliverableName: 'Video 01', versionNo: 2 }, at(120)],
      [ids.leadVideo, 'qa.reviewed', 'deliverable', { stage: 'team_lead', decision: 'approved', deliverableName: 'Video 01', versionNo: 2 }, at(130)],
      [ids.pm, 'qa.reviewed', 'deliverable', { stage: 'project_manager', decision: 'approved', deliverableName: 'Video 01', versionNo: 2 }, at(140)],
      [ids.sales, 'delivery.updated', 'delivery', { status: 'delivered', deliverableName: 'Video 01' }, at(150)],
    ];
    for (const [actorId, action, entityType, metadata, createdAt] of rows) {
      await sql`INSERT INTO activity_log (actor_id, action, entity_type, project_id, metadata, created_at)
                VALUES (${actorId}, ${action}, ${entityType}, ${ids.project},
                        ${sql.json(metadata as Parameters<typeof sql.json>[0])}, ${createdAt})`;
    }

    const feed = await projectActivity(ids.project);
    const lines = feed.filter((e) => e.at.startsWith('2094-09-24')).map((e) => e.text);
    assert.deepEqual(lines, [
      'sales created the project AKT-2094-0001',
      'pm routed the project to Video',
      'leadVideo assigned work to ahmed (2 deliverables)',
      'ahmed uploaded Video 01 v1',
      'leadVideo rejected Video 01 v1',
      'ahmed uploaded Video 01 v2',
      'leadVideo approved Video 01 v2',
      'pm approved Video 01 v2',
      'sales delivered Video 01 to the client',
    ]);
  });
});
