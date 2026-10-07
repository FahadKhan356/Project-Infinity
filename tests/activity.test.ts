/**
 * The management-wide activity log and the delivery-received line (brief §25).
 *
 * Management tracks accountability across projects: one page lists every
 * project's record newest first, filtered and paged, for those who may see
 * every project. And the moment QA clears a file, the record says Sales
 * received the delivery, ahead of whatever Sales (or the portal) does with it.
 *
 * Needs DATABASE_URL pointing at a migrated database. Owns the year 2065.
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
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run activity log tests';

let sql: ReturnType<typeof postgres>;
let storageRoot: string;
let log: typeof import('../src/lib/activity/log');
let feed: typeof import('../src/lib/activity/feed');
let describeMod: typeof import('../src/lib/activity/describe');
let review: typeof import('../src/lib/qa/review');
let deliveries: typeof import('../src/lib/delivery/deliveries');
let AuthorizationError: typeof import('../src/lib/authz').AuthorizationError;

const ids: Record<string, number> = {};
const codes: Record<string, string> = {};

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0, email: `${role}@a5act.local`, fullName: role, role,
    isActive: true, mustChangePassword: false,
    leadDepartmentIds: [], departmentIds: [], permissions: new Set<Permission>(), ...over,
  };
}

const sales = () => actor('sales', { id: ids.sales });
const otherSales = () => actor('sales', { id: ids.otherSales });
const pm = () => actor('project_manager', { id: ids.pm });
const leadVideo = () => actor('team_lead', { id: ids.leadVideo, leadDepartmentIds: [ids.video], departmentIds: [ids.video] });
const ahmed = () => actor('executive', { id: ids.ahmed, departmentIds: [ids.video] });

function streamOf(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

/** YYYY-MM-DD of today plus `days`, from the machine's local calendar. */
function localDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE '%@a5act.local'`;
  const clients = sql`SELECT id FROM clients WHERE name LIKE 'A5 Activity Test%'`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM activity_log WHERE project_id IN (SELECT id FROM projects WHERE client_id IN (${clients}))`;
  await sql`DELETE FROM activity_log WHERE client_id IN (${clients})`;
  await sql`DELETE FROM notifications WHERE user_id IN (${users})`;
  await sql`DELETE FROM upload_sessions WHERE created_by IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (${clients})`;
  await sql`DELETE FROM clients WHERE name LIKE 'A5 Activity Test%'`;
  await sql`DELETE FROM files WHERE uploaded_by IN (${users})`;
  await sql`DELETE FROM department_members WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE '%@a5act.local'`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2065`;
}

before(async () => {
  if (skip) return;
  try {
    await setUp();
  } catch (error) {
    console.error('\n[activity.test] fixture setup failed:', error);
    throw error;
  }
});

async function setUp() {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'aktivacity-a5act-'));
  process.env.STORAGE_ROOT = storageRoot;

  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });
  log = await import('../src/lib/activity/log');
  feed = await import('../src/lib/activity/feed');
  describeMod = await import('../src/lib/activity/describe');
  review = await import('../src/lib/qa/review');
  deliveries = await import('../src/lib/delivery/deliveries');
  ({ AuthorizationError } = await import('../src/lib/authz'));
  const uploads = await import('../src/lib/files/uploads');
  const { fileProject } = await import('../src/lib/projects/file-project');
  const { triageProject } = await import('../src/lib/projects/triage');
  const { createAssignment } = await import('../src/lib/planning/assign');
  await purge();

  ids.video = Number((await sql`SELECT id FROM departments WHERE slug = 'video'`)[0].id);
  const mkUser = async (key: string, role: string) => {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES (${`${key}@a5act.local`}, 'x', ${key}, ${role}) RETURNING id`;
    ids[key] = Number(row.id);
  };
  await mkUser('sales', 'sales');
  await mkUser('otherSales', 'sales');
  await mkUser('pm', 'project_manager');
  await mkUser('leadVideo', 'team_lead');
  await mkUser('ahmed', 'executive');
  await sql`INSERT INTO department_members (user_id, department_id, is_lead)
            VALUES (${ids.leadVideo}, ${ids.video}, true), (${ids.ahmed}, ${ids.video}, false)`;

  const [clientA] = await sql<{ id: number }[]>`
    INSERT INTO clients (name, owner_user_id, created_by)
    VALUES ('A5 Activity Test Client A', ${ids.sales}, ${ids.sales}) RETURNING id`;
  ids.clientA = Number(clientA.id);
  const [clientB] = await sql<{ id: number }[]>`
    INSERT INTO clients (name, owner_user_id, created_by)
    VALUES ('A5 Activity Test Client B', ${ids.otherSales}, ${ids.otherSales}) RETURNING id`;
  ids.clientB = Number(clientB.id);

  const upload = async (deliverableId: number, filename: string) => {
    const bytes = randomBytes(256);
    const { session } = await uploads.createUploadSession(ahmed(), {
      target: 'deliverable', deliverableId, filename, size: bytes.length,
    });
    await uploads.appendChunk(ahmed(), session.id, 0, streamOf(bytes));
    await uploads.completeUpload(ahmed(), session.id);
  };

  // Project A: the PM signs off after the lead, so the delivery row appears
  // only on the second approval. Its approvals happen inside the tests.
  const a = await fileProject(sales(), {
    clientId: ids.clientA, period: '2065-09', title: 'Launch video',
    departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
  });
  ids.projectA = a.projectId;
  codes.A = a.projectCode;
  await triageProject(pm(), {
    projectId: ids.projectA, requiresPmQa: true,
    teams: [{ departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1, requiresPmQa: true }],
  });
  const [teamA] = await sql<{ id: number }[]>`SELECT id FROM project_departments WHERE project_id = ${ids.projectA}`;
  const workA = await createAssignment(leadVideo(), {
    projectDepartmentId: Number(teamA.id), assigneeId: ids.ahmed, title: 'Cut the launch video',
    deliverableCount: 1, deliverableBaseName: 'Video',
  });
  [ids.video01] = workA.deliverableIds;
  await upload(ids.video01, 'Launch_v1.mp4');

  // Project B: the lead's approval is the last QA stage, so it clears the
  // file and Sales receives the delivery at once.
  const b = await fileProject(otherSales(), {
    clientId: ids.clientB, period: '2065-10', title: 'Teaser',
    departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
  });
  ids.projectB = b.projectId;
  codes.B = b.projectCode;
  await triageProject(pm(), {
    projectId: ids.projectB, requiresPmQa: false,
    teams: [{ departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1, requiresPmQa: false }],
  });
  const [teamB] = await sql<{ id: number }[]>`SELECT id FROM project_departments WHERE project_id = ${ids.projectB}`;
  const workB = await createAssignment(leadVideo(), {
    projectDepartmentId: Number(teamB.id), assigneeId: ids.ahmed, title: 'Cut the teaser',
    deliverableCount: 1, deliverableBaseName: 'Teaser',
  });
  [ids.teaser01] = workB.deliverableIds;
  await upload(ids.teaser01, 'Teaser_v1.mp4');
  const okB = await review.reviewDeliverable(leadVideo(), { deliverableId: ids.teaser01, decision: 'approved' });
  assert.ok(okB.deliveryId, 'the lead’s approval clears QA on project B');
  ids.deliveryB = okB.deliveryId;
}

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('the wording and the feed (brief §25)', { skip }, () => {
  test('“Sales received delivery” names the file and its version, whoever approved it', () => {
    assert.equal(
      describeMod.describeActivity({ action: 'delivery.received', actorName: 'pm', metadata: { deliverableName: 'Video 01', versionNo: 2 } }),
      'Sales received delivery of Video 01 v2',
    );
    assert.equal(
      describeMod.describeActivity({ action: 'delivery.received', actorName: null, metadata: {} }),
      'Sales received delivery of a deliverable',
    );
    assert.ok(feed.FEED_ACTIONS.includes('delivery.received'), 'the line is part of the project page and the month report');
  });
});

describe('the delivery on the record (brief §14, §25)', { skip }, () => {
  test('a delivery.received row is written when, and only when, the delivery row is created', async () => {
    const received = () => sql<{ id: number; actor_id: number; entity_type: string; entity_id: number; project_id: number; client_id: number; metadata: Record<string, unknown> }[]>`
      SELECT id, actor_id, entity_type, entity_id, project_id, client_id, metadata FROM activity_log
      WHERE action = 'delivery.received' AND project_id = ${ids.projectA}`;

    await review.reviewDeliverable(leadVideo(), { deliverableId: ids.video01, decision: 'approved' });
    assert.equal((await received()).length, 0, 'the lead’s approval still leaves the PM to sign off');

    const result = await review.reviewDeliverable(pm(), { deliverableId: ids.video01, decision: 'approved' });
    assert.ok(result.deliveryId);
    ids.deliveryA = result.deliveryId;

    const rows = await received();
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.deepEqual(
      [row.entity_type, Number(row.entity_id), Number(row.actor_id), Number(row.project_id), Number(row.client_id)],
      ['delivery', result.deliveryId, ids.pm, ids.projectA, ids.clientA],
    );
    assert.deepEqual(row.metadata, {
      deliveryId: result.deliveryId, deliverableId: ids.video01, deliverableName: 'Video 01', versionNo: 1, stage: 'project_manager',
    });

    const [approval] = await sql<{ id: number }[]>`
      SELECT id FROM activity_log
      WHERE action = 'qa.reviewed' AND entity_type = 'deliverable' AND entity_id = ${ids.video01} AND actor_id = ${ids.pm}`;
    assert.ok(Number(row.id) > Number(approval.id), 'the approval is recorded first');

    const lines = (await feed.projectActivity(ids.projectA)).map((l) => l.text);
    assert.deepEqual(lines.slice(-2), ['pm approved Video 01 v1', 'Sales received delivery of Video 01 v1']);
  });

  test('a status change made through the library is on the record', async () => {
    await deliveries.updateDelivery(sales(), { deliveryId: ids.deliveryA, status: 'delivered' });
    const rows = await sql<{ actor_id: number; client_id: number; project_id: number; metadata: Record<string, unknown> }[]>`
      SELECT actor_id, client_id, project_id, metadata FROM activity_log
      WHERE action = 'delivery.updated' AND entity_type = 'delivery' AND entity_id = ${ids.deliveryA}`;
    assert.equal(rows.length, 1, 'once, and only once');
    assert.deepEqual([Number(rows[0].actor_id), Number(rows[0].client_id), Number(rows[0].project_id)], [ids.sales, ids.clientA, ids.projectA]);
    assert.deepEqual(rows[0].metadata, {
      status: 'delivered', deliverableId: ids.video01, deliverableName: 'Video 01', projectStatus: 'delivered',
    });
    const lines = (await feed.projectActivity(ids.projectA)).map((l) => l.text);
    assert.ok(lines.includes('sales delivered Video 01 to the client'), lines.join('\n'));
  });
});

describe('the management-wide log (brief §25)', { skip }, () => {
  test('who may open it', async () => {
    for (const who of [actor('ceo'), actor('coo'), actor('admin'), pm()]) {
      assert.equal(log.canViewActivityLog(who), true, who.role);
    }
    for (const who of [sales(), leadVideo(), ahmed(), actor('client'), { ...pm(), isActive: false }]) {
      assert.equal(log.canViewActivityLog(who), false, who.role);
    }
    for (const who of [ahmed(), leadVideo(), sales()]) {
      await assert.rejects(log.activityLog(who, {}), AuthorizationError, who.role);
    }
    await assert.rejects(log.activityLogOptions(ahmed()), AuthorizationError);
  });

  test('the PM sees the suite’s rows, each tied to its project, newest first', async () => {
    const page = await log.activityLog(pm(), { clientId: ids.clientA });
    assert.ok(page.rows.length >= 3, 'the review, the receipt and the delivery at least');
    for (const row of page.rows) {
      assert.equal(row.clientId, ids.clientA);
      assert.equal(row.projectId, ids.projectA);
      assert.equal(row.projectCode, codes.A);
      assert.equal(row.clientName, 'A5 Activity Test Client A');
      assert.ok(row.text.length > 0);
    }
    const actions = new Set(page.rows.map((r) => r.action));
    for (const action of ['qa.reviewed', 'delivery.received', 'delivery.updated']) assert.ok(actions.has(action), action);
    for (let i = 0; i + 1 < page.rows.length; i++) {
      assert.ok(page.rows[i].at >= page.rows[i + 1].at, 'newest first');
    }
    assert.deepEqual([page.page, page.pageSize, page.hasMore], [1, 50, false]);
  });

  test('filters narrow the log', async () => {
    const byB = await log.activityLog(pm(), { projectCode: codes.B });
    assert.ok(byB.rows.length >= 1);
    assert.ok(byB.rows.every((r) => r.projectCode === codes.B));
    assert.ok(byB.rows.some((r) => r.action === 'delivery.received'), 'B’s lead approval cleared QA');

    // A substring of the code — the year and number, which the other project does not share.
    const bySubstring = await log.activityLog(pm(), { projectCode: codes.A.slice(4) });
    assert.ok(bySubstring.rows.length >= 1);
    assert.ok(bySubstring.rows.every((r) => r.projectCode === codes.A));

    const bySales = await log.activityLog(pm(), { actorId: ids.sales, clientId: ids.clientA });
    assert.ok(bySales.rows.length >= 1);
    assert.ok(bySales.rows.every((r) => r.actorName === 'sales'));
    assert.ok(bySales.rows.some((r) => r.action === 'delivery.updated'));

    const byAction = await log.activityLog(pm(), { action: 'delivery.received', clientId: ids.clientA });
    assert.equal(byAction.rows.length, 1);
    assert.ok(byAction.rows.every((r) => r.action === 'delivery.received'));

    assert.deepEqual((await log.activityLog(pm(), { action: 'no.such_action', clientId: ids.clientA })).rows, []);

    const all = await log.activityLog(pm(), { clientId: ids.clientA });
    const inRange = await log.activityLog(pm(), { clientId: ids.clientA, from: localDate(-1), to: localDate(1) });
    assert.deepEqual(inRange.rows.map((r) => r.id), all.rows.map((r) => r.id));
    assert.deepEqual((await log.activityLog(pm(), { clientId: ids.clientA, from: localDate(2) })).rows, []);
    assert.deepEqual((await log.activityLog(pm(), { clientId: ids.clientA, to: localDate(-2) })).rows, []);
  });

  test('pages of fifty', async () => {
    for (let i = 1; i <= 60; i++) {
      await sql`INSERT INTO activity_log (actor_id, action, entity_type, entity_id, project_id, metadata, created_at)
                VALUES (${ids.ahmed}, 'comment.posted', 'comment', ${i}, ${ids.projectA}, '{}'::jsonb,
                        now() - make_interval(mins => ${i}))`;
    }
    const [{ total }] = await sql<{ total: number }[]>`
      SELECT count(*)::int AS total FROM activity_log WHERE project_id = ${ids.projectA}`;
    assert.ok(total > 50 && total <= 100);

    const first = await log.activityLog(pm(), { projectCode: codes.A, page: 1 });
    assert.deepEqual([first.rows.length, first.pageSize, first.hasMore, first.page], [50, 50, true, 1]);
    const second = await log.activityLog(pm(), { projectCode: codes.A, page: 2 });
    assert.deepEqual([second.rows.length, second.hasMore, second.page], [total - 50, false, 2]);
    const firstIds = new Set(first.rows.map((r) => r.id));
    assert.ok(second.rows.every((r) => !firstIds.has(r.id)), 'the pages do not overlap');
    assert.ok(second.rows[0].at <= first.rows[first.rows.length - 1].at, 'page two continues where page one ended');

    const again = await log.activityLog(pm(), { projectCode: codes.A, page: 0 });
    assert.deepEqual(again.rows.map((r) => r.id), first.rows.map((r) => r.id));
    const nan = await log.activityLog(pm(), { projectCode: codes.A, page: Number.NaN });
    assert.deepEqual(nan.rows.map((r) => r.id), first.rows.map((r) => r.id));

    assert.deepEqual(
      log.parseActivityLogParams({ client: '3', code: ' AKT ', actor: '7', action: 'qa.reviewed', from: '2065-09-01', to: 'bad', page: '2' }),
      { clientId: 3, projectCode: 'AKT', actorId: 7, action: 'qa.reviewed', from: '2065-09-01', to: null, page: 2 },
    );
    assert.deepEqual(
      log.parseActivityLogParams({ action: 'DROP TABLE', page: 'x' }),
      { clientId: null, projectCode: null, actorId: null, action: null, from: null, to: null, page: 1 },
    );
  });

  test('the filter options', async () => {
    const options = await log.activityLogOptions(pm());
    const clientNames = options.clients.map((c) => c.name);
    assert.ok(clientNames.includes('A5 Activity Test Client A') && clientNames.includes('A5 Activity Test Client B'));
    const actorNames = options.actors.map((a) => a.name);
    assert.ok(actorNames.includes('sales') && actorNames.includes('pm'));
    assert.ok(options.actions.includes('delivery.received') && options.actions.includes('qa.reviewed'));
  });
});
