/**
 * Notifications, dashboards and the timeline — the gaps closed for brief
 * §20, §21 and §25, through the domain layer.
 *
 *   - An Executive's first task on a project reaches them as "New project
 *     assigned"; every task after that as "New task".
 *   - Routing through triageProject: a second PM re-routing tells the PM
 *     who had it; the same PM re-saving, or the first routing out of intake,
 *     tells nobody; Sales hears of a routing only when a team gained a lead.
 *   - QA: the interim "approved by your Team Lead" and the final "approved
 *     for delivery" notices, and what Sales is told when the client's
 *     auto-delivery has already sent the file to the portal — with the
 *     delivery on the project timeline.
 *   - The nightly reminders: stored once per line crossed, weekly while
 *     overdue, to the people on the work and not to management.
 *   - "Today's assignments" on the Executive dashboard and in My work.
 *   - A client's portal decision in the project timeline.
 *   - scripts/nightly.ts: --dry-run and the advisory lock.
 *
 * Needs DATABASE_URL pointing at a migrated database.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import postgres from 'postgres';
import type { Actor, Permission, Role } from '../src/lib/authz/types';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run the w3-notify tests';

const DOMAIN = '@w3notify.local';
const CLIENT_PREFIX = 'W3 notify ';
const PERIOD = '2074-09';
const YEAR = 2074;

let sql: ReturnType<typeof postgres>;
let storageRoot: string;
let uploads: typeof import('../src/lib/files/uploads');
let inboxMod: typeof import('../src/lib/notifications/inbox');
let sendDeadlineReminders: typeof import('../src/lib/notifications/reminders').sendDeadlineReminders;
let shareProject: typeof import('../src/lib/projects/viewers').shareProject;
let fileProject: typeof import('../src/lib/projects/file-project').fileProject;
let triageProject: typeof import('../src/lib/projects/triage').triageProject;
let createAssignment: typeof import('../src/lib/planning/assign').createAssignment;
let reviewDeliverable: typeof import('../src/lib/qa/review').reviewDeliverable;
let createRevision: typeof import('../src/lib/revisions/revisions').createRevision;
let portal: typeof import('../src/lib/portal/portal');
let portalAccess: typeof import('../src/lib/portal/access');
let projectActivity: typeof import('../src/lib/activity/feed').projectActivity;
let describeActivity: typeof import('../src/lib/activity/describe').describeActivity;
let recordActivity: typeof import('../src/lib/auth/audit').recordActivity;
let loadDashboard: typeof import('../src/lib/dashboard/dashboard').loadDashboard;
let myWork: typeof import('../src/lib/workspace/my-work').myWork;

const ids: Record<string, number> = {};
const codes: Record<string, string> = {};

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0, email: `${role}${DOMAIN}`, fullName: role, role,
    isActive: true, mustChangePassword: false,
    leadDepartmentIds: [], departmentIds: [], permissions: new Set<Permission>(), ...over,
  };
}
const sales = () => actor('sales', { id: ids.sales });
const sales2 = () => actor('sales', { id: ids.sales2 });
const pm = () => actor('project_manager', { id: ids.pm });
const pm2 = () => actor('project_manager', { id: ids.pm2 });
const leadVideo = () => actor('team_lead', { id: ids.leadVideo, leadDepartmentIds: [ids.video], departmentIds: [ids.video] });
const leadDesign = () => actor('team_lead', { id: ids.leadDesign, leadDepartmentIds: [ids.design], departmentIds: [ids.design] });
const ahmed = () => actor('executive', { id: ids.ahmed, departmentIds: [ids.video] });
const nour = () => actor('executive', { id: ids.nour, departmentIds: [ids.video] });
const clientLogin = () => actor('client', { id: ids.clientLogin, fullName: 'Client One', clientId: ids.client });

/** Every user this suite made, in the order they were made. */
const USERS = [
  ['sales', 'sales'], ['sales2', 'sales'], ['pm', 'project_manager'], ['pm2', 'project_manager'], ['ceo', 'ceo'],
  ['leadVideo', 'team_lead'], ['leadDesign', 'team_lead'], ['leadDesign2', 'team_lead'],
  ['ahmed', 'executive'], ['omar', 'executive'], ['sara', 'executive'], ['nour', 'executive'],
] as const;

type Row = { type: string; title: string; body: string | null; link_path: string | null; entity_type: string | null; entity_id: number | null };

/**
 * Notification rows for one of this suite's users, oldest first, matched on
 * the project code in the title or body (PMs hear about every project in
 * the shared database) or on `match` when the test is about something else.
 */
async function received(userId: number, type?: string, match: string = codes.project): Promise<Row[]> {
  const rows = await sql<Row[]>`
    SELECT type, title, body, link_path, entity_type, entity_id FROM notifications
    WHERE user_id = ${userId} ${type ? sql`AND type = ${type}` : sql``}
      AND (title LIKE ${`%${match}%`} OR body LIKE ${`%${match}%`})
    ORDER BY id`;
  return rows.map((r) => ({
    type: r.type, title: r.title, body: r.body, link_path: r.link_path, entity_type: r.entity_type,
    entity_id: r.entity_id === null ? null : Number(r.entity_id),
  }));
}

/** Stored reminder rows for one user about one entity, oldest first. */
async function reminders(userId: number, type: string, entityType: string, entityId: number): Promise<Row[]> {
  const rows = await sql<Row[]>`
    SELECT type, title, body, link_path, entity_type, entity_id FROM notifications
    WHERE user_id = ${userId} AND type = ${type} AND entity_type = ${entityType} AND entity_id = ${entityId}
    ORDER BY id`;
  return rows.map((r) => ({ ...r, entity_id: Number(r.entity_id) }));
}

async function upload(who: Actor, deliverableId: number, filename: string) {
  const bytes = randomBytes(64);
  const { session } = await uploads.createUploadSession(who, { target: 'deliverable', deliverableId, filename, size: bytes.length });
  await uploads.appendChunk(who, session.id, 0, new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); },
  }));
  return uploads.completeUpload(who, session.id);
}

/** Today plus `offset` days, as the database sees it. */
async function day(offset: number): Promise<string> {
  const [row] = await sql<{ d: string }[]>`SELECT to_char(current_date + ${offset}::int, 'YYYY-MM-DD') AS d`;
  return row.d;
}

async function teamOf(projectId: number, slug: string): Promise<number> {
  const [row] = await sql`SELECT id FROM project_departments WHERE project_id = ${projectId} AND department_id = ${ids[slug]}`;
  return Number(row.id);
}

/** Filed by Sales and routed by the PM to the given leads. */
async function routed(title: string, teams: { slug: string; lead: string }[], over: { requiresPmQa?: boolean; deadline?: string } = {}) {
  const filed = await fileProject(sales(), {
    clientId: ids.client, period: PERIOD, title, requiresPmQa: over.requiresPmQa ?? false,
    deadline: over.deadline ?? `${YEAR}-09-30`,
    departments: teams.map((t) => ({ departmentId: ids[t.slug], plannedDeliverables: 1 })),
  });
  await triageProject(pm(), {
    projectId: filed.projectId,
    teams: teams.map((t) => ({ departmentId: ids[t.slug], teamLeadId: ids[t.lead], plannedDeliverables: 1 })),
  });
  return { id: filed.projectId, code: filed.projectCode };
}

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE ${`%${DOMAIN}`}`;
  const clients = sql`SELECT id FROM clients WHERE name LIKE ${`${CLIENT_PREFIX}%`}`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM upload_sessions WHERE created_by IN (${users})`;
  await sql`DELETE FROM notifications WHERE user_id IN (${users})`;
  await sql`DELETE FROM sessions WHERE user_id IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (${clients})`;
  await sql`DELETE FROM files WHERE uploaded_by IN (${users})`;
  await sql`DELETE FROM department_members WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE ${`%${DOMAIN}`} AND role = 'client'`;
  await sql`DELETE FROM clients WHERE name LIKE ${`${CLIENT_PREFIX}%`}`;
  await sql`DELETE FROM users WHERE email LIKE ${`%${DOMAIN}`}`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = ${YEAR}`;
}

before(async () => {
  if (skip) return;
  storageRoot = await mkdtemp(path.join(tmpdir(), 'aktivacity-w3-notify-'));
  process.env.STORAGE_ROOT = storageRoot;
  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });

  uploads = await import('../src/lib/files/uploads');
  inboxMod = await import('../src/lib/notifications/inbox');
  ({ sendDeadlineReminders } = await import('../src/lib/notifications/reminders'));
  ({ shareProject } = await import('../src/lib/projects/viewers'));
  ({ fileProject } = await import('../src/lib/projects/file-project'));
  ({ triageProject } = await import('../src/lib/projects/triage'));
  ({ createAssignment } = await import('../src/lib/planning/assign'));
  ({ reviewDeliverable } = await import('../src/lib/qa/review'));
  ({ createRevision } = await import('../src/lib/revisions/revisions'));
  portal = await import('../src/lib/portal/portal');
  portalAccess = await import('../src/lib/portal/access');
  ({ projectActivity } = await import('../src/lib/activity/feed'));
  ({ describeActivity } = await import('../src/lib/activity/describe'));
  ({ recordActivity } = await import('../src/lib/auth/audit'));
  ({ loadDashboard } = await import('../src/lib/dashboard/dashboard'));
  ({ myWork } = await import('../src/lib/workspace/my-work'));
  await purge();

  for (const slug of ['video', 'design']) {
    ids[slug] = Number((await sql`SELECT id FROM departments WHERE slug = ${slug}`)[0].id);
  }
  for (const [key, role] of USERS) {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES (${`${key}${DOMAIN}`}, 'x', ${key}, ${role}) RETURNING id`;
    ids[key] = Number(row.id);
  }
  const member = (key: string, slug: string, isLead = false) =>
    sql`INSERT INTO department_members (user_id, department_id, is_lead) VALUES (${ids[key]}, ${ids[slug]}, ${isLead})`;
  await member('leadVideo', 'video', true);
  await member('leadDesign', 'design', true);
  await member('leadDesign2', 'design', true);
  await member('ahmed', 'video');
  await member('omar', 'video');
  await member('nour', 'video');
  await member('sara', 'design');

  const [client] = await sql<{ id: number }[]>`
    INSERT INTO clients (name, owner_user_id, created_by)
    VALUES (${`${CLIENT_PREFIX}Client`}, ${ids.sales}, ${ids.sales}) RETURNING id`;
  ids.client = Number(client.id);
});

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('an Executive’s first task on a project is the project being assigned (brief §20)', { skip }, () => {
  test('the first task reads "New project assigned", the second "New task"', async () => {
    const p = await routed('Spring campaign', [{ slug: 'video', lead: 'leadVideo' }, { slug: 'design', lead: 'leadDesign' }],
      { requiresPmQa: true });
    ids.project = p.id;
    codes.project = p.code;
    ids.videoTeam = await teamOf(p.id, 'video');
    ids.designTeam = await teamOf(p.id, 'design');

    const cut = await createAssignment(leadVideo(), {
      projectDepartmentId: ids.videoTeam, assigneeId: ids.ahmed, title: 'Cut the film',
      deliverableCount: 1, deliverableBaseName: 'Video', endDate: `${YEAR}-09-18`,
    });
    [ids.video01] = cut.deliverableIds;
    ids.cutAssignment = cut.assignmentId;
    const first = await received(ids.ahmed, 'assignment.created');
    assert.deepEqual(first.map((r) => [r.title, r.body, r.link_path, r.entity_type, r.entity_id]), [[
      `New project assigned: ${p.code} · Spring campaign`,
      `${CLIENT_PREFIX}Client. First task: Cut the film — 1 deliverable, due ${YEAR}-09-18.`,
      `/projects/${p.id}#workspace`, 'assignment', cut.assignmentId,
    ]]);

    const grade = await createAssignment(leadVideo(), {
      projectDepartmentId: ids.videoTeam, assigneeId: ids.ahmed, title: 'Grade', deliverableCount: 1, deliverableBaseName: 'Grade',
    });
    assert.deepEqual((await received(ids.ahmed, 'assignment.created')).map((r) => r.title), [
      `New project assigned: ${p.code} · Spring campaign`,
      'New task: Grade',
    ], 'the project is news once');
    const [second] = (await received(ids.ahmed, 'assignment.created')).filter((r) => r.entity_id === grade.assignmentId);
    assert.equal(second.body, `${p.code} · Spring campaign — 1 deliverable.`);
  });

  test('each person’s own first task is their project notice; a lead routed the project is told of a task only', async () => {
    await createAssignment(leadVideo(), {
      projectDepartmentId: ids.videoTeam, assigneeId: ids.omar, title: 'Sound', deliverableCount: 0,
    });
    assert.deepEqual((await received(ids.omar, 'assignment.created')).map((r) => r.title),
      [`New project assigned: ${codes.project} · Spring campaign`], 'Omar’s first, though Ahmed had two');
    await createAssignment(leadDesign(), {
      projectDepartmentId: ids.designTeam, assigneeId: ids.sara, title: 'Thumbnail', deliverableCount: 1, deliverableBaseName: 'Thumb',
    });
    assert.deepEqual((await received(ids.sara, 'assignment.created')).map((r) => r.title),
      [`New project assigned: ${codes.project} · Spring campaign`]);

    // The Video lead was told of the project when the PM routed it (§20
    // Team Lead "new project assigned"); work of their own is just a task.
    await createAssignment(pm(), {
      projectDepartmentId: ids.videoTeam, assigneeId: ids.leadVideo, title: 'Storyboard', deliverableCount: 0,
    });
    assert.deepEqual((await received(ids.leadVideo, 'assignment.created')).map((r) => r.title), ['New task: Storyboard']);
    assert.deepEqual((await received(ids.leadVideo, 'project.assigned')).map((r) => r.title),
      [`New project for your team: ${codes.project} · Spring campaign`], 'from the routing, once');
    assert.deepEqual((await received(ids.pm, 'assignment.created')).map((r) => r.title),
      ['Team Lead assigned: Cut the film', 'Team Lead assigned: Grade', 'Team Lead assigned: Sound', 'Team Lead assigned: Thumbnail'],
      'the PM hears of the leads’ planning, not of their own');
    assert.deepEqual(await received(ids.pm2, 'assignment.created'), [], 'not a PM who is not on it');
    assert.deepEqual(await received(ids.sales, 'assignment.created'), [], 'Sales is not told of planning');
  });
});

describe('routing, through triageProject (brief §20 PM “Team Lead assigned”)', { skip }, () => {
  const leadAssigned = async (who: number) => received(who, 'project.lead_assigned', codes.routing);

  test('the first routing out of intake tells the leads and Sales, and no PM', async () => {
    const filed = await fileProject(sales(), {
      clientId: ids.client, period: PERIOD, title: 'Routing', requiresPmQa: false,
      departments: [{ departmentId: ids.video, plannedDeliverables: 1 }, { departmentId: ids.design, plannedDeliverables: 1 }],
    });
    ids.routing = filed.projectId;
    codes.routing = filed.projectCode;
    await triageProject(pm(), {
      projectId: ids.routing,
      teams: [
        { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 },
        { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 1 },
      ],
    });
    assert.equal((await received(ids.leadVideo, 'project.assigned', codes.routing)).length, 1);
    assert.equal((await received(ids.leadDesign, 'project.assigned', codes.routing)).length, 1);
    assert.deepEqual(await received(ids.leadDesign2, 'project.assigned', codes.routing), []);
    assert.deepEqual((await received(ids.sales, 'project.routed', codes.routing)).map((r) => r.title),
      [`Project routed by the PM: ${codes.routing} · Routing`]);
    assert.deepEqual(await leadAssigned(ids.pm), [], 'nobody had it before');
    assert.deepEqual(await leadAssigned(ids.pm2), []);
  });

  test('the same PM re-saving with the same leads tells nobody', async () => {
    await triageProject(pm(), {
      projectId: ids.routing, priority: 'high',
      teams: [
        { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 },
        { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 1 },
      ],
    });
    assert.equal((await received(ids.sales, 'project.routed', codes.routing)).length, 1, 'a re-save is not a routing');
    assert.equal((await received(ids.leadVideo, 'project.assigned', codes.routing)).length, 1);
    assert.deepEqual(await leadAssigned(ids.pm), []);
    assert.deepEqual(await leadAssigned(ids.pm2), []);
  });

  test('another PM giving a team a new lead tells the PM who had the project, and Sales again', async () => {
    await triageProject(pm2(), {
      projectId: ids.routing,
      teams: [
        { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 },
        { departmentId: ids.design, teamLeadId: ids.leadDesign2, plannedDeliverables: 1 },
      ],
    });
    const told = await leadAssigned(ids.pm);
    assert.deepEqual(told.map((r) => [r.title, r.body, r.link_path]), [[
      `Team Lead assigned: ${codes.routing} · Routing`,
      `${CLIENT_PREFIX}Client. Routed by pm2 to leadDesign2.`,
      `/projects/${ids.routing}`,
    ]]);
    assert.deepEqual(await leadAssigned(ids.pm2), [], 'the PM who routed it');
    assert.equal((await received(ids.leadDesign2, 'project.assigned', codes.routing)).length, 1, 'the new lead');
    assert.equal((await received(ids.leadDesign, 'project.assigned', codes.routing)).length, 1, 'the old lead is not told again');
    assert.equal((await received(ids.leadVideo, 'project.assigned', codes.routing)).length, 1, 'still the same lead');
    assert.equal((await received(ids.sales, 'project.routed', codes.routing)).length, 2, 'a team gained a lead');
    const [{ project_manager_id }] = await sql`SELECT project_manager_id FROM projects WHERE id = ${ids.routing}`;
    assert.equal(Number(project_manager_id), ids.pm2, 'the project is now pm2’s');
  });

  test('the new PM re-saving tells nobody; routing it back tells the new PM', async () => {
    await triageProject(pm2(), {
      projectId: ids.routing, internalNotes: 'Watch the budget.',
      teams: [
        { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 },
        { departmentId: ids.design, teamLeadId: ids.leadDesign2, plannedDeliverables: 1 },
      ],
    });
    assert.equal((await leadAssigned(ids.pm)).length, 1, 'still one');
    assert.deepEqual(await leadAssigned(ids.pm2), []);
    assert.equal((await received(ids.sales, 'project.routed', codes.routing)).length, 2);

    await triageProject(pm(), {
      projectId: ids.routing,
      teams: [
        { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 },
        { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 1 },
      ],
    });
    assert.deepEqual((await leadAssigned(ids.pm2)).map((r) => r.body), [`${CLIENT_PREFIX}Client. Routed by pm to leadDesign.`]);
    assert.equal((await leadAssigned(ids.pm)).length, 1, 'the PM who routed it back');
    assert.equal((await received(ids.sales, 'project.routed', codes.routing)).length, 3);
  });
});

describe('QA approval notices (brief §20 Executive “QA approved”, Sales “ready for delivery”)', { skip }, () => {
  test('the lead’s approval on a PM-QA project is an interim notice; the PM’s is the final one', async () => {
    await upload(ahmed(), ids.video01, 'Film_v1.mp4');
    await reviewDeliverable(leadVideo(), { deliverableId: ids.video01, decision: 'approved' });
    assert.deepEqual((await received(ids.ahmed, 'qa.approved')).map((r) => [r.title, r.body]), [[
      'Video 01 v1 approved by your Team Lead',
      `${codes.project} · Spring campaign. It now goes to the Project Manager for sign-off.`,
    ]]);
    assert.deepEqual((await received(ids.pm, 'qa.required')).map((r) => r.title), ['QA needed: Video 01 v1']);
    assert.deepEqual(await received(ids.pm2, 'qa.required'), [], 'only the PM on it');
    assert.deepEqual(await received(ids.sales, 'delivery.ready'), [], 'not cleared yet');
    assert.deepEqual(await received(ids.leadVideo, 'qa.approved'), [], 'the lead approved it');

    const final = await reviewDeliverable(pm(), { deliverableId: ids.video01, decision: 'approved' });
    assert.equal(final.autoDelivered, false, 'this client has no auto-delivery');
    assert.ok(final.deliveryId, 'waiting for Sales');
    assert.deepEqual((await received(ids.ahmed, 'qa.approved')).map((r) => [r.title, r.body]), [
      ['Video 01 v1 approved by your Team Lead', `${codes.project} · Spring campaign. It now goes to the Project Manager for sign-off.`],
      ['Video 01 v1 approved for delivery', `${codes.project} · Spring campaign. It has cleared QA.`],
    ], 'each stage once, worded apart');
    assert.deepEqual((await received(ids.sales, 'delivery.ready')).map((r) => [r.title, r.link_path]),
      [['Ready for delivery: Video 01 v1', '/deliveries']]);
    assert.deepEqual(await received(ids.sales, 'delivery.delivered'), [], 'nothing was delivered yet');
    assert.deepEqual(await received(ids.pm, 'qa.approved'), [], 'the PM signed it off');
    const [dl] = await sql`SELECT status FROM deliveries WHERE id = ${final.deliveryId}`;
    assert.equal(dl.status, 'pending_delivery');
  });
});

describe('auto-delivery to the client portal (brief §20 Sales, §25 record of the delivery, §29)', { skip }, () => {
  before(async () => {
    if (skip) return;
    const login = await portalAccess.createPortalLogin(sales(), {
      clientId: ids.client, fullName: 'Client One', email: `client1${DOMAIN}`,
    });
    ids.clientLogin = login.userId;
    await portalAccess.setAutoDeliver(sales(), { clientId: ids.client, on: true });
  });
  after(async () => {
    if (skip) return;
    await portalAccess.setAutoDeliver(sales(), { clientId: ids.client, on: false });
  });

  test('Sales is told the file was delivered, not that it waits in their queue; the timeline records the delivery', async () => {
    const p = await routed('Promo', [{ slug: 'video', lead: 'leadVideo' }], { deadline: `${YEAR}-10-31` });
    ids.promoProject = p.id;
    codes.promo = p.code;
    const work = await createAssignment(leadVideo(), {
      projectDepartmentId: await teamOf(p.id, 'video'), assigneeId: ids.ahmed, title: 'Promo cut',
      deliverableCount: 1, deliverableBaseName: 'Promo',
    });
    [ids.promo01] = work.deliverableIds;
    ids.promoAssignment = work.assignmentId;
    await upload(ahmed(), ids.promo01, 'Promo_v1.mp4');

    const ok = await reviewDeliverable(leadVideo(), { deliverableId: ids.promo01, decision: 'approved' });
    assert.equal(ok.autoDelivered, true);
    assert.ok(ok.deliveryId);
    ids.promoDelivery = ok.deliveryId!;
    const [dl] = await sql`SELECT status, delivered_by FROM deliveries WHERE id = ${ok.deliveryId}`;
    assert.deepEqual([dl.status, Number(dl.delivered_by)], ['delivered', ids.leadVideo]);
    assert.equal(ok.projectStatus, 'delivered');

    assert.deepEqual((await received(ids.sales, 'delivery.delivered', p.code)).map((r) => [r.title, r.body, r.link_path]), [[
      'Delivered to the client portal: Promo 01 v1',
      `${p.code} · Promo. Approved and delivered automatically; the client can now review it.`,
      `/projects/${p.id}`,
    ]]);
    assert.deepEqual(await received(ids.sales, 'delivery.ready', p.code), [], 'it is not waiting in the queue');
    assert.deepEqual((await received(ids.ahmed, 'qa.approved', p.code)).map((r) => [r.title, r.body]),
      [['Promo 01 v1 approved for delivery', `${p.code} · Promo. It has cleared QA and went to the client portal.`]]);
    assert.deepEqual(await received(ids.leadVideo, 'delivery.delivered', p.code), [], 'the lead is not Sales');
    assert.deepEqual(await received(ids.pm, 'delivery.delivered', p.code), []);
    assert.deepEqual((await received(ids.clientLogin, 'portal.delivered', 'Promo')).map((r) => r.link_path),
      [`/portal/projects/${p.id}`], 'the client is told');

    const rows = await sql`
      SELECT actor_id, entity_type, entity_id, project_id, client_id, metadata FROM activity_log
      WHERE action = 'delivery.updated' AND project_id = ${p.id}`;
    assert.equal(rows.length, 1);
    assert.deepEqual(
      [Number(rows[0].actor_id), rows[0].entity_type, Number(rows[0].entity_id), Number(rows[0].client_id), rows[0].metadata],
      [ids.leadVideo, 'delivery', ok.deliveryId, ids.client,
        { status: 'delivered', deliverableId: ids.promo01, deliverableName: 'Promo 01', automatic: true }],
    );
    const feed = (await projectActivity(p.id)).map((l) => l.text);
    assert.ok(feed.includes('Promo 01 was delivered to the client portal automatically'), feed.join('\n'));
  });

  test('the client’s decision in the portal reads in the timeline as the client’s', async () => {
    const say = (decision: string) => describeActivity({
      action: 'delivery.client_decision', actorName: 'Client One', metadata: { decision, deliverableName: 'Video 01' },
    });
    assert.equal(say('approved'), 'Client approved Video 01');
    assert.equal(say('changes_requested'), 'Client requested changes to Video 01');

    const decided = await portal.clientDecide(clientLogin(), { deliveryId: ids.promoDelivery, decision: 'approved' });
    assert.equal(decided.deliverableName, 'Promo 01');
    // The server action records it after the domain call, outside the transaction.
    await recordActivity({
      actorId: ids.clientLogin, action: 'delivery.client_decision', entityType: 'delivery', entityId: ids.promoDelivery,
      projectId: ids.promoProject, clientId: ids.client, metadata: { decision: 'approved', deliverableName: 'Promo 01' },
    });
    const feed = (await projectActivity(ids.promoProject)).map((l) => l.text);
    assert.deepEqual(feed.slice(-2), [
      'Promo 01 was delivered to the client portal automatically',
      'Client approved Promo 01',
    ]);
    assert.deepEqual((await received(ids.sales, 'delivery.client_approved', codes.promo)).map((r) => r.title),
      [`Client approved Promo 01: ${codes.promo}`]);
  });
});

describe('the nightly reminders (brief §20 “deadline approaching”, “project delayed”)', { skip }, () => {
  const everyone = () => USERS.map(([k]) => ids[k]).concat(ids.clientLogin);
  const run = () => sendDeadlineReminders({ userIds: everyone() });

  before(async () => {
    if (skip) return;
    const p = await routed('Trailer', [{ slug: 'video', lead: 'leadVideo' }]);
    ids.trailerProject = p.id;
    codes.trailer = p.code;
    const work = await createAssignment(leadVideo(), {
      projectDepartmentId: await teamOf(p.id, 'video'), assigneeId: ids.ahmed, title: 'Cut the trailer',
      deliverableCount: 1, deliverableBaseName: 'Trailer', endDate: await day(2),
    });
    ids.trailer = work.assignmentId;
  });

  test('an item coming within three days is stored once, for the people on the work', async () => {
    const outcome = await run();
    assert.equal(outcome.usersChecked, USERS.filter(([, role]) => role !== 'ceo').length,
      'management and the client login are not written to');
    for (const who of [ids.ahmed, ids.leadVideo]) {
      const rows = await reminders(who, 'deadline.approaching', 'assignment', ids.trailer);
      assert.deepEqual(rows.map((r) => [r.title, r.body, r.link_path]), [[
        'Deadline approaching: Cut the trailer',
        `${codes.trailer} · due in 2 days (${await day(2)}).`,
        `/projects/${ids.trailerProject}#workspace`,
      ]]);
    }
    const nothing = async (who: number) => {
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM notifications
        WHERE user_id = ${who} AND type LIKE 'deadline.%' AND entity_type = 'assignment' AND entity_id = ${ids.trailer}`;
      return Number(n);
    };
    assert.equal(await nothing(ids.omar), 0, 'not his assignment');
    assert.equal(await nothing(ids.pm), 0, 'a PM is not reminded of an Executive’s task');
    assert.equal(await nothing(ids.leadDesign), 0, 'another team');
    const [{ n: ceo }] = await sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${ids.ceo}`;
    assert.equal(Number(ceo), 0, 'management is not written to at all');
    assert.deepEqual(await reminders(ids.pm, 'deadline.approaching', 'project', ids.trailerProject), [],
      'the project itself is not due');

    await run();
    for (const who of [ids.ahmed, ids.leadVideo]) {
      assert.equal((await reminders(who, 'deadline.approaching', 'assignment', ids.trailer)).length, 1, 'a second run adds nothing');
    }
    assert.equal(await inboxMod.deadlineCount(ahmed()), 1, 'the live list still counts it');
  });

  test('due today, then overdue: once each, and again a week later', async () => {
    await sql`UPDATE assignments SET end_date = current_date WHERE id = ${ids.trailer}`;
    await run();
    assert.deepEqual((await reminders(ids.ahmed, 'deadline.today', 'assignment', ids.trailer)).map((r) => [r.title, r.body]),
      [['Due today: Cut the trailer', `${codes.trailer} · due today (${await day(0)}).`]]);
    assert.equal((await reminders(ids.ahmed, 'deadline.approaching', 'assignment', ids.trailer)).length, 1, 'never a second approaching');

    await sql`UPDATE assignments SET end_date = current_date - 1 WHERE id = ${ids.trailer}`;
    await run();
    const overdue = () => reminders(ids.ahmed, 'deadline.overdue', 'assignment', ids.trailer);
    assert.deepEqual((await overdue()).map((r) => [r.title, r.body]),
      [['Overdue: Cut the trailer', `${codes.trailer} · 1 day overdue (${await day(-1)}).`]]);
    await run();
    assert.equal((await overdue()).length, 1, 'not nagged daily');
    assert.equal((await reminders(ids.ahmed, 'deadline.today', 'assignment', ids.trailer)).length, 1);

    await sql`UPDATE notifications SET created_at = now() - interval '8 days'
      WHERE user_id = ${ids.ahmed} AND type = 'deadline.overdue' AND entity_type = 'assignment' AND entity_id = ${ids.trailer}`;
    await run();
    assert.equal((await overdue()).length, 2, 'a week on, once more');
    assert.equal((await reminders(ids.leadVideo, 'deadline.overdue', 'assignment', ids.trailer)).length, 1, 'the lead’s is recent');
  });

  test('an overdue project is “project delayed” to its own PM, its rep and its leads — not to every PM', async () => {
    await sql`UPDATE projects SET deadline = current_date - 1 WHERE id = ${ids.trailerProject}`;
    await run();
    const delayed = (who: number) => reminders(who, 'project.delayed', 'project', ids.trailerProject);
    assert.deepEqual((await delayed(ids.pm)).map((r) => [r.title, r.body, r.link_path]), [[
      'Overdue: Trailer', `${codes.trailer} · 1 day overdue (${await day(-1)}).`, `/projects/${ids.trailerProject}`,
    ]]);
    assert.deepEqual(await delayed(ids.pm2), [], 'the other PM does not manage it');
    assert.deepEqual(await delayed(ids.ceo), [], 'management has the dashboard');
    assert.equal((await delayed(ids.sales)).length, 1, 'the rep who owns it');
    assert.equal((await delayed(ids.leadVideo)).length, 1, 'the team on it');
    assert.deepEqual(await delayed(ids.ahmed), [], 'an Executive is reminded of their tasks, not the project');
    assert.deepEqual(await delayed(ids.leadDesign), [], 'not their team');
  });

  test('a project shared with another rep is on their live list, and never a stored reminder of theirs', async () => {
    await shareProject(pm(), { projectId: ids.trailerProject, userId: ids.sales2 });
    const live = (await inboxMod.upcomingDeadlines(sales2(), 3)).map((d) => [d.kind, d.id]);
    assert.deepEqual(live, [['project', ids.trailerProject]], 'the inbox lists what they may read');
    assert.deepEqual(await inboxMod.upcomingDeadlines(sales2(), 3, { shared: false }), [], 'a share is not their work');

    await run();
    const delayed = (who: number) => reminders(who, 'project.delayed', 'project', ids.trailerProject);
    assert.deepEqual(await delayed(ids.sales2), [], 'a share reads; it does not chase');
    assert.equal((await delayed(ids.sales)).length, 1, 'the rep who owns it still has theirs');
    // Their own user, so every reminder row is this suite's: none at all.
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM notifications
      WHERE user_id = ${ids.sales2} AND (type LIKE 'deadline.%' OR type = 'project.delayed')`;
    assert.equal(Number(n), 0, 'nor any other line about it');
  });

  test('a project still in intake reminds every PM, since any of them may take it', async () => {
    const filed = await fileProject(sales(), {
      clientId: ids.client, period: PERIOD, title: 'Rush job', deadline: await day(1),
      departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
    });
    await run();
    for (const who of [ids.pm, ids.pm2]) {
      assert.deepEqual((await reminders(who, 'deadline.approaching', 'project', filed.projectId)).map((r) => r.title),
        ['Deadline approaching: Rush job'], `PM ${who}`);
    }
    assert.deepEqual(await reminders(ids.ceo, 'deadline.approaching', 'project', filed.projectId), []);
    assert.deepEqual(await reminders(ids.leadVideo, 'deadline.approaching', 'project', filed.projectId), [], 'not routed to them yet');
  });

  test('a revision waiting to be handed out is stored with its own link; reopened work links to the workspace', async () => {
    const r = await createRevision(sales(), {
      projectId: ids.promoProject, title: 'Logo', clientFeedback: 'Bigger logo.', deadline: await day(2),
      deliverableIds: [ids.promo01],
    });
    const forPm = await inboxMod.upcomingDeadlines(pm(), 3);
    const revision = forPm.find((d) => d.kind === 'revision' && d.id === r.revisionId);
    assert.ok(revision, 'the PM may hand it out');
    assert.equal(revision.linkPath, `/revisions/${r.revisionId}`);
    const forAhmed = (await inboxMod.upcomingDeadlines(ahmed(), 3)).find((d) => d.kind === 'assignment' && d.id === ids.promoAssignment);
    assert.ok(forAhmed, 'his slot is back with him, due when the revision is');
    assert.equal(forAhmed.linkPath, `/projects/${ids.promoProject}#workspace`);

    await run();
    assert.deepEqual((await reminders(ids.pm, 'deadline.approaching', 'revision', r.revisionId)).map((x) => [x.title, x.link_path]),
      [['Deadline approaching: Revision #01: Logo', revision.linkPath]]);
    assert.deepEqual((await reminders(ids.leadVideo, 'deadline.approaching', 'revision', r.revisionId)).map((x) => x.link_path),
      [revision.linkPath]);
    assert.deepEqual((await reminders(ids.ahmed, 'deadline.approaching', 'assignment', ids.promoAssignment)).map((x) => x.link_path),
      [forAhmed.linkPath]);
    assert.deepEqual(await reminders(ids.pm2, 'deadline.approaching', 'revision', r.revisionId), [], 'not the PM on it');
    assert.deepEqual(await reminders(ids.sales, 'deadline.approaching', 'revision', r.revisionId), [], 'Sales hands nothing out');
  });
});

describe('today’s assignments (brief §21 Executive dashboard, §8 My work)', { skip }, () => {
  before(async () => {
    if (skip) return;
    const p = await routed('Day plan', [{ slug: 'video', lead: 'leadVideo' }]);
    ids.dayProject = p.id;
    const team = await teamOf(p.id, 'video');
    const make = async (title: string, start: number | null, end: number | null) => (await createAssignment(leadVideo(), {
      projectDepartmentId: team, assigneeId: ids.nour, title, deliverableCount: 1,
      startDate: start === null ? null : await day(start), endDate: end === null ? null : await day(end),
    })).assignmentId;
    ids.todayCut = await make('Today cut', -1, 1);
    ids.laterCut = await make('Later cut', 1, 3);
    ids.openEnded = await make('Open ended', -2, null);
    ids.undated = await make('Undated', null, null);
  });

  test('My work lists today as the current work whose planned dates hold today', async () => {
    const { current, today } = await myWork(nour());
    assert.deepEqual(current.map((w) => w.assignmentTitle).sort(), ['Later cut', 'Open ended', 'Today cut', 'Undated']);
    assert.deepEqual(today.map((w) => [w.assignmentTitle, w.isToday]), [['Today cut', true], ['Open ended', true]],
      'an open-ended one that has started counts; one starting tomorrow or never dated does not');
    assert.deepEqual(current.filter((w) => !w.isToday).map((w) => w.assignmentTitle).sort(), ['Later cut', 'Undated']);
  });

  test('the dashboard counts the same', async () => {
    const d = await loadDashboard(nour());
    assert.ok(d.executive);
    assert.equal(d.executive!.todayAssignments, 2);
    assert.equal(d.executive!.activeAssignments, 4);
    assert.equal(d.executive!.currentProjects, 1);
    assert.deepEqual(d.deadlines.map((x) => [x.kind, x.title, x.daysLeft]), [['assignment', 'Today cut', 1], ['assignment', 'Later cut', 3]],
      'the dashboard looks a week ahead');
  });

  test('moved to tomorrow, completed, or on a closed project: not today', async () => {
    await sql`UPDATE assignments SET start_date = current_date + 1 WHERE id = ${ids.todayCut}`;
    assert.deepEqual((await myWork(nour())).today.map((w) => w.assignmentTitle), ['Open ended']);
    assert.equal((await loadDashboard(nour())).executive!.todayAssignments, 1);

    await sql`UPDATE assignments SET start_date = current_date - 1, status = 'completed' WHERE id = ${ids.todayCut}`;
    const done = await myWork(nour());
    assert.deepEqual(done.today.map((w) => w.assignmentTitle), ['Open ended']);
    assert.ok(!done.current.some((w) => w.assignmentId === ids.todayCut), 'finished work is previous');
    assert.ok(done.previous.some((w) => w.assignmentId === ids.todayCut));
    const d = await loadDashboard(nour());
    assert.deepEqual([d.executive!.todayAssignments, d.executive!.activeAssignments], [1, 3]);

    await sql`UPDATE projects SET status = 'completed' WHERE id = ${ids.dayProject}`;
    try {
      assert.deepEqual((await myWork(nour())).today, []);
      assert.deepEqual((await myWork(nour())).current, [], 'a closed project takes its work with it');
      assert.deepEqual([(await loadDashboard(nour())).executive!.todayAssignments, (await loadDashboard(nour())).executive!.activeAssignments], [0, 0]);
    } finally {
      await sql`UPDATE projects SET status = 'planned' WHERE id = ${ids.dayProject}`;
    }
  });
});

describe('scripts/nightly.ts', { skip }, () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const nightly = (...args: string[]) => promisify(execFile)(
    process.execPath, ['--conditions=react-server', '--import', 'tsx', 'scripts/nightly.ts', ...args],
    { cwd: repoRoot, env: { ...process.env, DATABASE_URL }, timeout: 90_000 },
  );

  test('--dry-run previews the archive and sends nothing', async () => {
    const [{ n: before }] = await sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${ids.ahmed}`;
    const { stdout } = await nightly('--dry-run');
    assert.match(stdout, /\d+ month\(s\) ready to archive\. Reminders are not previewed\./);
    const [{ n: after }] = await sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${ids.ahmed}`;
    assert.equal(Number(after), Number(before));
  });

  test('a second run while one holds the lock does nothing', async () => {
    const [{ locked }] = await sql<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(hashtext('aktivacity:nightly')) AS locked`;
    assert.equal(locked, true);
    try {
      const { stdout } = await nightly('--dry-run');
      assert.match(stdout, /Another run is in progress; nothing to do\./);
      assert.doesNotMatch(stdout, /ready to archive/);
    } finally {
      await sql`SELECT pg_advisory_unlock(hashtext('aktivacity:nightly'))`;
    }
  });
});
