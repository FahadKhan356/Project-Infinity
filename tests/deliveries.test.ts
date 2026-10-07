/**
 * Who reads and who moves the delivery list (brief §5, §12–§14, §23).
 *
 * Sales marks deliveries; the Project Manager reads the same list; a rep a
 * project is shared with reads its deliveries without marking them. Every
 * QA sign-off on the delivered version reaches Sales, not only the last.
 *
 * Needs DATABASE_URL pointing at a migrated database. Owns the year 2084.
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
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run delivery tests';

let sql: ReturnType<typeof postgres>;
let storageRoot: string;
let deliveries: typeof import('../src/lib/delivery/deliveries');
let viewers: typeof import('../src/lib/projects/viewers');

const ids: Record<string, number> = {};

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0, email: `${role}@w1dl.local`, fullName: role, role,
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

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE '%@w1dl.local'`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM notifications WHERE user_id IN (${users})`;
  await sql`DELETE FROM upload_sessions WHERE created_by IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'W1 Deliveries Test%')`;
  await sql`DELETE FROM clients WHERE name LIKE 'W1 Deliveries Test%'`;
  await sql`DELETE FROM files WHERE uploaded_by IN (${users})`;
  await sql`DELETE FROM department_members WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE '%@w1dl.local'`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2084`;
}

before(async () => {
  if (skip) return;
  try {
    await setUp();
  } catch (error) {
    console.error('\n[deliveries.test] fixture setup failed:', error);
    throw error;
  }
});

async function setUp() {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'aktivacity-w1dl-'));
  process.env.STORAGE_ROOT = storageRoot;

  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });
  deliveries = await import('../src/lib/delivery/deliveries');
  viewers = await import('../src/lib/projects/viewers');
  const uploads = await import('../src/lib/files/uploads');
  const { reviewDeliverable } = await import('../src/lib/qa/review');
  const { fileProject } = await import('../src/lib/projects/file-project');
  const { triageProject } = await import('../src/lib/projects/triage');
  const { createAssignment } = await import('../src/lib/planning/assign');
  await purge();

  ids.video = Number((await sql`SELECT id FROM departments WHERE slug = 'video'`)[0].id);
  const mkUser = async (key: string, role: string) => {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES (${`${key}@w1dl.local`}, 'x', ${key}, ${role}) RETURNING id`;
    ids[key] = Number(row.id);
  };
  await mkUser('sales', 'sales');
  await mkUser('otherSales', 'sales');
  await mkUser('pm', 'project_manager');
  await mkUser('leadVideo', 'team_lead');
  await mkUser('ahmed', 'executive');
  await sql`INSERT INTO department_members (user_id, department_id, is_lead)
            VALUES (${ids.leadVideo}, ${ids.video}, true), (${ids.ahmed}, ${ids.video}, false)`;

  const [client] = await sql<{ id: number }[]>`
    INSERT INTO clients (name, owner_user_id, created_by)
    VALUES ('W1 Deliveries Test Client', ${ids.sales}, ${ids.sales}) RETURNING id`;
  ids.client = Number(client.id);

  const filed = await fileProject(sales(), {
    clientId: ids.client, period: '2084-09', title: 'Launch video',
    departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
  });
  ids.project = filed.projectId;
  await triageProject(pm(), {
    projectId: ids.project, requiresPmQa: true,
    teams: [{ departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 }],
  });
  const [team] = await sql<{ id: number }[]>`
    SELECT id FROM project_departments WHERE project_id = ${ids.project}`;
  const work = await createAssignment(leadVideo(), {
    projectDepartmentId: Number(team.id), assigneeId: ids.ahmed, title: 'Cut the launch video',
    deliverableCount: 1, deliverableBaseName: 'Video',
  });
  [ids.video01] = work.deliverableIds;

  const upload = async (filename: string) => {
    const bytes = randomBytes(256);
    const { session } = await uploads.createUploadSession(ahmed(), {
      target: 'deliverable', deliverableId: ids.video01, filename, size: bytes.length,
    });
    await uploads.appendChunk(ahmed(), session.id, 0, streamOf(bytes));
    await uploads.completeUpload(ahmed(), session.id);
  };

  // v1 goes back with a comment; v2 passes the lead with one and the PM
  // without, so the lead's note is the only thing said about the file Sales sends.
  await upload('Launch_v1.mp4');
  await reviewDeliverable(leadVideo(), {
    deliverableId: ids.video01, decision: 'changes_requested', comments: 'Opening is too long.',
  });
  await upload('Launch_v2.mp4');
  await reviewDeliverable(leadVideo(), { deliverableId: ids.video01, decision: 'approved', comments: 'Good to go.' });
  const approved = await reviewDeliverable(pm(), { deliverableId: ids.video01, decision: 'approved' });
  ids.delivery = approved.deliveryId!;
}

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('QA comments reach Sales (brief §12, §14)', { skip }, () => {
  test('every sign-off on the delivered version, with its stage and reviewer', async () => {
    const item = (await deliveries.deliveryQueue(sales())).find((d) => d.deliveryId === ids.delivery);
    assert.ok(item, 'the Sales owner sees the delivery');
    assert.equal(item.versionNo, 2);
    assert.deepEqual(
      item.qaApprovals.map((a) => [a.stage, a.reviewer, a.comments]),
      [['team_lead', 'leadVideo', 'Good to go.'], ['project_manager', 'pm', null]],
      'the lead’s note survives a PM sign-off without one; v1’s change request is not an approval',
    );
    assert.ok(item.qaApprovals.every((a) => /^\d{4}-\d{2}-\d{2}T/.test(a.at)));
    assert.equal(item.canUpdate, true);
    assert.equal(item.canRevise, true);
  });
});

describe('the Project Manager’s Deliveries section (brief §5, §23)', { skip }, () => {
  test('the PM reads the list, read-only', async () => {
    const item = (await deliveries.deliveryQueue(pm())).find((d) => d.deliveryId === ids.delivery);
    assert.ok(item, 'the PM sees the delivery');
    assert.equal(item.status, 'pending_delivery');
    assert.equal(item.qaApprovals.length, 2);
    assert.equal(item.canUpdate, false);
  });

  test('the PM cannot mark a delivery: that stays with Sales (§14)', async () => {
    await assert.rejects(
      deliveries.updateDelivery(pm(), { deliveryId: ids.delivery, status: 'delivered' }),
      /not permitted to manage deliveries/,
    );
  });

  test('a Team Lead and an Executive have no delivery list', async () => {
    assert.deepEqual(await deliveries.deliveryQueue(leadVideo()), []);
    assert.deepEqual(await deliveries.deliveryQueue(ahmed()), []);
  });
});

describe('a rep the project is shared with (brief §23)', { skip }, () => {
  test('sees nothing before the share', async () => {
    const queue = await deliveries.deliveryQueue(otherSales());
    assert.ok(!queue.some((d) => d.deliveryId === ids.delivery));
  });

  test('reads the delivery once shared, but cannot mark it', async () => {
    await viewers.shareProject(pm(), { projectId: ids.project, userId: ids.otherSales });
    try {
      const item = (await deliveries.deliveryQueue(otherSales())).find((d) => d.deliveryId === ids.delivery);
      assert.ok(item, 'the shared project’s delivery is listed');
      assert.equal(item.canUpdate, false);
      assert.equal(item.canRevise, false, 'no revision link on a project that is not theirs');
      await assert.rejects(
        deliveries.updateDelivery(otherSales(), { deliveryId: ids.delivery, status: 'delivered' }),
        /shared with you to view/,
      );
      const { loadDashboard } = await import('../src/lib/dashboard/dashboard');
      assert.equal((await loadDashboard(otherSales())).pendingDeliveries, 0, 'not on their “ready to deliver” tile');
      assert.equal((await loadDashboard(sales())).pendingDeliveries, 1);
    } finally {
      await viewers.unshareProject(pm(), { projectId: ids.project, userId: ids.otherSales });
    }
    assert.ok(!(await deliveries.deliveryQueue(otherSales())).some((d) => d.deliveryId === ids.delivery));
  });

  test('the Sales owner still marks it', async () => {
    const result = await deliveries.updateDelivery(sales(), { deliveryId: ids.delivery, status: 'delivered' });
    assert.equal(result.status, 'delivered');
  });
});
