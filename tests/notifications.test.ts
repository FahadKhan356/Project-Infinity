/**
 * Notifications (brief §20) — Phase 1b.
 *
 * Each action on the spine tells the people it concerns, and only them;
 * nobody is told about their own action. Deadline reminders are computed
 * live from the work for the inbox; the nightly run that also stores them
 * is covered in tests/w3-notify.test.ts.
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
  await sql`DELETE FROM project_code_sequence WHERE period_year IN (2089, 2081)`;
}

/** Today plus `offset` days, as the database sees it. */
async function day(offset: number): Promise<string> {
  const [row] = await sql<{ d: string }[]>`SELECT to_char(current_date + ${offset}::int, 'YYYY-MM-DD') AS d`;
  return row.d;
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
    // Scoped to this project: other suites file projects in parallel, and
    // every PM hears about each of those.
    const total = async () => Number((await sql`
      SELECT count(*)::int AS n FROM notifications
      WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@m11test.local')
        AND (title LIKE ${`%${codes.project}%`} OR body LIKE ${`%${codes.project}%`})`)[0].n);
    const before = await total();
    await triageProject(pm(), {
      projectId: ids.project,
      teams: [
        { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 },
        { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 1 },
      ],
    });
    assert.equal(await total(), before, 'no team gained a lead: not one row, to anyone');
    assert.equal((await received(ids.leadVideo, 'project.assigned')).length, 1, 'still one');
    assert.equal((await received(ids.leadDesign, 'project.assigned')).length, 1, 'still one');
    assert.equal((await received(ids.sales, 'project.routed')).length, 1, 'a re-save is not a routing');
    assert.deepEqual(await received(ids.pm, 'project.routed'), [], 'the PM re-saved their own routing');
    assert.deepEqual(await received(ids.pm, 'project.lead_assigned'), []);
  });

  test('an assignment tells its assignee, and the project’s PM that the Team Lead assigned it', async () => {
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
    assert.match(rows[0].title, new RegExp(`^New project assigned: ${codes.project}`), 'his first work on it');
    const [{ body }] = await sql`SELECT body FROM notifications WHERE user_id = ${ids.ahmed} AND entity_id = ${v.assignmentId}`;
    assert.match(body, /First task: Cut the film — 1 deliverable, due 2089-09-18\./);
    assert.deepEqual(await received(ids.omar), []);
    assert.deepEqual(await received(ids.leadVideo, 'assignment.created'), [], 'the lead planned it');
    assert.deepEqual((await received(ids.pm, 'assignment.created')).map((r) => r.title),
      ['Team Lead assigned: Cut the film', 'Team Lead assigned: Thumbnail']);
    assert.deepEqual(await received(ids.pm2, 'assignment.created'), [], 'only the PM on the project');
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

  test('lead approval on a PM-QA project tells the Executive it moved on, and the PM that QA is required', async () => {
    await upload(ahmed(), ids.video01, 'Film_v2.mp4');
    await reviewDeliverable(leadVideo(), { deliverableId: ids.video01, decision: 'approved' });
    const rows = await received(ids.pm, 'qa.required');
    assert.equal(rows.length, 1);
    assert.match(rows[0].title, /^QA needed: Video 01 v2$/);
    assert.deepEqual(await received(ids.pm2, 'qa.required'), [], 'only the PM on the project');
    assert.deepEqual((await received(ids.ahmed, 'qa.approved')).map((r) => r.title),
      ['Video 01 v2 approved by your Team Lead'], 'an interim notice: the PM still has it');
    assert.deepEqual(await received(ids.ahmed, 'qa.required'), []);
    assert.deepEqual(await received(ids.leadVideo, 'qa.approved'), [], 'the lead approved it');
    assert.deepEqual(await received(ids.leadVideo, 'qa.required'), []);
    assert.deepEqual(await received(ids.pm, 'qa.approved'), []);
    assert.deepEqual(await received(ids.sales, 'qa.approved'), []);
    assert.deepEqual(await received(ids.sales, 'delivery.ready'), [], 'not cleared yet');
  });

  test('a PM rejection also tells the Team Lead who had approved it', async () => {
    await reviewDeliverable(pm(), { deliverableId: ids.video01, decision: 'rejected', comments: 'Wrong logo.' });
    const lead = await received(ids.leadVideo, 'qa.rejected');
    assert.equal(lead.length, 1);
    assert.match(lead[0].title, /PM rejected Video 01 v2/);
    assert.equal((await received(ids.ahmed, 'qa.rejected')).length, 2);
  });

  test('final approval tells the Executive, worded apart from the lead’s, and puts it in Sales’ queue', async () => {
    await upload(ahmed(), ids.video01, 'Film_v3.mp4');
    await reviewDeliverable(leadVideo(), { deliverableId: ids.video01, decision: 'approved' });
    const approved = await reviewDeliverable(pm(), { deliverableId: ids.video01, decision: 'approved' });
    ids.video01Delivery = approved.deliveryId!;
    assert.deepEqual((await received(ids.ahmed, 'qa.approved')).map((r) => r.title), [
      'Video 01 v2 approved by your Team Lead',
      'Video 01 v3 approved by your Team Lead',
      'Video 01 v3 approved for delivery',
    ], 'each stage once; the final one can be told from the interim');
    const ready = await received(ids.sales, 'delivery.ready');
    assert.equal(ready.length, 1);
    assert.match(ready[0].title, /^Ready for delivery: Video 01 v3$/);
    assert.deepEqual(await received(ids.sales, 'qa.approved'), [], 'Sales hears of it as a delivery');
    assert.deepEqual(await received(ids.pm, 'delivery.ready'), []);
    assert.deepEqual(await received(ids.pm, 'qa.approved'), [], 'the PM signed it off');
    assert.deepEqual(await received(ids.leadVideo, 'qa.approved'), [], 'the lead is not told of their own approval');
    assert.deepEqual(await received(ids.leadVideo, 'delivery.ready'), []);
  });

  test('without PM QA the lead’s approval is final: one notice, for delivery', async () => {
    const filed = await fileProject(sales(), {
      clientId: ids.client, period: '2089-09', title: 'Quick promo', requiresPmQa: false,
      departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
    });
    await triageProject(pm(), {
      projectId: filed.projectId,
      teams: [{ departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 }],
    });
    const [team] = await sql<{ id: number }[]>`SELECT id FROM project_departments WHERE project_id = ${filed.projectId}`;
    const [promo] = (await createAssignment(leadVideo(), {
      projectDepartmentId: Number(team.id), assigneeId: ids.ahmed, title: 'Promo cut',
      deliverableCount: 1, deliverableBaseName: 'Promo',
    })).deliverableIds;
    await upload(ahmed(), promo, 'Promo_v1.mp4');
    const ok = await reviewDeliverable(leadVideo(), { deliverableId: promo, decision: 'approved' });
    assert.ok(ok.deliveryId, 'the lead’s approval clears QA');
    assert.deepEqual((await received(ids.ahmed, 'qa.approved', filed.projectCode)).map((r) => r.title),
      ['Promo 01 v1 approved for delivery'], 'no interim notice on the way');
    assert.deepEqual(await received(ids.pm, 'qa.required', filed.projectCode), [], 'no PM stage to wait for');
    assert.equal((await received(ids.sales, 'delivery.ready', filed.projectCode)).length, 1);
    assert.deepEqual(await received(ids.leadVideo, 'qa.approved', filed.projectCode), []);
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

  test('handing a revision to someone tells them, and the PM who has it', async () => {
    await assignRevision(leadVideo(), { revisionId: ids.revision, deliverableId: ids.video01, assigneeId: ids.omar });
    const rows = await received(ids.omar, 'revision.assigned');
    assert.equal(rows.length, 1);
    assert.match(rows[0].title, /Revision #01 assigned to you: Video 01/);
    assert.deepEqual((await received(ids.pm, 'revision.assigned')).map((r) => r.title),
      ['Revision #01 handed to omar: Video 01']);
    assert.deepEqual(await received(ids.leadVideo, 'revision.assigned'), [], 'the lead handed it out');
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
    // Fresh work due around today, on a project whose own deadline just passed.
    const trailer = await createAssignment(leadVideo(), {
      projectDepartmentId: ids.videoTeam, assigneeId: ids.ahmed, title: 'Cut the trailer',
      deliverableCount: 1, deliverableBaseName: 'Trailer', endDate: await day(2),
    });
    await sql`UPDATE projects SET deadline = current_date - 1 WHERE id = ${ids.project}`;
    // Cut the film's only slot went to Omar with the revision: its date is nobody's to chase.
    await sql`UPDATE assignments SET end_date = current_date - 10 WHERE id = ${ids.ahmedAssignment}`;

    const forAhmed = await inboxMod.upcomingDeadlines(ahmed(), 3);
    const mineA = forAhmed.filter((d) => d.projectCode === codes.project);
    assert.deepEqual(mineA.map((d) => [d.kind, d.title, d.daysLeft]), [['assignment', 'Cut the trailer', 2]]);
    assert.equal(mineA[0].linkPath, `/projects/${ids.project}#workspace`);

    const forSara = (await inboxMod.upcomingDeadlines(sara(), 3)).filter((d) => d.projectCode === codes.project);
    assert.deepEqual(forSara, [], 'her assignment has no end date');

    const forLead = (await inboxMod.upcomingDeadlines(leadVideo(), 3)).filter((d) => d.projectCode === codes.project);
    assert.deepEqual(forLead.map((d) => [d.kind, d.daysLeft]), [['project', -1], ['assignment', 2]]);

    const forPm = (await inboxMod.upcomingDeadlines(pm(), 3)).filter((d) => d.projectCode === codes.project);
    assert.deepEqual(forPm.map((d) => [d.kind, d.daysLeft]), [['project', -1]]);

    // Outside the window, nothing.
    await sql`UPDATE assignments SET end_date = current_date + 10 WHERE id = ${trailer.assignmentId}`;
    assert.deepEqual((await inboxMod.upcomingDeadlines(ahmed(), 3)).filter((d) => d.projectCode === codes.project), []);
  });
});

describe('the people around the work (brief §20)', { skip }, () => {
  // A second project, filed and run by the PM rather than by Sales.
  const mine = async (who: Actor) => (await inboxMod.upcomingDeadlines(who, 3))
    .filter((d) => d.projectCode === codes.p2).map((d) => [d.kind, d.title, d.daysLeft]);

  test('a project filed for a rep’s client by someone else tells the rep', async () => {
    const filed = await fileProject(pm(), {
      clientId: ids.client, period: '2081-09', title: 'Autumn launch', requiresPmQa: true,
      departments: [{ departmentId: ids.video, plannedDeliverables: 1 }, { departmentId: ids.design, plannedDeliverables: 1 }],
    });
    ids.p2 = filed.projectId;
    codes.p2 = filed.projectCode;
    const rep = await received(ids.sales, 'project.created', codes.p2);
    assert.equal(rep.length, 1);
    assert.match(rep[0].title, new RegExp(`Project created for your client: ${codes.p2}`));
    const [{ body }] = await sql`
      SELECT body FROM notifications WHERE user_id = ${ids.sales} AND type = 'project.created' AND entity_id = ${ids.p2}`;
    assert.match(body, /Filed by pm/);
    assert.deepEqual(await received(ids.pm, undefined, codes.p2), [], 'the PM who filed it');
    const other = await received(ids.pm2, 'project.created', codes.p2);
    assert.equal(other.length, 1);
    assert.match(other[0].title, /New project: /);
  });

  test('work a PM hands out tells that team’s lead; work a lead hands out tells the PM', async () => {
    await triageProject(pm(), {
      projectId: ids.p2,
      teams: [
        { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 },
        { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 1 },
      ],
    });
    const teams = await sql<{ id: number; department_id: number }[]>`
      SELECT id, department_id FROM project_departments WHERE project_id = ${ids.p2}`;
    ids.p2Video = Number(teams.find((t) => Number(t.department_id) === ids.video)!.id);
    ids.p2Design = Number(teams.find((t) => Number(t.department_id) === ids.design)!.id);
    assert.equal((await received(ids.sales, 'project.routed', codes.p2)).length, 1, 'the rep follows it after filing too');

    const film = await createAssignment(pm(), {
      projectDepartmentId: ids.p2Video, assigneeId: ids.ahmed, title: 'Colour pass',
      deliverableCount: 1, deliverableBaseName: 'Film', endDate: '2081-09-18',
    });
    [ids.p2Film] = film.deliverableIds;
    ids.colourPass = film.assignmentId;
    const lead = await received(ids.leadVideo, 'assignment.created', codes.p2);
    assert.equal(lead.length, 1);
    assert.match(lead[0].title, /New task in your team: Colour pass/);
    const assignee = await received(ids.ahmed, 'assignment.created', codes.p2);
    assert.deepEqual(assignee.map((r) => r.title), [`New project assigned: ${codes.p2} · Autumn launch`]);
    assert.deepEqual(await received(ids.pm, 'assignment.created', codes.p2), [], 'the PM planned it');
    assert.deepEqual(await received(ids.leadDesign, 'assignment.created', codes.p2), [], 'not the other team’s lead');

    await createAssignment(leadDesign(), {
      projectDepartmentId: ids.p2Design, assigneeId: ids.sara, title: 'Key visual', deliverableCount: 0,
    });
    const toPm = await received(ids.pm, 'assignment.created', codes.p2);
    assert.equal(toPm.length, 1);
    assert.match(toPm[0].title, /Team Lead assigned: Key visual/);
    assert.deepEqual(await received(ids.pm2, 'assignment.created', codes.p2), [], 'not a PM who is not on it');
    assert.deepEqual(await received(ids.leadDesign, 'assignment.created', codes.p2), [], 'the lead planned it');

    // Work handed to the lead personally reaches them once, as their own.
    await createAssignment(pm(), {
      projectDepartmentId: ids.p2Video, assigneeId: ids.leadVideo, title: 'Storyboard', deliverableCount: 0,
    });
    const storyboard = (await received(ids.leadVideo, 'assignment.created', codes.p2))
      .filter((r) => r.title.includes('Storyboard'));
    assert.deepEqual(storyboard.map((r) => r.title), ['New task: Storyboard']);
  });

  test('a revision someone else opens tells the client’s rep', async () => {
    await upload(ahmed(), ids.p2Film, 'Film_v1.mp4');
    await reviewDeliverable(leadVideo(), { deliverableId: ids.p2Film, decision: 'approved' });
    const ok = await reviewDeliverable(pm(), { deliverableId: ids.p2Film, decision: 'approved' });
    await updateDelivery(sales(), { deliveryId: ok.deliveryId!, status: 'delivered' });

    const r = await createRevision(pm(), {
      projectId: ids.p2, title: 'Warmer grade', clientFeedback: 'Too cold.', deadline: await day(2),
      deliverableIds: [ids.p2Film],
    });
    ids.p2Revision = r.revisionId;
    const rep = await received(ids.sales, 'revision.created', codes.p2);
    assert.equal(rep.length, 1);
    assert.match(rep[0].title, /Revision #01: Warmer grade/);
    assert.deepEqual(await received(ids.pm, 'revision.created', codes.p2), [], 'the PM opened it');
    assert.equal((await received(ids.leadVideo, 'revision.created', codes.p2)).length, 1);
    assert.equal((await received(ids.ahmed, 'revision.created', codes.p2)).length, 1, 'once, with his own wording');
  });

  test('revision work is due when the revision is, and one not handed out is the lead’s and PM’s to chase', async () => {
    // The dates first planned are long gone; only the revision's date matters now.
    await sql`UPDATE assignments SET end_date = current_date - 10 WHERE id = ${ids.colourPass}`;
    await sql`UPDATE projects SET deadline = current_date - 5 WHERE id = ${ids.p2}`;

    assert.deepEqual(await mine(ahmed()), [['assignment', 'Colour pass', 2]], 'his slot is back with him');
    assert.deepEqual(await mine(leadVideo()), [
      ['project', 'Autumn launch', 2],
      ['revision', 'Revision #01: Warmer grade', 2],
    ], 'to the lead, the reopened Colour pass is the revision waiting to be handed out');
    assert.deepEqual(await mine(pm()), [['project', 'Autumn launch', 2], ['revision', 'Revision #01: Warmer grade', 2]]);
    assert.deepEqual(await mine(sales()), [['project', 'Autumn launch', 2]], 'Sales opened nothing to hand out');
    assert.deepEqual(await mine(leadDesign()), [['project', 'Autumn launch', 2]], 'the revision is not about design');
    assert.deepEqual(await mine(sara()), []);

    const revision = (await inboxMod.upcomingDeadlines(pm(), 3)).find((d) => d.kind === 'revision' && d.id === ids.p2Revision);
    assert.equal(revision?.linkPath, `/revisions/${ids.p2Revision}`);
  });

  test('handed back to the same Executive, the reminder keeps the revision’s date; the lead hears who has it', async () => {
    const handed = await assignRevision(pm(), { revisionId: ids.p2Revision, deliverableId: ids.p2Film, assigneeId: ids.ahmed });
    assert.equal(handed.created, false, 'the reopened Colour pass takes it');

    const lead = await received(ids.leadVideo, 'revision.assigned', codes.p2);
    assert.equal(lead.length, 1);
    assert.match(lead[0].title, /Revision #01 handed to ahmed: Film 01/);
    assert.deepEqual(await received(ids.pm, 'revision.assigned', codes.p2), [], 'the PM handed it out');
    assert.deepEqual((await received(ids.ahmed, 'revision.assigned', codes.p2)).map((r) => r.title),
      ['Revision #01 assigned to you: Film 01']);

    assert.deepEqual(await mine(ahmed()), [['assignment', 'Colour pass', 2]]);
    assert.deepEqual(await mine(leadVideo()), [['project', 'Autumn launch', 2], ['assignment', 'Colour pass', 2]],
      'handed out, it is no longer waiting on the lead');
    assert.equal(await inboxMod.deadlineCount(ahmed()), 1, 'the header can count it');
  });

  test('the revised file reaches Sales named for its revision, and the reminders follow it to delivery', async () => {
    await upload(ahmed(), ids.p2Film, 'Film_v2.mp4');
    const qa = await received(ids.leadVideo, 'deliverable.uploaded', codes.p2);
    assert.match(qa.at(-1)!.title, /^QA needed: Film 01 v2 \(revision #01\)$/);
    await reviewDeliverable(leadVideo(), { deliverableId: ids.p2Film, decision: 'approved' });
    const ok = await reviewDeliverable(pm(), { deliverableId: ids.p2Film, decision: 'approved' });

    const ready = await received(ids.sales, 'delivery.ready', codes.p2);
    assert.deepEqual(ready.map((r) => r.title), [
      'Ready for delivery: Film 01 v1',
      'Ready for delivery: Film 01 v2 (revision #01)',
    ]);
    assert.deepEqual(await mine(ahmed()), [], 'approved: his part is done');
    assert.deepEqual(await mine(pm()), [['project', 'Autumn launch', 2]], 'still the revision’s date until it goes out');

    await updateDelivery(sales(), { deliveryId: ok.deliveryId!, status: 'delivered' });
    assert.deepEqual(await mine(pm()), []);
  });

  test('a Team Lead someone else routes in tells the PM the project was with', async () => {
    const { onProjectRouted } = await import('../src/lib/notifications/notify');
    const { getDb } = await import('../src/db');
    const leadAssigned = async (who: number) =>
      (await received(who, 'project.lead_assigned', codes.p2)).map((n) => n.title);

    // The other PM re-routes the design team to a new lead.
    await onProjectRouted(getDb(), {
      projectId: ids.p2, newLeadIds: [ids.leadDesign], actorId: ids.pm2, previousManagerId: ids.pm,
    });
    assert.deepEqual(await leadAssigned(ids.pm), [`Team Lead assigned: ${codes.p2} · Autumn launch`]);
    const [{ body }] = await sql`
      SELECT body FROM notifications WHERE user_id = ${ids.pm} AND type = 'project.lead_assigned' AND entity_id = ${ids.p2}`;
    assert.match(body, /Routed by pm2 to leadDesign\./);
    assert.deepEqual(await leadAssigned(ids.pm2), [], 'the PM who routed it');

    // No new lead, a caller that does not say who had it, or nobody had it
    // yet (straight out of intake): nobody.
    await onProjectRouted(getDb(), { projectId: ids.p2, newLeadIds: [], actorId: ids.pm2, previousManagerId: ids.pm });
    await onProjectRouted(getDb(), { projectId: ids.p2, newLeadIds: [ids.leadDesign], actorId: ids.pm2 });
    await onProjectRouted(getDb(), {
      projectId: ids.p2, newLeadIds: [ids.leadVideo], actorId: ids.pm, previousManagerId: null,
    });
    assert.equal((await leadAssigned(ids.pm)).length, 1);
    assert.deepEqual(await leadAssigned(ids.pm2), []);
  });
});

describe('revision dates, case by case (brief §15, §20)', { skip }, () => {
  /** [kind, title, daysLeft] for what `who` is reminded of on one project. */
  const dueOn = async (who: Actor, code: string) => (await inboxMod.upcomingDeadlines(who, 3))
    .filter((d) => d.projectCode === code).map((d) => [d.kind, d.title, d.daysLeft]);
  const omar = () => actor('executive', { id: ids.omar, departmentIds: [ids.video] });

  /** Filed by Sales without PM QA, and routed by the PM to each team's lead. */
  async function routedProject(title: string, period: string, slugs: ('video' | 'design')[]) {
    const filed = await fileProject(sales(), {
      clientId: ids.client, period, title, requiresPmQa: false,
      departments: slugs.map((s) => ({ departmentId: ids[s], plannedDeliverables: 1 })),
    });
    await triageProject(pm(), {
      projectId: filed.projectId,
      teams: slugs.map((s) => ({
        departmentId: ids[s], teamLeadId: s === 'video' ? ids.leadVideo : ids.leadDesign, plannedDeliverables: 1,
      })),
    });
    const teams = await sql<{ id: number; department_id: number }[]>`
      SELECT id, department_id FROM project_departments WHERE project_id = ${filed.projectId}`;
    const team = (slug: 'video' | 'design') => Number(teams.find((t) => Number(t.department_id) === ids[slug])!.id);
    return { id: filed.projectId, code: filed.projectCode, team };
  }
  /** Uploaded, approved by the lead and delivered by Sales. */
  async function deliver(who: Actor, lead: Actor, deliverableId: number, filename: string) {
    await upload(who, deliverableId, filename);
    const ok = await reviewDeliverable(lead, { deliverableId, decision: 'approved' });
    await updateDelivery(sales(), { deliveryId: ok.deliveryId!, status: 'delivered' });
  }

  test('an undated revision leaves overdue work on its plan, until that plan has been met', async () => {
    const p = await routedProject('Winter push', '2081-10', ['video']);
    const edit = await createAssignment(leadVideo(), {
      projectDepartmentId: p.team('video'), assigneeId: ids.ahmed, title: 'Edit',
      deliverableCount: 1, deliverableBaseName: 'Clip', endDate: await day(-4),
    });
    const [clip] = edit.deliverableIds;
    await sql`UPDATE projects SET deadline = current_date - 3 WHERE id = ${p.id}`;
    await upload(ahmed(), clip, 'Clip_v1.mp4');

    // Notes on the draft, with no date of their own: the late work is still late.
    await createRevision(sales(), {
      projectId: p.id, title: 'Draft notes', clientFeedback: 'Brighter.', deliverableIds: [clip],
    });
    assert.deepEqual(await dueOn(ahmed(), p.code), [['assignment', 'Edit', -4]]);
    assert.deepEqual(await dueOn(leadVideo(), p.code), [['assignment', 'Edit', -4], ['project', 'Winter push', -3]]);
    assert.deepEqual(await dueOn(pm(), p.code), [['project', 'Winter push', -3]]);

    // Once it went out on time, an undated revision has no date to chase yet.
    const ok = await reviewDeliverable(leadVideo(), { deliverableId: clip, decision: 'approved' });
    await updateDelivery(sales(), { deliveryId: ok.deliveryId!, status: 'delivered' });
    await createRevision(sales(), {
      projectId: p.id, title: 'Second thoughts', clientFeedback: 'Shorter.', deliverableIds: [clip],
    });
    for (const who of [ahmed(), leadVideo(), pm()]) assert.deepEqual(await dueOn(who, p.code), []);
  });

  test('a revision across two teams is one row until handed out; then each lead chases their half', async () => {
    const p = await routedProject('Awards reel', '2081-11', ['video', 'design']);
    ids.p4 = p.id;
    codes.p4 = p.code;
    ids.p4Design = p.team('design');
    const cut = await createAssignment(leadVideo(), {
      projectDepartmentId: p.team('video'), assigneeId: ids.ahmed, title: 'Promo cut',
      deliverableCount: 1, deliverableBaseName: 'Promo', endDate: await day(-25),
    });
    const art = await createAssignment(leadDesign(), {
      projectDepartmentId: ids.p4Design, assigneeId: ids.sara, title: 'Promo art',
      deliverableCount: 1, deliverableBaseName: 'Art', endDate: await day(-25),
    });
    [ids.promo01] = cut.deliverableIds;
    [ids.art01] = art.deliverableIds;
    await deliver(ahmed(), leadVideo(), ids.promo01, 'Promo_v1.mp4');
    await deliver(sara(), leadDesign(), ids.art01, 'Art_v1.png');

    const r = await createRevision(sales(), {
      projectId: p.id, title: 'Both', clientFeedback: 'New logo everywhere.', deadline: await day(2),
      deliverableIds: [ids.promo01, ids.art01],
    });
    ids.p4Revision = r.revisionId;
    for (const who of [leadVideo(), leadDesign(), pm()]) {
      assert.deepEqual(await dueOn(who, p.code), [['project', 'Awards reel', 2], ['revision', 'Revision #01: Both', 2]],
        'the revision, not the reopened assignment as well');
    }
    assert.deepEqual(await dueOn(ahmed(), p.code), [['assignment', 'Promo cut', 2]]);
    assert.deepEqual(await dueOn(sara(), p.code), [['assignment', 'Promo art', 2]]);

    // The video half is handed out; the design half is still Sara's reopened work.
    await assignRevision(leadVideo(), { revisionId: r.revisionId, deliverableId: ids.promo01, assigneeId: ids.ahmed });
    assert.deepEqual(await dueOn(leadVideo(), p.code), [['project', 'Awards reel', 2], ['assignment', 'Promo cut', 2]]);
    assert.deepEqual(await dueOn(leadDesign(), p.code), [['project', 'Awards reel', 2], ['assignment', 'Promo art', 2]]);
    assert.deepEqual(await dueOn(pm(), p.code), [['project', 'Awards reel', 2]]);
  });

  test('a slot on two open revisions is due when the latest is, not on the older one’s missed date', async () => {
    // Weeks on: the video half of #01 went out again, the design half is late.
    await sql`UPDATE revisions SET deadline = current_date - 20 WHERE id = ${ids.p4Revision}`;
    await deliver(ahmed(), leadVideo(), ids.promo01, 'Promo_v2.mp4');
    const r2 = await createRevision(sales(), {
      projectId: ids.p4, title: 'Logo', clientFeedback: 'Bigger logo.', deadline: await day(2),
      deliverableIds: [ids.promo01],
    });

    // #02 is waiting to be handed out — though not while that would be refused.
    const toHandOut = async (who: Actor) => (await dueOn(who, codes.p4)).filter(([kind]) => kind === 'revision');
    assert.deepEqual(await toHandOut(pm()), [['revision', 'Revision #02: Logo', 2]]);
    await sql`UPDATE projects SET status = 'on_hold', held_from_status = status WHERE id = ${ids.p4}`;
    assert.deepEqual(await toHandOut(pm()), [], 'a held project takes no new work');
    assert.deepEqual(await toHandOut(leadVideo()), []);
    await sql`UPDATE projects SET status = held_from_status, held_from_status = NULL WHERE id = ${ids.p4}`;
    const [{ client_month_id: monthId }] = await sql`SELECT client_month_id FROM projects WHERE id = ${ids.p4}`;
    await sql`UPDATE client_months SET status = 'closed' WHERE id = ${monthId}`;
    assert.deepEqual(await toHandOut(pm()), [], 'a closed month is read-only');
    await sql`UPDATE client_months SET status = 'open' WHERE id = ${monthId}`;
    assert.deepEqual(await toHandOut(leadVideo()), [['revision', 'Revision #02: Logo', 2]]);

    await assignRevision(leadVideo(), { revisionId: r2.revisionId, deliverableId: ids.promo01, assigneeId: ids.omar });
    assert.deepEqual(await dueOn(omar(), codes.p4), [['assignment', 'Revision #02: Logo', 2]], 'not #01’s missed date');
    assert.deepEqual(await dueOn(sara(), codes.p4), [['assignment', 'Promo art', -20]], 'the design half is late on #01');
    assert.deepEqual(await dueOn(leadVideo(), codes.p4), [['project', 'Awards reel', -20], ['assignment', 'Revision #02: Logo', 2]]);
  });

  test('the header counts what the inbox lists, row for row', async () => {
    await createAssignment(leadDesign(), {
      projectDepartmentId: ids.p4Design, assigneeId: ids.sara, title: 'Promo banner', deliverableCount: 0,
      endDate: await day(1),
    });
    const hers = await inboxMod.upcomingDeadlines(sara(), 3);
    assert.deepEqual(hers.map((d) => [d.kind, d.title, d.daysLeft]),
      [['assignment', 'Promo art', -20], ['assignment', 'Promo banner', 1]]);
    assert.equal(await inboxMod.deadlineCount(sara()), 2);
    assert.equal(await inboxMod.deadlineCount(sara(), 0), 1, 'the window is the inbox’s');
  });

  test('a lead’s own work sent back is one row to them, not a revision and an assignment', async () => {
    const p = await routedProject('Own cut', '2081-12', ['video']);
    const own = await createAssignment(leadVideo(), {
      projectDepartmentId: p.team('video'), assigneeId: ids.leadVideo, title: 'Lead cut',
      deliverableCount: 1, deliverableBaseName: 'Cut', endDate: await day(9),
    });
    const [cut] = own.deliverableIds;
    assert.deepEqual(await dueOn(leadVideo(), p.code), [], 'planned for next week');

    const r = await createRevision(sales(), {
      projectId: p.id, title: 'Again', clientFeedback: 'Once more.', deadline: await day(2), deliverableIds: [cut],
    });
    assert.deepEqual(await dueOn(leadVideo(), p.code), [['project', 'Own cut', 2], ['revision', 'Revision #01: Again', 2]]);
    assert.deepEqual(await dueOn(pm(), p.code), [['project', 'Own cut', 2], ['revision', 'Revision #01: Again', 2]]);

    // Taken up, it is their assignment on the revision's date.
    await assignRevision(leadVideo(), { revisionId: r.revisionId, deliverableId: cut, assigneeId: ids.leadVideo });
    assert.deepEqual(await dueOn(leadVideo(), p.code), [['assignment', 'Lead cut', 2], ['project', 'Own cut', 2]]);
    assert.deepEqual(await dueOn(pm(), p.code), [['project', 'Own cut', 2]]);
    assert.deepEqual((await received(ids.pm, 'revision.assigned', p.code)).map((n) => n.title),
      ['Revision #01 handed to leadVideo: Cut 01']);
    assert.deepEqual(await received(ids.leadVideo, 'revision.assigned', p.code), [], 'they took it themselves');
  });

  test('a rep moved out of Sales is not told about their old clients’ projects', async () => {
    const [rep] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES ('exrep@m11test.local', 'x', 'exrep', 'sales') RETURNING id`;
    const [client] = await sql<{ id: number }[]>`
      INSERT INTO clients (name, owner_user_id, created_by) VALUES ('M11 Test Client Two', ${rep.id}, ${rep.id})
      RETURNING id`;
    // The admin changes the role; the client is not handed on yet.
    await sql`UPDATE users SET role = 'executive' WHERE id = ${rep.id}`;
    const filed = await fileProject(pm(), {
      clientId: Number(client.id), period: '2081-12', title: 'Handover',
      departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
    });
    assert.deepEqual(await received(Number(rep.id), undefined, filed.projectCode), []);
  });

  test('handing out one of two same-named slots tells that team’s lead, once, and never the other', async () => {
    // Dana works in both teams, and both teams name their slots the default way.
    const [dana] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES ('dana@m11test.local', 'x', 'dana', 'executive') RETURNING id`;
    ids.dana = Number(dana.id);
    await sql`INSERT INTO department_members (user_id, department_id) VALUES (${ids.dana}, ${ids.video}), (${ids.dana}, ${ids.design})`;
    const p = await routedProject('Twin slots', '2081-12', ['video', 'design']);
    const [videoSlot] = (await createAssignment(leadVideo(), {
      projectDepartmentId: p.team('video'), assigneeId: ids.dana, title: 'Video part', deliverableCount: 1,
    })).deliverableIds;
    const [designSlot] = (await createAssignment(leadDesign(), {
      projectDepartmentId: p.team('design'), assigneeId: ids.dana, title: 'Design part', deliverableCount: 1,
    })).deliverableIds;
    const r = await createRevision(sales(), {
      projectId: p.id, title: 'Tweaks', clientFeedback: 'Small fixes.', deliverableIds: [videoSlot, designSlot],
    });
    await clearAll();

    // The PM hands out the video half only: the video lead hears of it,
    // exactly once, and the design lead nothing — the slot is named by its
    // id, not by the name both teams gave theirs.
    await assignRevision(pm(), { revisionId: r.revisionId, deliverableId: videoSlot, assigneeId: ids.dana });
    const handed = 'Revision #01 handed to dana: Deliverable 01';
    assert.deepEqual((await received(ids.leadVideo, 'revision.assigned', p.code)).map((n) => n.title), [handed]);
    assert.deepEqual(await received(ids.leadDesign, 'revision.assigned', p.code), [], 'nothing was handed out in design');
    assert.deepEqual(await received(ids.dana, 'revision.assigned', p.code).then((r) => r.map((n) => n.title)),
      ['Revision #01 assigned to you: Deliverable 01']);

    // Without the id, the name alone cannot say whose team the work went out
    // in: no lead is told rather than the wrong one.
    await clearAll();
    const { onRevisionAssigned } = await import('../src/lib/notifications/notify');
    const { getDb } = await import('../src/db');
    await onRevisionAssigned(getDb(), {
      projectId: p.id, revisionId: r.revisionId, revisionNo: r.revisionNo, title: 'Tweaks',
      deliverableName: 'Deliverable 01', assigneeId: ids.dana, actorId: ids.pm,
    });
    assert.deepEqual(await received(ids.leadVideo, 'revision.assigned', p.code), []);
    assert.deepEqual(await received(ids.leadDesign, 'revision.assigned', p.code), []);
  });
});
