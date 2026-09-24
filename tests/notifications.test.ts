/**
 * Notifications (brief §20) — Phase 1b.
 *
 * Each action on the spine tells the people it concerns, and only them;
 * nobody is told about their own action. Deadline reminders are computed
 * live from the work rather than stored.
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
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run notification tests';

let sql: ReturnType<typeof postgres>;
let storageRoot: string;
let uploads: typeof import('../src/lib/files/uploads');
let inboxMod: typeof import('../src/lib/notifications/inbox');
let fileProject: typeof import('../src/lib/projects/file-project').fileProject;
let triageProject: typeof import('../src/lib/projects/triage').triageProject;
let createAssignment: typeof import('../src/lib/planning/assign').createAssignment;
let reviewDeliverable: typeof import('../src/lib/qa/review').reviewDeliverable;
let updateDelivery: typeof import('../src/lib/delivery/deliveries').updateDelivery;
let createRevision: typeof import('../src/lib/revisions/revisions').createRevision;
let assignRevision: typeof import('../src/lib/revisions/revisions').assignRevision;
let copyMonth: typeof import('../src/lib/months/copy').copyMonth;

const ids: Record<string, number> = {};
const codes: Record<string, string> = {};

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0, email: `${role}@m11test.local`, fullName: role, role,
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

/**
 * Notification rows for a user about this suite's project, oldest first.
 * Suites run side by side in one database and Project Managers hear about
 * every project, so rows are matched on the project code (in every title
 * or body) — or on `match` when the test is about a different project.
 */
async function received(userId: number, type?: string, match: string = codes.project) {
  const rows = await sql<{ type: string; title: string; is_read: boolean }[]>`
    SELECT type, title, is_read FROM notifications WHERE user_id = ${userId}
    ${type ? sql`AND type = ${type}` : sql``}
    AND (title LIKE ${`%${match}%`} OR body LIKE ${`%${match}%`}) ORDER BY id`;
  // A plain array: postgres.js rows carry extra properties that trip deepEqual.
  return rows.map((r) => ({ type: r.type, title: r.title, is_read: r.is_read }));
}
async function clearAll() {
  await sql`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@m11test.local')`;
}
async function upload(who: Actor, deliverableId: number, filename: string) {
  const bytes = randomBytes(64);
  const { session } = await uploads.createUploadSession(who, { target: 'deliverable', deliverableId, filename, size: bytes.length });
  await uploads.appendChunk(who, session.id, 0, new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); },
  }));
  return uploads.completeUpload(who, session.id);
}

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE '%@m11test.local'`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM upload_sessions WHERE created_by IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'M11 Test%')`;
  await sql`DELETE FROM clients WHERE name LIKE 'M11 Test%'`;
  await sql`DELETE FROM files WHERE uploaded_by IN (${users})`;
  await sql`DELETE FROM department_members WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE '%@m11test.local'`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2089`;
}

before(async () => {
  if (skip) return;
  storageRoot = await mkdtemp(path.join(tmpdir(), 'aktivacity-m11-'));
  process.env.STORAGE_ROOT = storageRoot;
  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });

  uploads = await import('../src/lib/files/uploads');
  inboxMod = await import('../src/lib/notifications/inbox');
  ({ fileProject } = await import('../src/lib/projects/file-project'));
  ({ triageProject } = await import('../src/lib/projects/triage'));
  ({ createAssignment } = await import('../src/lib/planning/assign'));
  ({ reviewDeliverable } = await import('../src/lib/qa/review'));
  ({ updateDelivery } = await import('../src/lib/delivery/deliveries'));
  ({ createRevision, assignRevision } = await import('../src/lib/revisions/revisions'));
  ({ copyMonth } = await import('../src/lib/months/copy'));
  await purge();

  for (const slug of ['video', 'design']) {
    ids[slug] = Number((await sql`SELECT id FROM departments WHERE slug = ${slug}`)[0].id);
  }
  const mkUser = async (key: string, role: string) => {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES (${`${key}@m11test.local`}, 'x', ${key}, ${role}) RETURNING id`;
    ids[key] = Number(row.id);
  };
  for (const [k, r] of [
    ['sales', 'sales'], ['pm', 'project_manager'], ['pm2', 'project_manager'],
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
    INSERT INTO clients (name, owner_user_id, created_by) VALUES ('M11 Test Client', ${ids.sales}, ${ids.sales}) RETURNING id`;
  ids.client = Number(client.id);
});

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('the spine, step by step (brief §20)', { skip }, () => {
  test('filing a project tells every Project Manager, not the filer', async () => {
    const filed = await fileProject(sales(), {
      clientId: ids.client, period: '2089-09', title: 'Spring campaign', requiresPmQa: true,
      deadline: '2089-09-20',
      departments: [{ departmentId: ids.video, plannedDeliverables: 1 }, { departmentId: ids.design, plannedDeliverables: 1 }],
    });
    ids.project = filed.projectId;
    codes.project = filed.projectCode;
    for (const who of [ids.pm, ids.pm2]) {
      const rows = await received(who, 'project.created');
      assert.equal(rows.length, 1);
      assert.match(rows[0].title, new RegExp(`New project: ${codes.project}`));
    }
    assert.deepEqual(await received(ids.sales), []);
    assert.deepEqual(await received(ids.leadVideo), []);
  });

  test('routing tells the new Team Leads and the Sales owner; the PM who routed hears nothing', async () => {
    await triageProject(pm(), {
      projectId: ids.project,
      teams: [
        { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 },
        { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 1 },
      ],
    });
    assert.equal((await received(ids.leadVideo, 'project.assigned')).length, 1);
    assert.equal((await received(ids.leadDesign, 'project.assigned')).length, 1);
    const salesRows = await received(ids.sales, 'project.routed');
    assert.equal(salesRows.length, 1);
    assert.match(salesRows[0].title, /routed by the PM/);
    assert.deepEqual(await received(ids.pm, 'project.assigned'), []);
    assert.deepEqual(await received(ids.pm, 'project.routed'), []);
  });

  test('re-saving the routing with the same leads pings nobody', async () => {
    await triageProject(pm(), {
      projectId: ids.project,
      teams: [
        { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 },
        { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 1 },
      ],
    });
    assert.equal((await received(ids.leadVideo, 'project.assigned')).length, 1, 'still one');
    assert.equal((await received(ids.sales, 'project.routed')).length, 2, 'Sales hears each routing');
  });

  test('an assignment tells its assignee only', async () => {
    const teams = await sql<{ id: number; department_id: number }[]>`
      SELECT id, department_id FROM project_departments WHERE project_id = ${ids.project}`;
    ids.videoTeam = Number(teams.find((t) => Number(t.department_id) === ids.video)!.id);
    ids.designTeam = Number(teams.find((t) => Number(t.department_id) === ids.design)!.id);
    const v = await createAssignment(leadVideo(), {
      projectDepartmentId: ids.videoTeam, assigneeId: ids.ahmed, title: 'Cut the film',
      deliverableCount: 1, deliverableBaseName: 'Video', endDate: '2089-09-18',
    });
    [ids.video01] = v.deliverableIds;
    ids.ahmedAssignment = v.assignmentId;
    const d = await createAssignment(leadDesign(), {
      projectDepartmentId: ids.designTeam, assigneeId: ids.sara, title: 'Thumbnail', deliverableCount: 1, deliverableBaseName: 'Thumb',
    });
    [ids.thumb01] = d.deliverableIds;

    const rows = await received(ids.ahmed, 'assignment.created');
    assert.equal(rows.length, 1);
    assert.match(rows[0].title, /New task: Cut the film/);
    assert.deepEqual(await received(ids.omar), []);
    assert.deepEqual(await received(ids.leadVideo, 'assignment.created'), []);
  });

  test('an upload tells the lead of that team (QA needed) and the project’s PM', async () => {
    await upload(ahmed(), ids.video01, 'Film_v1.mp4');
    const lead = await received(ids.leadVideo, 'deliverable.uploaded');
    assert.equal(lead.length, 1);
    assert.match(lead[0].title, /QA needed: Video 01 v1/);
    assert.deepEqual(await received(ids.leadDesign, 'deliverable.uploaded'), [], 'the other team’s lead is not told');
    assert.equal((await received(ids.pm, 'deliverable.uploaded')).length, 1, 'the PM on the project');
    assert.deepEqual(await received(ids.pm2, 'deliverable.uploaded'), [], 'not the other PM, once one is on it');
    assert.deepEqual(await received(ids.ahmed, 'deliverable.uploaded'), []);
  });

  test('a rejection tells the Executive and Sales; the lead who rejected hears nothing', async () => {
    await reviewDeliverable(leadVideo(), { deliverableId: ids.video01, decision: 'changes_requested', comments: 'Too long.' });
    const rows = await received(ids.ahmed, 'qa.rejected');
    assert.equal(rows.length, 1);
    assert.match(rows[0].title, /Video 01 v1 sent back/);
    assert.equal((await received(ids.sales, 'qa.rejected')).length, 1);
    assert.deepEqual(await received(ids.leadVideo, 'qa.rejected'), []);
  });

  test('lead approval on a PM-QA project tells the PM that QA is required', async () => {
    await upload(ahmed(), ids.video01, 'Film_v2.mp4');
    await reviewDeliverable(leadVideo(), { deliverableId: ids.video01, decision: 'approved' });
    const rows = await received(ids.pm, 'qa.required');
    assert.equal(rows.length, 1);
    assert.match(rows[0].title, /QA needed: Video 01 v2/);
    assert.deepEqual(await received(ids.ahmed, 'qa.approved'), [], 'not approved yet — the PM has it');
  });

  test('a PM rejection also tells the Team Lead who had approved it', async () => {
    await reviewDeliverable(pm(), { deliverableId: ids.video01, decision: 'rejected', comments: 'Wrong logo.' });
    const lead = await received(ids.leadVideo, 'qa.rejected');
    assert.equal(lead.length, 1);
    assert.match(lead[0].title, /PM rejected Video 01 v2/);
    assert.equal((await received(ids.ahmed, 'qa.rejected')).length, 2);
  });

  test('final approval tells the Executive and puts it in Sales’ queue', async () => {
    await upload(ahmed(), ids.video01, 'Film_v3.mp4');
    await reviewDeliverable(leadVideo(), { deliverableId: ids.video01, decision: 'approved' });
    const approved = await reviewDeliverable(pm(), { deliverableId: ids.video01, decision: 'approved' });
    ids.video01Delivery = approved.deliveryId!;
    assert.equal((await received(ids.ahmed, 'qa.approved')).length, 1);
    const ready = await received(ids.sales, 'delivery.ready');
    assert.equal(ready.length, 1);
    assert.match(ready[0].title, /Ready for delivery: Video 01 v3/);
    assert.deepEqual(await received(ids.pm, 'delivery.ready'), []);
  });

  test('a revision tells the PM, the leads of the teams touched, and the executives on those slots', async () => {
    await updateDelivery(sales(), { deliveryId: ids.video01Delivery, status: 'delivered' });
    await clearAll();
    const r = await createRevision(sales(), {
      projectId: ids.project, title: 'Opening scene', clientFeedback: 'Shorter opening please.',
      deliverableIds: [ids.video01],
    });
    ids.revision = r.revisionId;
    assert.equal((await received(ids.pm, 'revision.created')).length, 1);
    assert.equal((await received(ids.leadVideo, 'revision.created')).length, 1);
    assert.deepEqual(await received(ids.leadDesign, 'revision.created'), [], 'the thumbnail is not in it');
    const ahmedRows = await received(ids.ahmed, 'revision.created');
    assert.equal(ahmedRows.length, 1);
    assert.match(ahmedRows[0].title, /Revision #01: Opening scene/);
    assert.deepEqual(await received(ids.sara), []);
    assert.deepEqual(await received(ids.sales), []);
  });

  test('handing a revision to someone tells them', async () => {
    await assignRevision(leadVideo(), { revisionId: ids.revision, deliverableId: ids.video01, assigneeId: ids.omar });
    const rows = await received(ids.omar, 'revision.assigned');
    assert.equal(rows.length, 1);
    assert.match(rows[0].title, /Revision #01 assigned to you: Video 01/);
  });

  test('a copied month files its projects into the PMs’ inboxes like any other', async () => {
    await clearAll();
    await copyMonth(sales(), {
      clientId: ids.client, fromMonthId: Number((await sql`SELECT client_month_id FROM projects WHERE id = ${ids.project}`)[0].client_month_id),
      period: '2089-10',
      projects: [{ sourceProjectId: ids.project, departments: [{ departmentId: ids.video, plannedDeliverables: 1 }] }],
    });
    assert.equal((await received(ids.pm, 'project.created', 'Spring campaign')).length, 1);
    assert.equal((await received(ids.pm2, 'project.created', 'Spring campaign')).length, 1);
  });

  test('a deactivated user is not written to', async () => {
    await sql`UPDATE users SET is_active = false WHERE id = ${ids.pm2}`;
    await clearAll();
    await fileProject(sales(), {
      clientId: ids.client, period: '2089-09', title: 'One more',
      departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
    });
    assert.equal((await received(ids.pm, 'project.created', 'One more')).length, 1);
    assert.deepEqual(await received(ids.pm2, undefined, 'One more'), []);
    await sql`UPDATE users SET is_active = true WHERE id = ${ids.pm2}`;
  });
});

describe('the inbox', { skip }, () => {
  test('a person reads only their own, newest first, and can mark them read', async () => {
    await clearAll();
    for (const [who, title] of [[ids.ahmed, 'first'], [ids.ahmed, 'second'], [ids.sara, 'hers']] as const) {
      await sql`INSERT INTO notifications (user_id, type, title, link_path) VALUES (${who}, 'test', ${title}, '/work')`;
    }
    const mine = await inboxMod.inbox(ahmed());
    assert.deepEqual(mine.map((n) => n.title), ['second', 'first']);
    const others = await inboxMod.inbox(sara());
    assert.ok(!others.some((n) => mine.some((m) => m.id === n.id)));

    const before = await inboxMod.unreadCount(ahmed());
    const first = mine.find((n) => !n.isRead)!;
    const opened = await inboxMod.markRead(ahmed(), first.id);
    assert.ok(opened && opened.linkPath?.startsWith('/'));
    assert.equal(await inboxMod.unreadCount(ahmed()), before - 1);

    assert.equal(await inboxMod.markRead(sara(), first.id), null, 'someone else cannot mark it');
    const [row] = await sql`SELECT is_read FROM notifications WHERE id = ${first.id}`;
    assert.equal(row.is_read, true);

    const marked = await inboxMod.markAllRead(ahmed());
    assert.equal(marked, before - 1);
    assert.equal(await inboxMod.unreadCount(ahmed()), 0);
    assert.equal((await inboxMod.inbox(ahmed(), { unreadOnly: true })).length, 0);
  });
});

describe('deadlines, computed live (brief §20)', { skip }, () => {
  test('an Executive sees their assignment due soon or overdue; a lead sees the team’s; the PM sees projects', async () => {
    // Move the fixture's dates to around today.
    await sql`UPDATE assignments SET end_date = current_date + 2 WHERE id = ${ids.ahmedAssignment}`;
    await sql`UPDATE projects SET deadline = current_date - 1 WHERE id = ${ids.project}`;

    const forAhmed = await inboxMod.upcomingDeadlines(ahmed(), 3);
    const mineA = forAhmed.filter((d) => d.projectCode === codes.project);
    assert.deepEqual(mineA.map((d) => [d.kind, d.title, d.daysLeft]), [['assignment', 'Cut the film', 2]]);

    const forSara = (await inboxMod.upcomingDeadlines(sara(), 3)).filter((d) => d.projectCode === codes.project);
    assert.deepEqual(forSara, [], 'her assignment has no end date');

    const forLead = (await inboxMod.upcomingDeadlines(leadVideo(), 3)).filter((d) => d.projectCode === codes.project);
    assert.deepEqual(forLead.map((d) => [d.kind, d.daysLeft]), [['project', -1], ['assignment', 2]]);

    const forPm = (await inboxMod.upcomingDeadlines(pm(), 3)).filter((d) => d.projectCode === codes.project);
    assert.deepEqual(forPm.map((d) => [d.kind, d.daysLeft]), [['project', -1]]);

    // Outside the window, nothing.
    await sql`UPDATE assignments SET end_date = current_date + 10 WHERE id = ${ids.ahmedAssignment}`;
    assert.deepEqual((await inboxMod.upcomingDeadlines(ahmed(), 3)).filter((d) => d.projectCode === codes.project), []);
  });
});
