/**
 * The decided statuses (brief §18) and attachments below the project (§3,
 * §7, §15).
 *
 * On Hold stops new work and remembers where the project was; Cancelled
 * withdraws what is unfinished and keeps what was approved. Routing no longer
 * sends a project that has started back to "planned", and a team still
 * without a lead no longer freezes the project at "awaiting assignment" —
 * though a team with no lead or no plan keeps it in progress, so it cannot
 * finish without that team, and the intake queue says so. QA is the status
 * once nothing is left in production. Attachments hang off
 * the project, one assignment or one revision, and each parent has its own
 * rule for who may add to it and who sees it.
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
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run status tests';

let sql: ReturnType<typeof postgres>;
let storageRoot: string;

let status: typeof import('../src/lib/projects/status');
let access: typeof import('../src/lib/files/access');
let attachments: typeof import('../src/lib/files/attachments');
let uploads: typeof import('../src/lib/files/uploads');
let fileProject: typeof import('../src/lib/projects/file-project').fileProject;
let triageProject: typeof import('../src/lib/projects/triage').triageProject;
let intakeQueue: typeof import('../src/lib/projects/triage').intakeQueue;
let createAssignment: typeof import('../src/lib/planning/assign').createAssignment;
let reviewDeliverable: typeof import('../src/lib/qa/review').reviewDeliverable;
let createRevision: typeof import('../src/lib/revisions/revisions').createRevision;
let updateDelivery: typeof import('../src/lib/delivery/deliveries').updateDelivery;
let deliveryQueue: typeof import('../src/lib/delivery/deliveries').deliveryQueue;
let closeMonth: typeof import('../src/lib/months/lifecycle').closeMonth;

const ids: Record<string, number> = {};

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0, email: `${role}@m15test.local`, fullName: role, role,
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
const sara = () => actor('executive', { id: ids.sara, departmentIds: [ids.design] });
const omar = () => actor('executive', { id: ids.omar, departmentIds: [ids.video] });

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE '%@m15test.local'`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM upload_sessions WHERE created_by IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'M15 Test%')`;
  await sql`DELETE FROM clients WHERE name LIKE 'M15 Test%'`;
  await sql`DELETE FROM files WHERE uploaded_by IN (${users})`;
  await sql`DELETE FROM notifications WHERE user_id IN (${users})`;
  await sql`DELETE FROM department_members WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE '%@m15test.local'`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2082`;
}

const bytes = () => randomBytes(48);
const stream = (b: Buffer) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(b)); c.close(); } });

async function uploadTo(who: Actor, deliverableId: number) {
  const b = bytes();
  const { session } = await uploads.createUploadSession(who, { target: 'deliverable', deliverableId, filename: 'cut.mp4', size: b.length });
  await uploads.appendChunk(who, session.id, 0, stream(b));
  return uploads.completeUpload(who, session.id);
}

async function attach(who: Actor, projectId: number, filename: string, parent: { assignmentId?: number; revisionId?: number } = {}) {
  const b = bytes();
  const { session } = await uploads.createUploadSession(who, {
    target: 'attachment', projectId, ...parent, filename, size: b.length,
  });
  await uploads.appendChunk(who, session.id, 0, stream(b));
  return uploads.completeUpload(who, session.id);
}

const projectRow = async (id: number) =>
  (await sql<{ status: string; held_from_status: string | null }[]>`
    SELECT status, held_from_status FROM projects WHERE id = ${id}`)[0];

async function teamOf(projectId: number, slug: string) {
  return Number((await sql`SELECT id FROM project_departments WHERE project_id = ${projectId} AND department_id = ${ids[slug]}`)[0].id);
}

/** Files and routes a project; a team whose lead is null is left without one. */
async function newProject(title: string, teams: { slug: string; lead: string | null; n: number }[]) {
  const p = await fileProject(sales(), {
    clientId: ids.client, period: '2082-03', title, priceAmount: '1000.00', requiresPmQa: false,
    departments: teams.map((t) => ({ departmentId: ids[t.slug], plannedDeliverables: t.n })),
  });
  await triageProject(pm(), {
    projectId: p.projectId,
    teams: teams.map((t) => ({
      departmentId: ids[t.slug], teamLeadId: t.lead ? ids[t.lead] : null, plannedDeliverables: t.n,
    })),
  });
  return p.projectId;
}

before(async () => {
  if (skip) return;
  storageRoot = await mkdtemp(path.join(tmpdir(), 'aktivacity-m15-'));
  process.env.STORAGE_ROOT = storageRoot;
  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });

  status = await import('../src/lib/projects/status');
  access = await import('../src/lib/files/access');
  attachments = await import('../src/lib/files/attachments');
  uploads = await import('../src/lib/files/uploads');
  ({ fileProject } = await import('../src/lib/projects/file-project'));
  ({ triageProject, intakeQueue } = await import('../src/lib/projects/triage'));
  ({ createAssignment } = await import('../src/lib/planning/assign'));
  ({ reviewDeliverable } = await import('../src/lib/qa/review'));
  ({ createRevision } = await import('../src/lib/revisions/revisions'));
  ({ updateDelivery, deliveryQueue } = await import('../src/lib/delivery/deliveries'));
  ({ closeMonth } = await import('../src/lib/months/lifecycle'));
  await purge();

  for (const slug of ['video', 'design']) {
    ids[slug] = Number((await sql`SELECT id FROM departments WHERE slug = ${slug}`)[0].id);
  }
  for (const [key, role] of [
    ['sales', 'sales'], ['otherSales', 'sales'], ['pm', 'project_manager'], ['ceo', 'ceo'],
    ['leadVideo', 'team_lead'], ['leadDesign', 'team_lead'],
    ['ahmed', 'executive'], ['sara', 'executive'], ['omar', 'executive'],
  ] as const) {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES (${`${key}@m15test.local`}, 'x', ${key}, ${role}) RETURNING id`;
    ids[key] = Number(row.id);
  }
  for (const [key, slug, lead] of [
    ['leadVideo', 'video', true], ['leadDesign', 'design', true],
    ['ahmed', 'video', false], ['omar', 'video', false], ['sara', 'design', false],
  ] as const) {
    await sql`INSERT INTO department_members (user_id, department_id, is_lead) VALUES (${ids[key]}, ${ids[slug]}, ${lead})`;
  }
  const [client] = await sql<{ id: number }[]>`
    INSERT INTO clients (name, owner_user_id, created_by) VALUES ('M15 Test Client', ${ids.sales}, ${ids.sales}) RETURNING id`;
  ids.client = Number(client.id);
});

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('who may hold or cancel (brief §18)', { skip }, () => {
  test('a Team Lead, an Executive and another rep may not', async () => {
    const id = await newProject('Who', [{ slug: 'video', lead: 'leadVideo', n: 1 }]);
    for (const who of [leadVideo(), ahmed()]) {
      await assert.rejects(status.changeProjectStatus(who, { projectId: id, change: 'hold' }), /not permitted/);
    }
    await assert.rejects(status.changeProjectStatus(otherSales(), { projectId: id, change: 'hold' }), /No such project/);
    assert.equal((await projectRow(id)).status, 'planned');
  });
});

describe('putting a project on hold', { skip }, () => {
  let projectId: number;
  let slots: number[];

  before(async () => {
    if (skip) return;
    projectId = await newProject('Held', [{ slug: 'video', lead: 'leadVideo', n: 2 }]);
    const a = await createAssignment(leadVideo(), {
      projectDepartmentId: await teamOf(projectId, 'video'), assigneeId: ids.ahmed, title: 'Cut', deliverableCount: 2,
    });
    slots = a.deliverableIds;
    await uploadTo(ahmed(), slots[0]);
    assert.equal((await projectRow(projectId)).status, 'in_progress');
  });

  test('Sales holds it; it remembers where it was and tells the people on it', async () => {
    const r = await status.changeProjectStatus(sales(), { projectId, change: 'hold', reason: 'Client paused' });
    assert.deepEqual([r.from, r.status], ['in_progress', 'on_hold']);
    assert.deepEqual(await projectRow(projectId), { status: 'on_hold', held_from_status: 'in_progress' });
    const told = await sql`SELECT user_id FROM notifications WHERE type = 'project.on_hold'
      AND entity_id = ${projectId} ORDER BY user_id`;
    const who = told.map((t) => Number(t.user_id));
    for (const k of ['pm', 'leadVideo', 'ahmed']) assert.ok(who.includes(ids[k]), k);
    assert.ok(!who.includes(ids.sales), 'the person who held it is not told');
  });

  test('holding twice is refused', async () => {
    await assert.rejects(status.changeProjectStatus(pm(), { projectId, change: 'hold' }), /already on hold/);
  });

  test('no new assignment, upload or revision while held', async () => {
    await assert.rejects(createAssignment(leadVideo(), {
      projectDepartmentId: await teamOf(projectId, 'video'), assigneeId: ids.omar, title: 'More', deliverableCount: 1,
    }), /on hold/);
    const gate = await access.canUploadToDeliverable(ahmed(), slots[1]);
    assert.equal(gate.allowed, false);
    assert.match(gate.reason ?? '', /on hold/);
    const refs = await access.canAttachToProject(ahmed(), projectId);
    assert.equal(refs.allowed, false, 'no new references either');
    assert.match(refs.reason ?? '', /on hold/);
    await assert.rejects(createRevision(sales(), {
      projectId, title: 'Held back', clientFeedback: 'y', deliverableIds: [slots[0]],
    }), /on hold/);
  });

  test('an upload already in flight is refused when it completes', async () => {
    await status.changeProjectStatus(pm(), { projectId, change: 'resume' });
    const b = bytes();
    const { session } = await uploads.createUploadSession(ahmed(), { target: 'deliverable', deliverableId: slots[1], filename: 'late.mp4', size: b.length });
    await uploads.appendChunk(ahmed(), session.id, 0, stream(b));
    await status.changeProjectStatus(pm(), { projectId, change: 'hold' });
    await assert.rejects(uploads.completeUpload(ahmed(), session.id), /on hold/);
  });

  test('QA on work already submitted still goes through', async () => {
    const review = await reviewDeliverable(leadVideo(), { deliverableId: slots[0], decision: 'approved' });
    assert.ok(review);
    assert.equal((await projectRow(projectId)).status, 'on_hold', 'the sync leaves a held project alone');
  });

  test('re-routing a held project keeps it held', async () => {
    await triageProject(pm(), {
      projectId, teams: [{ departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 2 }],
    });
    assert.deepEqual(await projectRow(projectId), { status: 'on_hold', held_from_status: 'in_progress' });
  });

  test('resuming returns it to where it was, re-derived from the work', async () => {
    const r = await status.changeProjectStatus(pm(), { projectId, change: 'resume' });
    assert.equal(r.status, 'in_progress');
    assert.deepEqual(await projectRow(projectId), { status: 'in_progress', held_from_status: null });
    assert.equal((await access.canUploadToDeliverable(ahmed(), slots[1])).allowed, true);
  });

  test('resuming a project that is not held is refused', async () => {
    await assert.rejects(status.changeProjectStatus(pm(), { projectId, change: 'resume' }), /Only a project on hold/);
  });
});

describe('routing does not rewind a project that has started', { skip }, () => {
  test('adding a team to work in progress leaves it in progress', async () => {
    // Two slots, one still to make: the project is in progress, not in QA.
    const projectId = await newProject('Started', [{ slug: 'video', lead: 'leadVideo', n: 2 }]);
    const a = await createAssignment(leadVideo(), {
      projectDepartmentId: await teamOf(projectId, 'video'), assigneeId: ids.ahmed, title: 'Cut', deliverableCount: 2,
    });
    await uploadTo(ahmed(), a.deliverableIds[0]);
    const r = await triageProject(pm(), {
      projectId,
      teams: [
        { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 2 },
        { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 1 },
      ],
    });
    assert.equal(r.status, 'in_progress');
    assert.equal((await projectRow(projectId)).status, 'in_progress');
  });

  test('a partly routed project follows its work, but cannot finish without the missing team', async () => {
    const projectId = await newProject('Partly routed', [
      { slug: 'video', lead: 'leadVideo', n: 2 }, { slug: 'design', lead: null, n: 1 },
    ]);
    assert.equal((await projectRow(projectId)).status, 'awaiting_assignment');
    const a = await createAssignment(leadVideo(), {
      projectDepartmentId: await teamOf(projectId, 'video'), assigneeId: ids.ahmed, title: 'Cut', deliverableCount: 2,
    });
    assert.equal((await projectRow(projectId)).status, 'awaiting_assignment', 'planned, but nothing has started');
    const queued = async () => (await intakeQueue(pm())).find((p) => p.id === projectId);
    assert.ok(await queued());

    await uploadTo(ahmed(), a.deliverableIds[0]);
    assert.equal((await projectRow(projectId)).status, 'in_progress');
    const row = await queued();
    assert.equal(row?.status, 'in_progress', 'the PM still sees it');
    assert.equal(row?.unassigned, 1, 'Design still has no lead');

    // Video finishes and is handed over. Design has not started, so the
    // project is not in QA, delivered or completed: it stays in progress, in
    // the queue, and its month cannot close.
    await uploadTo(ahmed(), a.deliverableIds[1]);
    assert.equal((await projectRow(projectId)).status, 'in_progress', 'Design has work to come');
    const deliveries: number[] = [];
    for (const id of a.deliverableIds) {
      deliveries.push((await reviewDeliverable(leadVideo(), { deliverableId: id, decision: 'approved' })).deliveryId!);
    }
    for (const id of deliveries) await updateDelivery(sales(), { deliveryId: id, status: 'delivered' });
    for (const id of deliveries) await updateDelivery(sales(), { deliveryId: id, status: 'completed' });
    assert.equal((await projectRow(projectId)).status, 'in_progress');
    assert.ok(await queued(), 'still waiting on a Design lead');
    const [{ project_code: code, client_month_id: monthId }] = await sql`
      SELECT project_code, client_month_id FROM projects WHERE id = ${projectId}`;
    await assert.rejects(closeMonth(ceo(), { clientMonthId: Number(monthId) }), new RegExp(`${code} \\(in progress\\)`, 'i'));

    // Design gets its lead, who has planned nothing yet: still in progress,
    // so the lead can plan it.
    const led = await triageProject(pm(), {
      projectId,
      teams: [
        { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 2 },
        { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 1 },
      ],
    });
    assert.equal(led.status, 'in_progress', 'a lead with nothing planned yet');
    const held = await queued();
    assert.equal(held?.unassigned, 0, 'every team has a lead');
    assert.equal(held?.unplanned, 1, 'but Design has planned nothing while the rest is done, so the PM still sees it');

    const [thumb] = (await createAssignment(leadDesign(), {
      projectDepartmentId: await teamOf(projectId, 'design'), assigneeId: ids.sara, title: 'Thumb', deliverableCount: 1,
    })).deliverableIds;
    assert.equal(await queued(), undefined, 'planned: only the work holds it now');
    await uploadTo(sara(), thumb);
    assert.equal((await projectRow(projectId)).status, 'qa', 'the rest is done; Design waits on its lead');
    const { deliveryId } = await reviewDeliverable(leadDesign(), { deliverableId: thumb, decision: 'approved' });
    assert.equal((await projectRow(projectId)).status, 'ready_for_delivery');
    await updateDelivery(sales(), { deliveryId: deliveryId!, status: 'delivered' });
    assert.equal((await projectRow(projectId)).status, 'delivered');
    await updateDelivery(sales(), { deliveryId: deliveryId!, status: 'completed' });
    assert.equal((await projectRow(projectId)).status, 'completed');
  });

  test('routing work that is already done never sends it back to planned', async () => {
    const projectId = await newProject('Late lead', [
      { slug: 'video', lead: 'leadVideo', n: 1 }, { slug: 'design', lead: null, n: 1 },
    ]);
    const a = await createAssignment(leadVideo(), {
      projectDepartmentId: await teamOf(projectId, 'video'), assigneeId: ids.ahmed, title: 'Cut', deliverableCount: 1,
    });
    await uploadTo(ahmed(), a.deliverableIds[0]);
    await reviewDeliverable(leadVideo(), { deliverableId: a.deliverableIds[0], decision: 'approved' });
    assert.equal((await projectRow(projectId)).status, 'in_progress', 'Video is approved; Design has not started');

    // Where an earlier version left such a project: stuck at awaiting assignment.
    const stuck = () => sql`UPDATE projects SET status = 'awaiting_assignment' WHERE id = ${projectId}`;
    await stuck();
    const led = await triageProject(pm(), {
      projectId,
      teams: [
        { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 },
        { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 1 },
      ],
    });
    assert.equal(led.status, 'in_progress', 'giving Design its lead');
    assert.equal((await projectRow(projectId)).status, 'in_progress');
    const queued = async () => (await intakeQueue(pm())).find((p) => p.id === projectId);
    assert.deepEqual([(await queued())?.unassigned, (await queued())?.unplanned], [0, 1],
      'every team has a lead; Design’s has planned nothing while Video is done');

    await stuck();
    const dropped = await triageProject(pm(), {
      projectId, teams: [{ departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 }],
    });
    assert.equal(dropped.status, 'ready_for_delivery', 'dropping the team that had no work');
    assert.equal(await queued(), undefined, 'nothing holds it up');
  });
});

describe('in QA once nothing is left in production (brief §18)', { skip }, () => {
  test('the project says QA only while every remaining slot waits on a reviewer', async () => {
    const projectId = await newProject('Review', [{ slug: 'video', lead: 'leadVideo', n: 2 }]);
    await sql`UPDATE project_departments SET requires_pm_qa = true WHERE project_id = ${projectId}`;
    const [first, second] = (await createAssignment(leadVideo(), {
      projectDepartmentId: await teamOf(projectId, 'video'), assigneeId: ids.ahmed, title: 'Cut', deliverableCount: 2,
    })).deliverableIds;
    const now = async () => (await projectRow(projectId)).status;

    await uploadTo(ahmed(), first);
    assert.equal(await now(), 'in_progress', 'the second slot is still to make');
    await uploadTo(ahmed(), second);
    assert.equal(await now(), 'qa');

    await reviewDeliverable(leadVideo(), { deliverableId: first, decision: 'approved' });
    assert.equal(await now(), 'qa', 'on to the PM, still in review');
    await reviewDeliverable(leadVideo(), { deliverableId: second, decision: 'changes_requested', comments: 'Tighter.' });
    assert.equal(await now(), 'in_progress', 'sent back to the Executive');
    await uploadTo(ahmed(), second);
    assert.equal(await now(), 'qa');

    await status.changeProjectStatus(pm(), { projectId, change: 'hold' });
    assert.deepEqual(await projectRow(projectId), { status: 'on_hold', held_from_status: 'qa' });
    await status.changeProjectStatus(pm(), { projectId, change: 'resume' });
    assert.equal(await now(), 'qa', 'resuming returns it to QA');

    await reviewDeliverable(pm(), { deliverableId: first, decision: 'approved' });
    assert.equal(await now(), 'qa', 'one approved, one still in review');
    await reviewDeliverable(leadVideo(), { deliverableId: second, decision: 'approved' });
    await reviewDeliverable(pm(), { deliverableId: second, decision: 'approved' });
    assert.equal(await now(), 'ready_for_delivery');
  });
});

describe('cancelling a project', { skip }, () => {
  let projectId: number;
  let video: number[];
  let design: number;
  let videoDelivery: number;
  let revisionId: number;

  before(async () => {
    if (skip) return;
    projectId = await newProject('Cancelled', [
      { slug: 'video', lead: 'leadVideo', n: 2 }, { slug: 'design', lead: 'leadDesign', n: 1 },
    ]);
    const v = await createAssignment(leadVideo(), {
      projectDepartmentId: await teamOf(projectId, 'video'), assigneeId: ids.ahmed, title: 'Cut', deliverableCount: 2,
    });
    const d = await createAssignment(leadDesign(), {
      projectDepartmentId: await teamOf(projectId, 'design'), assigneeId: ids.sara, title: 'Thumb', deliverableCount: 1,
    });
    video = v.deliverableIds;
    design = d.deliverableIds[0];
    // The first cut is delivered; the thumbnail is approved and waits with Sales.
    await uploadTo(ahmed(), video[0]);
    const cut = await reviewDeliverable(leadVideo(), { deliverableId: video[0], decision: 'approved' });
    videoDelivery = cut.deliveryId!;
    await updateDelivery(sales(), { deliveryId: videoDelivery, status: 'delivered' });
    await uploadTo(sara(), design);
    await reviewDeliverable(leadDesign(), { deliverableId: design, decision: 'approved' });
    // The client comes back on both, and the delivered cut is flagged for it.
    const rev = await createRevision(sales(), {
      projectId, title: 'Colour', clientFeedback: 'Warmer.', deliverableIds: [video[0], design],
    });
    revisionId = rev.revisionId;
    assert.equal((await sql`SELECT status FROM deliveries WHERE id = ${videoDelivery}`)[0].status, 'revision_required');
  });

  test('a reason is required', async () => {
    await assert.rejects(status.changeProjectStatus(pm(), { projectId, change: 'cancel' }), /Say why/);
  });

  test('unfinished work is withdrawn; approved work, and what the revision had sent back, stays deliverable', async () => {
    const r = await status.changeProjectStatus(pm(), { projectId, change: 'cancel', reason: 'Client withdrew' });
    assert.equal(r.status, 'cancelled');
    assert.equal(r.cancelledSlots, 1, 'the untouched video; the revision’s slots get their state back first');

    const slots = await sql`SELECT id, status FROM deliverables WHERE project_id = ${projectId} ORDER BY id`;
    const byId = new Map(slots.map((s) => [Number(s.id), s.status]));
    assert.equal(byId.get(video[0]), 'delivered', 'the file the client has stands');
    assert.equal(byId.get(video[1]), 'cancelled');
    assert.equal(byId.get(design), 'approved', 'back to waiting for delivery, not withdrawn');

    // The revision is withdrawn with the project, and the delivery it had
    // flagged is given back — nothing is left at "revision required" behind
    // a revision that no longer exists, so Sales can finish the hand-over.
    const [rev] = await sql`SELECT status, closed_at FROM revisions WHERE id = ${revisionId}`;
    assert.equal(rev.status, 'cancelled');
    assert.ok(rev.closed_at);
    assert.equal((await sql`SELECT status FROM deliveries WHERE id = ${videoDelivery}`)[0].status, 'delivered');
    const [thumb] = await sql`SELECT status FROM deliveries WHERE deliverable_id = ${design}`;
    assert.equal(thumb.status, 'pending_delivery', 'Sales can still hand over what was approved');
    const [{ flagged }] = await sql<{ flagged: number }[]>`
      SELECT count(*)::int AS flagged FROM deliveries WHERE project_id = ${projectId} AND status = 'revision_required'`;
    assert.equal(flagged, 0);

    const asg = await sql`SELECT status FROM assignments WHERE project_id = ${projectId}`;
    assert.ok(asg.every((a) => a.status === 'cancelled' || a.status === 'completed'));
    assert.deepEqual(await projectRow(projectId), { status: 'cancelled', held_from_status: null });
  });

  test('Sales completes the hand-overs the cancellation left standing', async () => {
    await updateDelivery(sales(), { deliveryId: videoDelivery, status: 'completed' });
    const [thumb] = await sql`SELECT id FROM deliveries WHERE deliverable_id = ${design}`;
    await updateDelivery(sales(), { deliveryId: Number(thumb.id), status: 'delivered' });
    await updateDelivery(sales(), { deliveryId: Number(thumb.id), status: 'completed' });
    const rows = await sql`SELECT status FROM deliveries WHERE project_id = ${projectId} ORDER BY id`;
    assert.deepEqual(rows.map((d) => d.status), ['completed', 'completed']);
    assert.equal((await sql`SELECT status FROM deliverables WHERE id = ${design}`)[0].status, 'delivered');
    assert.deepEqual(await projectRow(projectId), { status: 'cancelled', held_from_status: null }, 'a cancelled project does not follow the work');
  });

  test('it is final', async () => {
    await assert.rejects(status.changeProjectStatus(pm(), { projectId, change: 'cancel', reason: 'again' }), /already cancelled/);
    await assert.rejects(status.changeProjectStatus(pm(), { projectId, change: 'hold' }), /cannot be put on hold/);
    await assert.rejects(triageProject(pm(), {
      projectId, teams: [{ departmentId: ids.video, teamLeadId: ids.leadVideo }],
    }), /cancelled/);
    const gate = await access.canUploadToDeliverable(ahmed(), video[1]);
    assert.equal(gate.allowed, false);
  });

  test('the project stays readable', async () => {
    const [row] = await sql`SELECT count(*)::int AS n FROM deliverables WHERE project_id = ${projectId}`;
    assert.equal(row.n, 3, 'nothing is deleted');
  });

  test('a rework still in QA is withdrawn; the file it was to replace stands, and Sales completes it', async () => {
    // The cut is delivered, the client comes back, and Ahmed's rework is
    // waiting for the lead when the project is cancelled: no reviewer will
    // ever see it, so the delivery it was to replace cannot stay flagged.
    const inQa = await newProject('Cancelled in QA', [{ slug: 'video', lead: 'leadVideo', n: 1 }]);
    const work = await createAssignment(leadVideo(), {
      projectDepartmentId: await teamOf(inQa, 'video'), assigneeId: ids.ahmed, title: 'Cut', deliverableCount: 1,
    });
    const [slot] = work.deliverableIds;
    await uploadTo(ahmed(), slot);
    const delivery = (await reviewDeliverable(leadVideo(), { deliverableId: slot, decision: 'approved' })).deliveryId!;
    await updateDelivery(sales(), { deliveryId: delivery, status: 'delivered' });
    const rev = await createRevision(sales(), {
      projectId: inQa, title: 'Shorter', clientFeedback: 'Shorter.', deliverableIds: [slot],
    });
    await uploadTo(ahmed(), slot);
    assert.equal((await sql`SELECT status FROM deliverables WHERE id = ${slot}`)[0].status, 'awaiting_lead_qa');
    assert.equal((await sql`SELECT status FROM deliveries WHERE id = ${delivery}`)[0].status, 'revision_required');

    const r = await status.changeProjectStatus(pm(), { projectId: inQa, change: 'cancel', reason: 'Client withdrew' });
    assert.equal(r.cancelledSlots, 1, 'the rework in QA is withdrawn');
    assert.equal((await sql`SELECT status FROM deliverables WHERE id = ${slot}`)[0].status, 'cancelled');
    assert.equal((await sql`SELECT status FROM revisions WHERE id = ${rev.revisionId}`)[0].status, 'cancelled');
    assert.equal(
      (await sql`SELECT status FROM deliveries WHERE id = ${delivery}`)[0].status, 'delivered',
      'no longer flagged for a revision that no longer exists',
    );
    const [{ flagged }] = await sql<{ flagged: number }[]>`
      SELECT count(*)::int AS flagged FROM deliveries WHERE project_id = ${inQa} AND status = 'revision_required'`;
    assert.equal(flagged, 0);

    // Sales sees the file the client has, and can finish the hand-over.
    const row = (await deliveryQueue(sales())).find((d) => d.deliveryId === delivery);
    assert.deepEqual([row?.status, row?.versionNo, row?.canUpdate], ['delivered', 1, true]);
    await updateDelivery(sales(), { deliveryId: delivery, status: 'completed' });
    assert.equal((await sql`SELECT status FROM deliveries WHERE id = ${delivery}`)[0].status, 'completed');
    assert.deepEqual(await projectRow(inQa), { status: 'cancelled', held_from_status: null });
  });
});

describe('attachments (brief §3, §7, §15)', { skip }, () => {
  let projectId: number;
  let videoAssignment: number;
  let videoRevision: number;
  let hidden: number;

  before(async () => {
    if (skip) return;
    projectId = await newProject('Refs', [
      { slug: 'video', lead: 'leadVideo', n: 1 }, { slug: 'design', lead: 'leadDesign', n: 1 },
    ]);
    const v = await createAssignment(leadVideo(), {
      projectDepartmentId: await teamOf(projectId, 'video'), assigneeId: ids.ahmed, title: 'Cut', deliverableCount: 1,
    });
    await createAssignment(leadDesign(), {
      projectDepartmentId: await teamOf(projectId, 'design'), assigneeId: ids.sara, title: 'Thumb', deliverableCount: 1,
    });
    videoAssignment = v.assignmentId;
    await uploadTo(ahmed(), v.deliverableIds[0]);
    await reviewDeliverable(leadVideo(), { deliverableId: v.deliverableIds[0], decision: 'approved' });
    videoRevision = (await createRevision(sales(), {
      projectId, title: 'Logo', clientFeedback: 'Bigger.', deliverableIds: [v.deliverableIds[0]],
    })).revisionId;
    hidden = await newProject('Elsewhere', [{ slug: 'video', lead: 'leadVideo', n: 1 }]);
  });

  test('Sales attaches the PO to the project', async () => {
    const done = await attach(sales(), projectId, 'PO-4411.pdf');
    const [row] = await sql`SELECT project_id, assignment_id, revision_id FROM attachments WHERE file_id = ${done.fileId}`;
    assert.deepEqual([Number(row.project_id), row.assignment_id, row.revision_id], [projectId, null, null]);
  });

  test('references on an assignment: its lead and its assignee, not a colleague', async () => {
    assert.equal((await access.canAttachToProject(leadVideo(), projectId, { assignmentId: videoAssignment })).allowed, true);
    assert.equal((await access.canAttachToProject(ahmed(), projectId, { assignmentId: videoAssignment })).allowed, true);
    const sarasTry = await access.canAttachToProject(sara(), projectId, { assignmentId: videoAssignment });
    assert.equal(sarasTry.allowed, false, 'Sara sees the project but this is not her assignment');
    const done = await attach(leadVideo(), projectId, 'storyboard.pdf', { assignmentId: videoAssignment });
    assert.equal(done.assignmentTitle, 'Cut');
    const [row] = await sql`SELECT project_id, assignment_id FROM attachments WHERE file_id = ${done.fileId}`;
    assert.deepEqual([row.project_id, Number(row.assignment_id)], [null, videoAssignment]);
  });

  test('references on a revision: whoever the revision is visible to', async () => {
    const designLead = await access.canAttachToProject(leadDesign(), projectId, { revisionId: videoRevision });
    assert.equal(designLead.allowed, false, 'the Design lead does not see the video revision');
    const done = await attach(sales(), projectId, 'client-markup.png', { revisionId: videoRevision });
    assert.equal(done.revisionNo, 1);
  });

  test('a parent from another project is refused', async () => {
    const r = await access.canAttachToProject(sales(), hidden, { assignmentId: videoAssignment });
    assert.equal(r.allowed, false);
    const both = await access.canAttachToProject(sales(), projectId, { assignmentId: videoAssignment, revisionId: videoRevision });
    assert.equal(both.allowed, false);
  });

  test('someone off the project cannot attach at all', async () => {
    assert.equal((await access.canAttachToProject(omar(), projectId)).allowed, false);
  });

  test('each person sees the attachments their scope allows', async () => {
    const names = async (who: Actor) =>
      (await attachments.listProjectAttachments(who, projectId)).map((a) => a.originalFilename).sort();
    assert.deepEqual(await names(sales()), ['PO-4411.pdf', 'client-markup.png', 'storyboard.pdf']);
    assert.deepEqual(await names(ahmed()), ['PO-4411.pdf', 'client-markup.png', 'storyboard.pdf']);
    assert.deepEqual(await names(leadDesign()), ['PO-4411.pdf', 'storyboard.pdf'], 'not the video revision’s markup');
    assert.deepEqual(await names(omar()), []);
  });

  test('a file on an assignment is readable exactly when its project is', async () => {
    const [f] = await sql`SELECT f.storage_key::text AS key FROM files f JOIN attachments a ON a.file_id = f.id
      WHERE a.assignment_id = ${videoAssignment}`;
    const ctx = await access.loadFileContext(f.key);
    assert.equal(ctx?.projectId, projectId);
    assert.deepEqual(await access.decideFileAccess(sara(), ctx!), { allowed: true });
    assert.deepEqual(await access.decideFileAccess(omar(), ctx!), { allowed: false, reason: 'out_of_scope' });
  });

  test('a deleted attachment disappears for everyone but those who may delete', async () => {
    await sql`UPDATE files SET deleted_at = now(), deleted_by = ${ids.ceo}
      WHERE id = (SELECT file_id FROM attachments WHERE project_id = ${projectId} LIMIT 1)`;
    const forAhmed = await attachments.listProjectAttachments(ahmed(), projectId);
    assert.ok(!forAhmed.some((a) => a.originalFilename === 'PO-4411.pdf'));
    const forCeo = await attachments.listProjectAttachments(ceo(), projectId);
    assert.equal(forCeo.find((a) => a.originalFilename === 'PO-4411.pdf')?.isDeleted, true);
  });
});

describe('workBlockedReason', () => {
  test('names held, cancelled and completed; lets everything else through', async () => {
    const { workBlockedReason } = await import('../src/lib/projects/status');
    assert.match(workBlockedReason('on_hold')!, /on hold/);
    assert.match(workBlockedReason('cancelled')!, /cancelled/);
    assert.match(workBlockedReason('completed')!, /completed/);
    for (const s of ['new', 'awaiting_assignment', 'planned', 'in_progress', 'qa', 'revision_required']) {
      assert.equal(workBlockedReason(s), null, s);
    }
  });
});

describe('the activity feed says what happened (brief §25)', () => {
  test('status changes, attachments and deletes read as sentences', async () => {
    const { describeActivity } = await import('../src/lib/activity/describe');
    const say = (action: string, metadata: Record<string, unknown>) =>
      describeActivity({ action, actorName: 'pm', metadata });
    assert.equal(say('project.status_changed', { change: 'hold', reason: 'Client paused' }),
      'pm put the project on hold (Client paused)');
    assert.equal(say('project.status_changed', { change: 'resume' }), 'pm resumed the project');
    assert.equal(say('project.status_changed', { change: 'cancel', reason: 'Withdrawn' }),
      'pm cancelled the project (Withdrawn)');
    assert.equal(say('file.uploaded', { filename: 'PO.pdf' }), 'pm attached PO.pdf');
    assert.equal(say('file.uploaded', { filename: 'board.pdf', assignmentTitle: 'Cut' }),
      'pm attached board.pdf to the assignment Cut');
    assert.equal(say('file.uploaded', { filename: 'shot.png', revisionNo: 3 }), 'pm attached shot.png to revision #03');
    assert.equal(say('file.uploaded', { deliverableName: 'Video 01', versionNo: 2 }), 'pm uploaded Video 01 v2');
    assert.equal(say('file.deleted', { filename: 'old.mp4' }), 'pm deleted old.mp4');
    assert.equal(say('client.month_closed', { year: 2026, month: 9 }), 'pm closed September 2026');
    assert.equal(describeActivity({ action: 'client.month_closed', actorName: null, metadata: { year: 2026, month: 9, automatic: true } }),
      'September 2026 was archived automatically', 'the nightly archive is not “Someone”');
  });

  test('giving and taking back read access is on the record (brief §23, §25)', async () => {
    const { describeActivity } = await import('../src/lib/activity/describe');
    const { FEED_ACTIONS } = await import('../src/lib/activity/feed');
    const say = (action: string, metadata: Record<string, unknown>) =>
      describeActivity({ action, actorName: 'pm', metadata });
    assert.equal(say('project.shared', { userId: 9, userName: 'Rania Rep' }), 'pm shared the project with Rania Rep');
    assert.equal(say('project.unshared', { userId: 9, userName: 'Rania Rep' }),
      'pm stopped sharing the project with Rania Rep');
    assert.equal(say('project.shared', {}), 'pm shared the project with a Sales representative',
      'an old row without a name still reads as a sentence');
    assert.ok(FEED_ACTIONS.includes('project.shared') && FEED_ACTIONS.includes('project.unshared'),
      'both appear on the project timeline');
  });
});

describe('a notification that fails does not undo the action (brief §20)', { skip }, () => {
  test('the transaction still commits', async () => {
    const { getDb } = await import('../src/db');
    const { notifyUsers } = await import('../src/lib/notifications/notify');
    const { sql: q } = await import('drizzle-orm');
    const projectId = await newProject('Notify', [{ slug: 'video', lead: 'leadVideo', n: 1 }]);
    await getDb().transaction(async (tx) => {
      await tx.execute(q`UPDATE projects SET internal_notes = 'kept' WHERE id = ${projectId}`);
      // type is NOT NULL: the insert fails inside the transaction.
      const sent = await notifyUsers(tx, [ids.pm], { type: null as unknown as string, title: 'x' });
      assert.equal(sent, 0);
      await tx.execute(q`UPDATE projects SET priority = 'urgent' WHERE id = ${projectId}`);
    });
    const [row] = await sql`SELECT internal_notes, priority FROM projects WHERE id = ${projectId}`;
    assert.deepEqual([row.internal_notes, row.priority], ['kept', 'urgent']);
  });
});
