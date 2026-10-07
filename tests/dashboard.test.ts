/**
 * Per-role dashboards (brief §21) — the last Phase 1b piece.
 *
 * One fixture, four vantage points: the same projects counted by the PM,
 * by Sales, by a Team Lead and by an Executive give the numbers each of
 * them is allowed to see, and pricing appears only where it may.
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
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run dashboard tests';

let sql: ReturnType<typeof postgres>;
let storageRoot: string;
let loadDashboard: typeof import('../src/lib/dashboard/dashboard').loadDashboard;

const ids: Record<string, number> = {};

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0, email: `${role}@m12test.local`, fullName: role, role,
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

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE '%@m12test.local'`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM upload_sessions WHERE created_by IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'M12 Test%')`;
  await sql`DELETE FROM clients WHERE name LIKE 'M12 Test%'`;
  await sql`DELETE FROM files WHERE uploaded_by IN (${users})`;
  await sql`DELETE FROM department_members WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE '%@m12test.local'`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2088`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2078`;
}

before(async () => {
  if (skip) return;
  storageRoot = await mkdtemp(path.join(tmpdir(), 'aktivacity-m12-'));
  process.env.STORAGE_ROOT = storageRoot;
  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });

  ({ loadDashboard } = await import('../src/lib/dashboard/dashboard'));
  const uploads = await import('../src/lib/files/uploads');
  const { fileProject } = await import('../src/lib/projects/file-project');
  const { triageProject } = await import('../src/lib/projects/triage');
  const { createAssignment } = await import('../src/lib/planning/assign');
  const { reviewDeliverable } = await import('../src/lib/qa/review');
  const { updateDelivery } = await import('../src/lib/delivery/deliveries');
  const { createRevision } = await import('../src/lib/revisions/revisions');
  await purge();

  for (const slug of ['video', 'design']) {
    ids[slug] = Number((await sql`SELECT id FROM departments WHERE slug = ${slug}`)[0].id);
  }
  const mkUser = async (key: string, role: string) => {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES (${`${key}@m12test.local`}, 'x', ${key}, ${role}) RETURNING id`;
    ids[key] = Number(row.id);
  };
  for (const [k, r] of [
    ['sales', 'sales'], ['otherSales', 'sales'], ['pm', 'project_manager'],
    ['leadVideo', 'team_lead'], ['leadDesign', 'team_lead'], ['ahmed', 'executive'], ['sara', 'executive'],
  ] as const) await mkUser(k, r);
  const member = (key: string, slug: string, isLead = false) =>
    sql`INSERT INTO department_members (user_id, department_id, is_lead) VALUES (${ids[key]}, ${ids[slug]}, ${isLead})`;
  await member('leadVideo', 'video', true);
  await member('leadDesign', 'design', true);
  await member('ahmed', 'video');
  await member('sara', 'design');

  const [client] = await sql<{ id: number }[]>`
    INSERT INTO clients (name, owner_user_id, created_by) VALUES ('M12 Test Client', ${ids.sales}, ${ids.sales}) RETURNING id`;
  ids.client = Number(client.id);
  const upload = async (who: Actor, deliverableId: number, filename: string) => {
    const bytes = randomBytes(64);
    const { session } = await uploads.createUploadSession(who, { target: 'deliverable', deliverableId, filename, size: bytes.length });
    await uploads.appendChunk(who, session.id, 0, new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); },
    }));
    return uploads.completeUpload(who, session.id);
  };
  const route = (projectId: number, teams: { slug: string; lead: string; n: number }[]) =>
    triageProject(pm(), {
      projectId,
      teams: teams.map((t) => ({ departmentId: ids[t.slug], teamLeadId: ids[t.lead], plannedDeliverables: t.n })),
    });
  const teamOf = async (projectId: number, slug: string) =>
    Number((await sql`SELECT id FROM project_departments WHERE project_id = ${projectId} AND department_id = ${ids[slug]}`)[0].id);

  // A: Video ×2 (Ahmed: one approved and delivered, one sent back) + Design ×1 (Sara, in QA).
  //    A revision is open on the delivered video → project revision_required. Overdue.
  const a = await fileProject(sales(), {
    clientId: ids.client, period: '2088-09', title: 'A film', priceAmount: '10000.00', requiresPmQa: false,
    deadline: '2088-09-01',
    departments: [{ departmentId: ids.video, plannedDeliverables: 2 }, { departmentId: ids.design, plannedDeliverables: 1 }],
  });
  ids.projectA = a.projectId;
  await route(ids.projectA, [{ slug: 'video', lead: 'leadVideo', n: 2 }, { slug: 'design', lead: 'leadDesign', n: 1 }]);
  const va = await createAssignment(leadVideo(), {
    projectDepartmentId: await teamOf(ids.projectA, 'video'), assigneeId: ids.ahmed, title: 'Cut',
    deliverableCount: 2, deliverableBaseName: 'Video', endDate: '2088-09-01',
  });
  const da = await createAssignment(leadDesign(), {
    projectDepartmentId: await teamOf(ids.projectA, 'design'), assigneeId: ids.sara, title: 'Thumb', deliverableCount: 1,
  });
  await upload(ahmed(), va.deliverableIds[0], 'v1.mp4');
  const ok = await reviewDeliverable(leadVideo(), { deliverableId: va.deliverableIds[0], decision: 'approved' });
  await updateDelivery(sales(), { deliveryId: ok.deliveryId!, status: 'delivered' });
  await upload(ahmed(), va.deliverableIds[1], 'v2.mp4');
  await reviewDeliverable(leadVideo(), { deliverableId: va.deliverableIds[1], decision: 'changes_requested', comments: 'Again.' });
  await upload(sara(), da.deliverableIds[0], 'thumb.png');
  await createRevision(sales(), {
    projectId: ids.projectA, title: 'Logo', clientFeedback: 'Move it.', deliverableIds: [va.deliverableIds[0]],
  });
  await sql`UPDATE projects SET deadline = current_date - 3 WHERE id = ${ids.projectA}`;
  await sql`UPDATE assignments SET end_date = current_date + 2 WHERE id = ${va.assignmentId}`;

  // B: Design only, routed to the Design lead, nothing planned yet.
  const b = await fileProject(sales(), {
    clientId: ids.client, period: '2088-09', title: 'B designs', priceAmount: '2500.00',
    departments: [{ departmentId: ids.design, plannedDeliverables: 20 }],
  });
  ids.projectB = b.projectId;
  await route(ids.projectB, [{ slug: 'design', lead: 'leadDesign', n: 20 }]);

  // C: filed, untouched — sits in intake. Filed "this month" so the value shows up there.
  const now = new Date();
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const c = await fileProject(sales(), {
    clientId: ids.client, period, title: 'C new', priceAmount: '4000.00',
    departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
  });
  ids.projectC = c.projectId;

  // D: Video, approved and waiting for Sales to deliver.
  const d = await fileProject(sales(), {
    clientId: ids.client, period: '2088-09', title: 'D ready', requiresPmQa: true,
    departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
  });
  ids.projectD = d.projectId;
  await route(ids.projectD, [{ slug: 'video', lead: 'leadVideo', n: 1 }]);
  const vd = await createAssignment(leadVideo(), {
    projectDepartmentId: await teamOf(ids.projectD, 'video'), assigneeId: ids.ahmed, title: 'D cut', deliverableCount: 1,
  });
  await upload(ahmed(), vd.deliverableIds[0], 'd.mp4');
  await reviewDeliverable(leadVideo(), { deliverableId: vd.deliverableIds[0], decision: 'approved' });
  // Sits at PM QA.

  // E: completed.
  const e = await fileProject(sales(), {
    clientId: ids.client, period: '2088-08', title: 'E done', priceAmount: '999.00',
    departments: [{ departmentId: ids.design, plannedDeliverables: 1 }],
  });
  ids.projectE = e.projectId;
  await sql`UPDATE projects SET status = 'completed', completed_at = now() WHERE id = ${ids.projectE}`;

  // F: Design only, four banners by Sara, each approved by the lead alone
  //    (no PM stage), so every approval wrote a deliveries row — the raw
  //    material of department performance (§21). Once the approvals are in,
  //    the project deadline is moved to ten days ago, so the two undated
  //    banners are judged by a deadline it was actually possible to miss:
  //      [0] due 50 days ago, approved 40 days ago → late; inside the 90-day
  //          on-time window but outside the 30-day throughput window;
  //      [1] due next week, approved today → on time;
  //      [2] no due date, approved 20 days ago → by the project deadline
  //          (10 days ago) → on time;
  //      [3] no due date, approved today → by the project deadline → late.
  //    Reading an undated slot as always on time gives 3 of 4, as always
  //    late 1 of 4, and leaving undated slots out 1 of 2; only the fallback
  //    to the deadline gives 2 of 4.
  //    All date arithmetic is done in SQL with margins of a week or more, so
  //    the DB session's calendar and the machine's cannot disagree.
  const f = await fileProject(sales(), {
    clientId: ids.client, period: '2078-09', title: 'F banners', requiresPmQa: false, deadline: '2078-09-30',
    departments: [{ departmentId: ids.design, plannedDeliverables: 4 }],
  });
  ids.projectF = f.projectId;
  await route(ids.projectF, [{ slug: 'design', lead: 'leadDesign', n: 4 }]);
  const df = await createAssignment(leadDesign(), {
    projectDepartmentId: await teamOf(ids.projectF, 'design'), assigneeId: ids.sara, title: 'Banners', deliverableCount: 4,
  });
  await sql`UPDATE deliverables SET due_date = current_date - 50 WHERE id = ${df.deliverableIds[0]}`;
  await sql`UPDATE deliverables SET due_date = current_date + 7 WHERE id = ${df.deliverableIds[1]}`;
  for (const [i, id] of df.deliverableIds.entries()) {
    await upload(sara(), id, `banner-${i + 1}.png`);
    await reviewDeliverable(leadDesign(), { deliverableId: id, decision: 'approved' });
  }
  await sql`UPDATE deliveries SET approved_at = now() - interval '40 days' WHERE deliverable_id = ${df.deliverableIds[0]}`;
  await sql`UPDATE deliveries SET approved_at = now() - interval '20 days' WHERE deliverable_id = ${df.deliverableIds[2]}`;
  await sql`UPDATE projects SET deadline = current_date - 10 WHERE id = ${ids.projectF}`;

  // G: Design only, no project deadline, one banner by Sara with no due
  //    date, approved today: nothing to judge it by, so it counts toward
  //    throughput and is left out of the on-time rate.
  const g = await fileProject(sales(), {
    clientId: ids.client, period: '2078-10', title: 'G banner', requiresPmQa: false,
    departments: [{ departmentId: ids.design, plannedDeliverables: 1 }],
  });
  ids.projectG = g.projectId;
  await route(ids.projectG, [{ slug: 'design', lead: 'leadDesign', n: 1 }]);
  const dg = await createAssignment(leadDesign(), {
    projectDepartmentId: await teamOf(ids.projectG, 'design'), assigneeId: ids.sara, title: 'G banner', deliverableCount: 1,
  });
  await upload(sara(), dg.deliverableIds[0], 'g.png');
  await reviewDeliverable(leadDesign(), { deliverableId: dg.deliverableIds[0], decision: 'approved' });
});

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
  await rm(storageRoot, { recursive: true, force: true });
});

/** The dashboards count everything visible; pin the assertions to this suite's client. */
async function scoped(who: Actor) {
  // Sales sees only their own client, so nothing else leaks in. For the
  // PM, who sees every suite's projects, the counts are checked as deltas.
  return loadDashboard(who);
}

describe('the Sales dashboard (brief §21, §23)', { skip }, () => {
  test('counts the rep’s projects by where they stand, with value', async () => {
    const d = await scoped(sales());
    assert.equal(d.counts.total, 7);
    assert.equal(d.counts.active, 6, 'A, B, C, D, F and G; E is completed');
    assert.equal(d.counts.new, 1, 'C');
    assert.equal(d.counts.planned, 1, 'B');
    assert.equal(d.counts.inRevision, 1, 'A');
    assert.equal(d.counts.inQa, 2, 'A (thumbnail) and D (PM stage)');
    assert.equal(d.counts.completed, 1, 'E');
    assert.equal(d.counts.delayed, 2, 'A and F are past their deadlines with files still to deliver');
    assert.equal(d.pendingDeliveries, 5, 'F’s four banners and G’s one wait for Sales; D is still at PM QA');
    assert.equal(d.openRevisions, 1);
    assert.ok(d.value, 'Sales may see pricing');
    assert.equal(d.value!.active, '16500.00', 'A + B + C; E is completed');
    assert.equal(d.value!.thisMonth, '4000.00', 'C was filed this month');
    assert.deepEqual(d.intake.map((p) => p.title), ['C new']);
    assert.deepEqual(d.workload, [], 'Sales does not plan');
    assert.equal(d.executive, null);
  });

  test('another rep sees none of it', async () => {
    const d = await scoped(otherSales());
    assert.equal(d.counts.total, 0);
    assert.equal(d.value!.active, '0');
    assert.deepEqual(d.intake, []);
  });
});

/**
 * A Team Lead's scope is their whole department (brief §23), so in a shared
 * database their counts include other suites' and the demo's projects. The
 * assertions below are therefore lower bounds plus the fixture's own rows;
 * the Sales and Executive dashboards, scoped to one person, are exact.
 */
describe('the Team Lead dashboard', { skip }, () => {
  test('the Design lead sees only Design: the unplanned team, the thumbnail in QA, no pricing', async () => {
    const d = await scoped(leadDesign());
    assert.equal(d.value, null, 'no pricing for a lead (§23)');
    assert.deepEqual(d.departments.map((t) => t.name), ['Design']);
    const design = d.departments[0];
    assert.ok(design.activeProjects >= 2, 'A and B at least');
    assert.ok(design.inQa >= 1, 'the thumbnail');
    assert.ok(d.qaQueue >= 1, 'the thumbnail waits for this lead');
    assert.ok(d.planningGaps.some((g) => g.title === 'B designs'), 'B is routed to Design and unplanned');
    assert.ok(!d.planningGaps.some((g) => g.title === 'A film'), 'A is planned');
    assert.deepEqual(d.intake, []);
    assert.deepEqual(d.workload.map((w) => w.name), ['Design']);
    assert.ok(d.workload[0].members.some((m) => m.fullName === 'sara' && m.openSlots === 1));
    assert.ok(!d.deadlines.some((x) => x.title === 'Cut'), 'Ahmed’s Video assignment is not hers to chase');
  });

  test('the Video lead sees the revision, the sent-back slot, and the project deadline', async () => {
    const d = await scoped(leadVideo());
    assert.deepEqual(d.departments.map((t) => t.name), ['Video']);
    const video = d.departments[0];
    assert.ok(video.reviews >= 3, 'two rounds on A, one on D');
    assert.ok(video.rejected >= 1);
    assert.ok(d.openRevisions >= 1);
    assert.ok(d.counts.delayed >= 1);
    assert.ok(!d.planningGaps.some((g) => g.title === 'C new'), 'C is not routed yet, so not a gap');
    assert.ok(!d.planningGaps.some((g) => g.title === 'B designs'), 'B is Design’s, not Video’s');
    assert.ok(d.deadlines.some((x) => x.kind === 'project' && x.title === 'A film' && x.daysLeft === -3));
    assert.ok(d.deadlines.some((x) => x.kind === 'assignment' && x.title === 'Cut' && x.daysLeft === 2));
  });
});

describe('the Project Manager dashboard', { skip }, () => {
  test('sees every department, intake, its own QA queue and pricing', async () => {
    const d = await scoped(pm());
    assert.ok(d.value);
    assert.ok(d.departments.length >= 2);
    assert.ok(d.intake.some((p) => p.title === 'C new'));
    const beforeD = await sql`SELECT count(*)::int AS n FROM deliverables WHERE status = 'awaiting_pm_qa'`;
    assert.equal(d.qaQueue, Number(beforeD[0].n), 'every slot waiting on a PM');
    assert.ok(d.workload.some((w) => w.name === 'Video' && w.members.some((m) => m.fullName === 'ahmed')));
    assert.equal(d.executive, null);
  });
});

describe('the Executive dashboard', { skip }, () => {
  test('Ahmed: his assignments, slots by state, the revision on his work, and his deadline', async () => {
    const d = await scoped(ahmed());
    assert.ok(d.executive);
    assert.equal(d.executive!.activeAssignments, 2, 'Cut and D cut');
    assert.equal(d.executive!.currentProjects, 2);
    // Opening the revision sent the delivered video back to him (§15), so
    // both A slots are to redo and nothing of his counts as completed yet.
    assert.equal(d.executive!.pendingDeliverables, 3, 'two A videos to redo and D at PM QA');
    assert.equal(d.executive!.inQa, 1);
    assert.equal(d.executive!.toRedo, 2);
    assert.equal(d.executive!.completedDeliverables, 0);
    assert.equal(d.openRevisions, 1);
    assert.equal(d.value, null);
    assert.deepEqual(d.departments, []);
    assert.deepEqual(d.workload, []);
    assert.deepEqual(d.intake, []);
    assert.deepEqual(d.deadlines.map((x) => [x.kind, x.title, x.daysLeft]), [['assignment', 'Cut', 2]]);
  });

  test('Sara sees only her own slot', async () => {
    const d = await scoped(sara());
    assert.equal(d.executive!.activeAssignments, 1, 'Thumb; the F and G assignments closed when their last slots were signed off');
    assert.equal(d.executive!.inQa, 1);
    assert.equal(d.executive!.completedDeliverables, 5, 'F’s four banners and G’s one');
    assert.equal(d.openRevisions, 1, 'she is on project A, so she sees its revision (§16)');
    assert.deepEqual(d.deadlines, []);
  });
});

/**
 * Department performance (brief §21): throughput is slots approved in the
 * last 30 days; the on-time rate is the share of the last 90 days' approvals
 * that met the slot's due date, or the project deadline when the slot has
 * none (a slot with neither is not measured). An approval is a deliveries
 * row, so a file later sent back for revision still counts as having been
 * approved on time.
 */
describe('department performance (brief §21)', { skip }, () => {
  test('on-time rate and throughput per department, over the rep’s own projects', async () => {
    const d = await scoped(sales());
    const by = new Map(d.departments.map((t) => [t.name, t]));

    // F's deadline is ten days past, so its two undated banners land on
    // either side of it: [2] approved before it, [3] after. G's banner has
    // no date at all. See the fixture for what each wrong reading would give.
    const design = by.get('Design')!;
    assert.equal(design.throughput, 4, 'F [1], [2], [3] and G were approved within 30 days; F [0], 40 days ago, is outside the window');
    assert.equal(design.onTimeMeasured, 4, 'F [0] and [1] by their due date, F [2] and [3] by the project deadline; G, with neither, is not measured');
    assert.equal(design.onTime, 2, 'F [1] met its due date and F [2] the deadline; [0] was ten days late and [3] came after the deadline');
    assert.equal(design.onTimeRate, 50, '2 of 4');

    const video = by.get('Video')!;
    assert.equal(video.throughput, 1, 'A’s first video, approved today; D is still at PM QA and the second video was sent back');
    assert.equal(video.onTimeMeasured, 1);
    assert.equal(video.onTime, 1, 'due 2088-09-01; the revision that later reopened it does not undo the approval');
    assert.equal(video.onTimeRate, 100);

    const development = by.get('Development')!;
    assert.equal(development.throughput, 0);
    assert.equal(development.onTimeMeasured, 0);
    assert.equal(development.onTime, 0);
    assert.equal(development.onTimeRate, null, 'nothing approved reads n/a, not 0%');
  });

  test('management sees the figures over every project', async () => {
    // Every suite's and the demo's approvals share this window, so these
    // are lower bounds; the exact figures are pinned through the rep above.
    const d = await scoped(actor('ceo'));
    const design = d.departments.find((t) => t.name === 'Design')!;
    assert.ok(design.onTimeMeasured >= 4, 'F’s four banners at least');
    assert.ok(design.onTime >= 2, 'F [1] and [2] at least');
    assert.ok(design.onTimeMeasured - design.onTime >= 2, 'F [0] and [3] were late, whatever else is in the window');
    assert.ok(design.throughput >= 4);
    for (const t of d.departments) {
      assert.equal(typeof t.throughput, 'number', t.name);
      assert.equal(typeof t.onTimeMeasured, 'number', t.name);
      assert.equal(typeof t.onTime, 'number', t.name);
      assert.ok(t.onTime <= t.onTimeMeasured, t.name);
      assert.equal(t.onTimeRate === null, t.onTimeMeasured === 0, `${t.name}: n/a exactly when nothing was measured`);
      assert.ok(t.onTimeRate === null || (t.onTimeRate >= 0 && t.onTimeRate <= 100), t.name);
    }
  });
});
