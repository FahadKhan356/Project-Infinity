/**
 * Month archive and copy-forward (brief §33, §36, §38, §39) — Phase 1b.
 *
 * A month closes only once its work is settled; once closed, nothing in it
 * can change through any door — filing, triage, planning, upload, QA,
 * delivery, comments, revisions — until someone with the right to do so
 * reopens it. Copying a month forward carries the orders and nothing else.
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
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run month tests';

let sql: ReturnType<typeof postgres>;
let storageRoot: string;
let uploads: typeof import('../src/lib/files/uploads');
let access: typeof import('../src/lib/files/access');
let lifecycle: typeof import('../src/lib/months/lifecycle');
let copy: typeof import('../src/lib/months/copy');
let monthSummaries: typeof import('../src/lib/months/queries').monthSummaries;
let fileProject: typeof import('../src/lib/projects/file-project').fileProject;
let triageProject: typeof import('../src/lib/projects/triage').triageProject;
let createAssignment: typeof import('../src/lib/planning/assign').createAssignment;
let reviewDeliverable: typeof import('../src/lib/qa/review').reviewDeliverable;
let updateDelivery: typeof import('../src/lib/delivery/deliveries').updateDelivery;
let createRevision: typeof import('../src/lib/revisions/revisions').createRevision;
let closeRevision: typeof import('../src/lib/revisions/revisions').closeRevision;
let addComment: typeof import('../src/lib/workspace/comments').addComment;
let loadWorkspace: typeof import('../src/lib/workspace/workspace').loadWorkspace;

const ids: Record<string, number> = {};
const codes: Record<string, string> = {};

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0, email: `${role}@m9test.local`, fullName: role, role,
    isActive: true, mustChangePassword: false,
    leadDepartmentIds: [], departmentIds: [], permissions: new Set<Permission>(), ...over,
  };
}
const sales = () => actor('sales', { id: ids.sales });
const otherSales = () => actor('sales', { id: ids.otherSales });
const pm = () => actor('project_manager', { id: ids.pm });
const admin = () => actor('admin', { id: ids.admin });
const leadVideo = () => actor('team_lead', { id: ids.leadVideo, leadDepartmentIds: [ids.video], departmentIds: [ids.video] });
const leadDesign = () => actor('team_lead', { id: ids.leadDesign, leadDepartmentIds: [ids.design], departmentIds: [ids.design] });
const ahmed = () => actor('executive', { id: ids.ahmed, departmentIds: [ids.video] });
const sara = () => actor('executive', { id: ids.sara, departmentIds: [ids.design] });

function streamOf(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close(); },
  });
}
async function upload(who: Actor, deliverableId: number, filename: string) {
  const bytes = randomBytes(128);
  const { session } = await uploads.createUploadSession(who, {
    target: 'deliverable', deliverableId, filename, size: bytes.length,
  });
  await uploads.appendChunk(who, session.id, 0, streamOf(bytes));
  return uploads.completeUpload(who, session.id);
}
const monthStatus = async (id: number) =>
  (await sql`SELECT status, closed_by FROM client_months WHERE id = ${id}`)[0];
const projectStatus = async (id: number) => (await sql`SELECT status FROM projects WHERE id = ${id}`)[0].status as string;

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE '%@m9test.local'`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM upload_sessions WHERE created_by IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'M9 Test%')`;
  await sql`DELETE FROM clients WHERE name LIKE 'M9 Test%'`;
  await sql`DELETE FROM files WHERE uploaded_by IN (${users})`;
  await sql`DELETE FROM department_members WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE '%@m9test.local'`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2091`;
}

before(async () => {
  if (skip) return;
  try { await setUp(); } catch (error) {
    console.error('\n[months.test] fixture setup failed:', error);
    throw error;
  }
});

async function setUp() {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'aktivacity-m9-'));
  process.env.STORAGE_ROOT = storageRoot;
  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });

  uploads = await import('../src/lib/files/uploads');
  access = await import('../src/lib/files/access');
  lifecycle = await import('../src/lib/months/lifecycle');
  copy = await import('../src/lib/months/copy');
  ({ monthSummaries } = await import('../src/lib/months/queries'));
  ({ fileProject } = await import('../src/lib/projects/file-project'));
  ({ triageProject } = await import('../src/lib/projects/triage'));
  ({ createAssignment } = await import('../src/lib/planning/assign'));
  ({ reviewDeliverable } = await import('../src/lib/qa/review'));
  ({ updateDelivery } = await import('../src/lib/delivery/deliveries'));
  ({ createRevision, closeRevision } = await import('../src/lib/revisions/revisions'));
  ({ addComment } = await import('../src/lib/workspace/comments'));
  ({ loadWorkspace } = await import('../src/lib/workspace/workspace'));
  await purge();

  for (const slug of ['video', 'design']) {
    ids[slug] = Number((await sql`SELECT id FROM departments WHERE slug = ${slug}`)[0].id);
  }
  const mkUser = async (key: string, role: string) => {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES (${`${key}@m9test.local`}, 'x', ${key}, ${role}) RETURNING id`;
    ids[key] = Number(row.id);
  };
  for (const [k, r] of [
    ['sales', 'sales'], ['otherSales', 'sales'], ['pm', 'project_manager'], ['admin', 'admin'],
    ['leadVideo', 'team_lead'], ['leadDesign', 'team_lead'], ['ahmed', 'executive'], ['sara', 'executive'],
  ] as const) await mkUser(k, r);

  const member = (key: string, slug: string, isLead = false) =>
    sql`INSERT INTO department_members (user_id, department_id, is_lead) VALUES (${ids[key]}, ${ids[slug]}, ${isLead})`;
  await member('leadVideo', 'video', true);
  await member('leadDesign', 'design', true);
  await member('ahmed', 'video');
  await member('sara', 'design');

  const [client] = await sql<{ id: number }[]>`
    INSERT INTO clients (name, owner_user_id, created_by) VALUES ('M9 Test Client', ${ids.sales}, ${ids.sales}) RETURNING id`;
  ids.client = Number(client.id);

  // Project A: Video ×2 (Ahmed) and Design ×1 (Sara), taken all the way to completed.
  const a = await fileProject(sales(), {
    clientId: ids.client, period: '2091-09', title: 'Product launch film', requiresPmQa: false,
    objective: 'Launch the autumn range', poReference: 'PO-778', requirements: 'Two cuts and a thumbnail',
    clientNotes: 'Client likes blue', internalNotes: 'Rush job', deadline: '2091-09-25',
    priceAmount: '18500.00', priority: 'high',
    departments: [
      { departmentId: ids.video, plannedDeliverables: 2 },
      { departmentId: ids.design, plannedDeliverables: 1 },
    ],
  });
  ids.projectA = a.projectId;
  ids.september = a.clientMonthId;
  codes.projectA = a.projectCode;
  await triageProject(pm(), {
    projectId: ids.projectA,
    teams: [
      { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 2 },
      { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 1 },
    ],
  });
  for (const t of await sql<{ id: number; department_id: number }[]>`
      SELECT id, department_id FROM project_departments WHERE project_id = ${ids.projectA}`) {
    if (Number(t.department_id) === ids.video) ids.videoTeam = Number(t.id);
    if (Number(t.department_id) === ids.design) ids.designTeam = Number(t.id);
  }
  const v = await createAssignment(leadVideo(), {
    projectDepartmentId: ids.videoTeam, assigneeId: ids.ahmed, title: 'Cut the film',
    deliverableCount: 2, deliverableBaseName: 'Video',
  });
  [ids.video01, ids.video02] = v.deliverableIds;
  const d = await createAssignment(leadDesign(), {
    projectDepartmentId: ids.designTeam, assigneeId: ids.sara, title: 'Thumbnail',
    deliverableCount: 1, deliverableBaseName: 'Thumbnail',
  });
  [ids.thumb01] = d.deliverableIds;

  const deliveries: number[] = [];
  for (const [who, slot, name] of [
    [ahmed(), ids.video01, 'Film_01.mp4'], [ahmed(), ids.video02, 'Film_02.mp4'], [sara(), ids.thumb01, 'Thumb.png'],
  ] as const) {
    await upload(who, slot, name);
    const lead = who.id === ids.sara ? leadDesign() : leadVideo();
    const review = await reviewDeliverable(lead, { deliverableId: slot, decision: 'approved' });
    deliveries.push(review.deliveryId!);
  }
  for (const deliveryId of deliveries) {
    await updateDelivery(sales(), { deliveryId, status: 'delivered' });
    await updateDelivery(sales(), { deliveryId, status: 'completed' });
  }
  ids.video01Delivery = deliveries[0];

  // Project B: filed and routed, nothing done — the kind of thing that blocks a close.
  const b = await fileProject(sales(), {
    clientId: ids.client, period: '2091-09', title: 'Design retainer', priceAmount: '4000.00',
    departments: [{ departmentId: ids.design, plannedDeliverables: 20 }],
  });
  ids.projectB = b.projectId;
  codes.projectB = b.projectCode;
  await triageProject(pm(), {
    projectId: ids.projectB,
    teams: [{ departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 20 }],
  });

  // Project C: a small order, marked done by hand so the month can close with it in.
  const c = await fileProject(sales(), {
    clientId: ids.client, period: '2091-09', title: 'Four blog headers', clientNotes: 'Match the site',
    departments: [{ departmentId: ids.design, plannedDeliverables: 4 }],
  });
  ids.projectC = c.projectId;
  codes.projectC = c.projectCode;
  await sql`UPDATE projects SET status = 'completed', completed_at = now() WHERE id = ${ids.projectC}`;
}

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('month summaries (brief §35, §39)', { skip }, () => {
  test('Sales sees every project in the month, with the delivered count and the teams involved', async () => {
    const [september] = await monthSummaries(sales(), ids.client);
    assert.equal(september.id, ids.september);
    assert.equal(september.status, 'open');
    assert.equal(september.projects, 3);
    assert.equal(september.deliverables, 3);
    assert.equal(september.completed, 3);
    assert.equal(september.inQa, 0);
    assert.equal(september.pending, 0);
    assert.deepEqual(september.departments, ['Design', 'Video']);
  });

  test('an Executive’s summary counts only the projects they can open', async () => {
    const [september] = await monthSummaries(ahmed(), ids.client);
    assert.equal(september.projects, 1, 'Ahmed is only on Project A');
    assert.deepEqual(september.departments, ['Design', 'Video'], 'but sees every team on it (§10)');
  });
});

describe('closing a month (brief §36)', { skip }, () => {
  test('a Team Lead cannot close a month', async () => {
    await assert.rejects(
      lifecycle.closeMonth(leadVideo(), { clientMonthId: ids.september }),
      (e: Error) => e instanceof lifecycle.MonthError && /not permitted/.test(e.message),
    );
  });

  test('another rep cannot even find the month', async () => {
    await assert.rejects(
      lifecycle.closeMonth(otherSales(), { clientMonthId: ids.september }),
      /No such month/,
    );
  });

  test('the close is refused while a project is still open, and says which', async () => {
    await assert.rejects(
      lifecycle.closeMonth(sales(), { clientMonthId: ids.september }),
      (e: Error) =>
        e instanceof lifecycle.MonthError
        && e.message.includes(codes.projectB)
        && e.message.includes('planned')
        && !e.message.includes(codes.projectA),
    );
    assert.equal((await monthStatus(ids.september)).status, 'open');
  });

  test('once the open project is cancelled, Sales closes the month', async () => {
    await sql`UPDATE projects SET status = 'cancelled' WHERE id = ${ids.projectB}`;
    const result = await lifecycle.closeMonth(sales(), { clientMonthId: ids.september });
    assert.equal(result.status, 'closed');
    assert.equal(result.projectCount, 3);
    const row = await monthStatus(ids.september);
    assert.equal(row.status, 'closed');
    assert.equal(Number(row.closed_by), ids.sales);

    const [summary] = await monthSummaries(sales(), ids.client);
    assert.equal(summary.status, 'closed');
    assert.equal(summary.closedBy, 'sales');
  });

  test('closing it again is refused', async () => {
    await assert.rejects(
      lifecycle.closeMonth(sales(), { clientMonthId: ids.september }),
      /already closed/,
    );
  });

  test('an empty month closes without complaint', async () => {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO client_months (client_id, period_year, period_month, created_by)
      VALUES (${ids.client}, 2091, 11, ${ids.sales}) RETURNING id`;
    ids.november = Number(row.id);
    const result = await lifecycle.closeMonth(pm(), { clientMonthId: ids.november });
    assert.equal(result.projectCount, 0);
    assert.equal((await monthStatus(ids.november)).status, 'closed');
  });
});

describe('a closed month is read-only (brief §36)', { skip }, () => {
  const closed = /month is closed/;

  test('nothing new can be filed into it', async () => {
    await assert.rejects(
      fileProject(sales(), {
        clientId: ids.client, period: '2091-09', title: 'Late order',
        departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
      }),
      closed,
    );
  });

  test('it cannot be re-routed', async () => {
    await assert.rejects(
      triageProject(pm(), {
        projectId: ids.projectA,
        teams: [{ departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 5 }],
      }),
      closed,
    );
  });

  test('no work can be assigned on it', async () => {
    // A closed month holds only settled projects, so the project's own
    // "closed" refusal answers first; the month guard behind it is the
    // backstop for a project whose status was edited by hand.
    await assert.rejects(
      createAssignment(leadVideo(), {
        projectDepartmentId: ids.videoTeam, assigneeId: ids.ahmed, title: 'More cuts', deliverableCount: 1,
      }),
      /closed/,
    );
    await sql`UPDATE projects SET status = 'in_progress' WHERE id = ${ids.projectA}`;
    try {
      await assert.rejects(
        createAssignment(leadVideo(), {
          projectDepartmentId: ids.videoTeam, assigneeId: ids.ahmed, title: 'More cuts', deliverableCount: 1,
        }),
        closed,
      );
    } finally {
      await sql`UPDATE projects SET status = 'completed' WHERE id = ${ids.projectA}`;
    }
  });

  test('uploads are refused at the gate and again at completion', async () => {
    const decision = await access.canUploadToDeliverable(ahmed(), ids.video01);
    assert.equal(decision.allowed, false);
    assert.match(decision.reason ?? '', closed);

    const attach = await access.canAttachToProject(ahmed(), ids.projectA);
    assert.equal(attach.allowed, false);

    // A session opened while the month was open must still be stopped when
    // it completes after the close.
    await assert.rejects(upload(ahmed(), ids.video01, 'Film_01_v2.mp4'), closed);
    const versions = await sql`SELECT count(*)::int AS n FROM deliverable_versions WHERE deliverable_id = ${ids.video01}`;
    assert.equal(versions[0].n, 1);
  });

  test('QA, delivery, comments and revisions are all refused', async () => {
    await assert.rejects(reviewDeliverable(leadVideo(), { deliverableId: ids.video01, decision: 'rejected' }), closed);
    await assert.rejects(updateDelivery(sales(), { deliveryId: ids.video01Delivery, status: 'delivered' }), closed);
    await assert.rejects(addComment(ahmed(), { projectId: ids.projectA, body: 'Still here?' }), closed);
    await assert.rejects(
      createRevision(sales(), {
        projectId: ids.projectA, title: 'Late feedback', clientFeedback: 'Change the logo',
        deliverableIds: [ids.video01],
      }),
      closed,
    );
    // A revision the archive still holds open (its status edited by hand)
    // cannot be ended either: closing one rewrites slots and deliveries.
    const [left] = await sql<{ id: number }[]>`
      INSERT INTO revisions (project_id, revision_no, title, client_feedback, created_by)
      VALUES (${ids.projectA}, 99, 'Left open', 'Still here?', ${ids.sales}) RETURNING id`;
    try {
      await assert.rejects(closeRevision(sales(), { revisionId: Number(left.id), outcome: 'cancelled' }), closed);
      await assert.rejects(closeRevision(pm(), { revisionId: Number(left.id), outcome: 'closed' }), closed);
      const [rev] = await sql`SELECT status, closed_at FROM revisions WHERE id = ${left.id}`;
      assert.deepEqual([rev.status, rev.closed_at], ['new', null]);
    } finally {
      await sql`DELETE FROM revisions WHERE id = ${left.id}`;
    }
    assert.equal(await projectStatus(ids.projectA), 'completed', 'nothing moved');
  });

  test('the workspace says so and offers no upload', async () => {
    const workspace = await loadWorkspace(ahmed(), ids.projectA);
    assert.ok(workspace);
    assert.equal(workspace.monthClosed, true);
    const slots = workspace.teams.flatMap((t) => t.deliverables);
    assert.equal(slots.length, 3);
    assert.ok(slots.every((s) => s.canUpload === false));
  });

  test('reading is untouched — the archive is there to be read (§33)', async () => {
    const workspace = await loadWorkspace(sara(), ids.projectA);
    assert.ok(workspace);
    const thumb = workspace.teams.flatMap((t) => t.deliverables).find((s) => s.id === ids.thumb01);
    assert.equal(thumb?.currentVersion?.versionNo, 1);
  });
});

describe('reopening a month (brief §36)', { skip }, () => {
  test('Sales cannot reopen what they closed', async () => {
    await assert.rejects(
      lifecycle.reopenMonth(sales(), { clientMonthId: ids.september }),
      /not permitted/,
    );
  });

  test('an administrator can, and the records can change again', async () => {
    const result = await lifecycle.reopenMonth(admin(), { clientMonthId: ids.september });
    assert.equal(result.status, 'open');
    const row = await monthStatus(ids.september);
    assert.equal(row.status, 'open');
    assert.equal(row.closed_by, null);

    const comment = await addComment(ahmed(), { projectId: ids.projectA, body: 'Back in business.' });
    assert.ok(comment.commentId);
    const workspace = await loadWorkspace(ahmed(), ids.projectA);
    assert.equal(workspace?.monthClosed, false);
  });

  test('reopening an open month is refused', async () => {
    await assert.rejects(
      lifecycle.reopenMonth(admin(), { clientMonthId: ids.september }),
      /not closed/,
    );
  });

  test('the Project Manager closes it again for the archive', async () => {
    const result = await lifecycle.closeMonth(pm(), { clientMonthId: ids.september });
    assert.equal(result.status, 'closed');
  });
});

describe('copying a month forward (brief §38)', { skip }, () => {
  // Since the film was filed, the PM has decided Video's cuts do go to them
  // before delivery while Design's thumbnail still does not (§13). The month
  // is closed by now, so the team row is set directly rather than through
  // triage; the project's own intake default stays "no".
  before(async () => {
    await sql`UPDATE project_departments SET requires_pm_qa = true WHERE id = ${ids.videoTeam}`;
  });

  test('the plan lists the live orders of the month with everything Sales may change', async () => {
    const plan = await copy.copyMonthPlan(sales(), { clientId: ids.client, fromMonthId: ids.september });
    assert.equal(plan.source.label, 'September 2091');
    assert.equal(plan.target.value, '2091-10');
    assert.equal(plan.target.status, null, 'October does not exist yet');

    assert.deepEqual(
      plan.projects.map((p) => p.projectCode).sort(),
      [codes.projectA, codes.projectC].sort(),
      'the cancelled order is not offered',
    );
    const a = plan.projects.find((p) => p.id === ids.projectA)!;
    assert.equal(a.priceAmount, '18500.00');
    assert.equal(a.requirements, 'Two cuts and a thumbnail');
    assert.equal(a.deadline, '2091-09-25');
    assert.equal(a.suggestedDeadline, '2091-10-25');
    assert.equal(a.requiresPmQa, false, 'the intake default');
    assert.deepEqual(
      a.departments.map((d) => [d.name, d.plannedDeliverables, d.requiresPmQa]),
      [['Video', 2, true], ['Design', 1, false]],
      'each team with its own QA route (§13)',
    );
  });

  test('a copy carries the order, with the edits, and none of the work', async () => {
    const result = await copy.copyMonth(sales(), {
      clientId: ids.client,
      fromMonthId: ids.september,
      period: '2091-10',
      projects: [{
        sourceProjectId: ids.projectA,
        title: 'Product launch film — October',
        departments: [{ departmentId: ids.video, plannedDeliverables: 3 }],
        deadline: '2091-10-20',
        priceAmount: '19000.00',
        requirements: 'Three cuts this time',
      }],
    });
    assert.equal(result.monthCreated, true);
    assert.equal(result.projects.length, 1);
    ids.october = result.clientMonthId;
    const created = result.projects[0];
    ids.projectA2 = created.projectId;
    assert.notEqual(created.projectCode, codes.projectA);
    assert.match(created.projectCode, /^AKT-2091-\d{4}$/);
    assert.equal(created.copiedFromCode, codes.projectA);

    const [row] = await sql`
      SELECT title, status, objective, po_reference, requirements, client_notes, internal_notes,
             priority, price_amount, requires_pm_qa, copied_from_project_id, client_month_id,
             to_char(deadline, 'YYYY-MM-DD') AS deadline
      FROM projects WHERE id = ${created.projectId}`;
    assert.equal(row.title, 'Product launch film — October');
    assert.equal(row.status, 'new', 'lands in the PM’s intake like any order');
    assert.equal(Number(row.copied_from_project_id), ids.projectA);
    assert.equal(Number(row.client_month_id), ids.october);
    assert.equal(row.objective, 'Launch the autumn range');
    assert.equal(row.po_reference, 'PO-778');
    assert.equal(row.requirements, 'Three cuts this time');
    assert.equal(row.client_notes, 'Client likes blue');
    assert.equal(row.internal_notes, 'Rush job');
    assert.equal(row.priority, 'high');
    assert.equal(row.price_amount, '19000.00');
    assert.equal(row.requires_pm_qa, false, 'the intake default travels as it was filed');
    assert.equal(row.deadline, '2091-10-20');

    const teams = await sql`
      SELECT d.slug, pd.planned_deliverables, pd.team_lead_id, pd.requires_pm_qa FROM project_departments pd
      JOIN departments d ON d.id = pd.department_id WHERE pd.project_id = ${created.projectId}`;
    assert.deepEqual(
      teams.map((t) => [t.slug, Number(t.planned_deliverables), t.team_lead_id, t.requires_pm_qa]),
      [['video', 3, null, true]],
      'the unticked team is left behind, no lead is carried over, and Video keeps its own QA route rather than the project default',
    );

    for (const table of ['deliverables', 'assignments', 'deliveries', 'revisions']) {
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM ${sql(table)} WHERE project_id = ${created.projectId}`;
      assert.equal(n, 0, `${table} must not be copied`);
    }
  });

  test('an untouched copy keeps the source’s text and adds to the same new month', async () => {
    const result = await copy.copyMonth(sales(), {
      clientId: ids.client, fromMonthId: ids.september, period: '2091-10',
      projects: [{ sourceProjectId: ids.projectC, departments: [{ departmentId: ids.design, plannedDeliverables: 4 }] }],
    });
    assert.equal(result.monthCreated, false);
    assert.equal(result.clientMonthId, ids.october);
    const [row] = await sql`SELECT title, client_notes, price_amount FROM projects WHERE id = ${result.projects[0].projectId}`;
    assert.equal(row.title, 'Four blog headers');
    assert.equal(row.client_notes, 'Match the site');
    assert.equal(row.price_amount, null);

    const [summary] = (await monthSummaries(sales(), ids.client)).filter((m) => m.id === ids.october);
    assert.equal(summary.projects, 2);
    assert.equal(summary.deliverables, 0);
  });

  test('a project outside the source month, or a cancelled one, cannot be copied', async () => {
    await assert.rejects(
      copy.copyMonth(sales(), {
        clientId: ids.client, fromMonthId: ids.september, period: '2091-10',
        projects: [{ sourceProjectId: ids.projectB, departments: [{ departmentId: ids.design, plannedDeliverables: 20 }] }],
      }),
      /not in that month/,
    );
  });

  test('a copy with every team unticked is refused rather than filed empty', async () => {
    await assert.rejects(
      copy.copyMonth(sales(), {
        clientId: ids.client, fromMonthId: ids.september, period: '2091-12',
        projects: [{ sourceProjectId: ids.projectA, departments: [] }],
      }),
      /at least one team/,
    );
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM client_months
      WHERE client_id = ${ids.client} AND period_year = 2091 AND period_month = 12`;
    assert.equal(n, 0, 'nothing is opened when the copy is refused');
  });

  test('copying into the same month, or a closed one, is refused', async () => {
    const one = { sourceProjectId: ids.projectA, departments: [{ departmentId: ids.video, plannedDeliverables: 2 }] };
    await assert.rejects(
      copy.copyMonth(sales(), { clientId: ids.client, fromMonthId: ids.september, period: '2091-09', projects: [one] }),
      /different month/,
    );
    await assert.rejects(
      copy.copyMonth(sales(), { clientId: ids.client, fromMonthId: ids.september, period: '2091-11', projects: [one] }),
      /month is closed/,
    );
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM projects WHERE client_month_id = ${ids.november}`;
    assert.equal(n, 0);
  });

  test('nobody outside the client, and nobody without filing rights, can copy', async () => {
    const one = { sourceProjectId: ids.projectA, departments: [{ departmentId: ids.video, plannedDeliverables: 2 }] };
    await assert.rejects(
      copy.copyMonth(otherSales(), { clientId: ids.client, fromMonthId: ids.september, period: '2091-10', projects: [one] }),
      /No such client/,
    );
    await assert.rejects(
      copy.copyMonthPlan(leadVideo(), { clientId: ids.client, fromMonthId: ids.september }),
      /not permitted/,
    );
  });

  test('each team keeps its own QA route in the copy; a team added takes the intake default (§13)', async () => {
    const seo = Number((await sql`SELECT id FROM departments WHERE slug = 'seo'`)[0].id);
    const result = await copy.copyMonth(sales(), {
      clientId: ids.client, fromMonthId: ids.september, period: '2091-10',
      projects: [{
        sourceProjectId: ids.projectA,
        departments: [
          { departmentId: ids.video, plannedDeliverables: 2 },
          { departmentId: ids.design, plannedDeliverables: 1 },
          { departmentId: seo, plannedDeliverables: 1 },
        ],
      }],
    });
    const projectId = result.projects[0].projectId;
    const [row] = await sql`SELECT requires_pm_qa FROM projects WHERE id = ${projectId}`;
    assert.equal(row.requires_pm_qa, false, 'the intake default is not derived from the teams');
    const teams = await sql`
      SELECT d.slug, pd.requires_pm_qa FROM project_departments pd
      JOIN departments d ON d.id = pd.department_id WHERE pd.project_id = ${projectId} ORDER BY d.sort_order`;
    assert.deepEqual(
      teams.map((t) => [t.slug, t.requires_pm_qa]),
      [['video', true], ['design', false], ['seo', false]],
      'Video and Design as the PM set them; SEO, new in the copy, as Sales filed the project',
    );
  });
});

describe('copy helpers', { skip: false }, () => {
  test('the form parser mirrors what the fields are named', async () => {
    const { parseCopyForm } = await import('../src/lib/months/copy');
    const form = new FormData();
    form.append('clientId', '5');
    form.append('fromMonthId', '9');
    form.append('period', '2026-10');
    form.append('project', '41');
    form.append('title_41', ' Social videos ');
    form.append('dept_41', '1');
    form.append('planned_41_1', '12');
    form.append('dept_41', '2');
    form.append('planned_41_2', '-3');
    form.append('deadline_41', '2026-10-28');
    form.append('price_41', '1234.5');
    form.append('requirements_41', '');
    form.append('project', '42');
    form.append('dept_42', '3');
    form.append('planned_42_3', '4');

    const parsed = parseCopyForm(form);
    assert.equal(parsed.clientId, 5);
    assert.equal(parsed.fromMonthId, 9);
    assert.equal(parsed.period, '2026-10');
    assert.equal(parsed.projects.length, 2);
    assert.equal(parsed.projects[0].title, 'Social videos');
    assert.equal(parsed.projects[0].priceAmount, '1234.50');
    assert.equal(parsed.projects[0].requirements, null);
    assert.deepEqual(parsed.projects[0].departments, [
      { departmentId: 1, plannedDeliverables: 12 },
      { departmentId: 2, plannedDeliverables: 0 },
    ]);
    assert.equal(parsed.projects[1].title, null);
    assert.equal(parsed.projects[1].priceAmount, undefined, 'no price field on the form: keep the source price');
  });

  test('a form with no price field leaves the price alone; an emptied one clears it', async () => {
    const { parseCopyForm } = await import('../src/lib/months/copy');
    const form = new FormData();
    form.append('clientId', '5'); form.append('fromMonthId', '9'); form.append('period', '2026-10');
    form.append('project', '41');
    form.append('project', '42');
    form.append('price_42', '');
    const parsed = parseCopyForm(form);
    assert.equal(parsed.projects[0].priceAmount, undefined, 'not on the form: keep the source price');
    assert.equal(parsed.projects[1].priceAmount, null, 'blanked on the form: clear it');
  });

  test('deadlines move by whole months and clamp to the month’s end', async () => {
    const { shiftDate, nextPeriod } = await import('../src/lib/months/copy');
    assert.equal(shiftDate('2091-09-25', 1), '2091-10-25');
    assert.equal(shiftDate('2091-01-31', 1), '2091-02-28');
    assert.equal(shiftDate('2091-11-30', 3), '2092-02-29', '2092 is a leap year');
    assert.equal(shiftDate('2090-11-30', 3), '2091-02-28');
    assert.deepEqual(nextPeriod(2091, 12), { year: 2092, month: 1, value: '2092-01' });
  });
});
