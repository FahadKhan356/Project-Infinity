/**
 * The client portal (brief §29): client login, the portal, client
 * approval/rejection and automated delivery.
 *
 * The acceptance case is isolation: a client login reads the files that were
 * delivered to its own client and nothing else — not another client's, not
 * an unfinished one, not an attachment — and holds no capability inside the
 * portal proper.
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
import type { Action, Actor, Permission, Role } from '../src/lib/authz/types';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run portal tests';

let sql: ReturnType<typeof postgres>;
let storageRoot: string;
let portal: typeof import('../src/lib/portal/portal');
let access: typeof import('../src/lib/portal/access');
let authz: typeof import('../src/lib/authz');
let authzQueries: typeof import('../src/lib/authz/queries');
let uploads: typeof import('../src/lib/files/uploads');
let fileProject: typeof import('../src/lib/projects/file-project').fileProject;
let triageProject: typeof import('../src/lib/projects/triage').triageProject;
let createAssignment: typeof import('../src/lib/planning/assign').createAssignment;
let reviewDeliverable: typeof import('../src/lib/qa/review').reviewDeliverable;
let updateDelivery: typeof import('../src/lib/delivery/deliveries').updateDelivery;
let projectActivity: typeof import('../src/lib/activity/feed').projectActivity;
let getDb: typeof import('../src/db').getDb;

const ids: Record<string, number> = {};
const DOMAIN = '@portaltest.local';

function actor(role: Role, id: number, over: Partial<Actor> = {}): Actor {
  return {
    id, email: `${role}${DOMAIN}`, fullName: role, role, isActive: true, mustChangePassword: false,
    leadDepartmentIds: [], departmentIds: [], permissions: new Set<Permission>(), ...over,
  };
}
const sales = () => actor('sales', ids.sales);
const pm = () => actor('project_manager', ids.pm);
const ceo = () => actor('ceo', ids.ceo);
const leadVideo = () => actor('team_lead', ids.leadVideo, { leadDepartmentIds: [ids.video], departmentIds: [ids.video] });
const ahmed = () => actor('executive', ids.ahmed, { departmentIds: [ids.video] });
const clientOf = (key: string) => actor('client', ids[key], { clientId: ids[key.replace('Login', '')] });
const acme = () => clientOf('acmeLogin');
const rival = () => clientOf('rivalLogin');

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE ${'%' + DOMAIN}`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM upload_sessions WHERE created_by IN (${users})`;
  await sql`DELETE FROM notifications WHERE user_id IN (${users})`;
  await sql`DELETE FROM sessions WHERE user_id IN (${users})`;
  await sql`UPDATE deliveries SET client_decided_by = NULL WHERE client_decided_by IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'Portal Test%')`;
  await sql`DELETE FROM files WHERE uploaded_by IN (${users})`;
  await sql`DELETE FROM department_members WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE ${'%' + DOMAIN} AND role = 'client'`;
  await sql`DELETE FROM clients WHERE name LIKE 'Portal Test%'`;
  await sql`DELETE FROM users WHERE email LIKE ${'%' + DOMAIN}`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2097`;
}

const stream = (b: Buffer) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(b)); c.close(); } });
async function uploadTo(who: Actor, deliverableId: number) {
  const b = randomBytes(32);
  const { session } = await uploads.createUploadSession(who, { target: 'deliverable', deliverableId, filename: 'cut.mp4', size: b.length });
  await uploads.appendChunk(who, session.id, 0, stream(b));
  return uploads.completeUpload(who, session.id);
}

/** A project for a client with `n` slots, each uploaded and approved by the lead (no PM QA). */
async function approvedWork(clientKey: string, n: number) {
  const p = await fileProject(sales(), {
    clientId: ids[clientKey], period: '2097-03', title: 'Reels', requiresPmQa: false, objective: 'Launch reach',
    internalNotes: 'Margin is thin — keep revisions tight', priceAmount: '5000.00',
    departments: [{ departmentId: ids.video, plannedDeliverables: n }],
  });
  await triageProject(pm(), { projectId: p.projectId, teams: [{ departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: n }] });
  const [pd] = await sql`SELECT id FROM project_departments WHERE project_id = ${p.projectId}`;
  const a = await createAssignment(leadVideo(), { projectDepartmentId: Number(pd.id), assigneeId: ids.ahmed, title: 'Edit', deliverableCount: n });
  const files: number[] = [];
  const deliveries: number[] = [];
  for (const slot of a.deliverableIds) {
    const up = await uploadTo(ahmed(), slot);
    files.push(Number((await sql`SELECT file_id FROM deliverable_versions WHERE deliverable_id = ${slot} AND is_current`)[0].file_id));
    void up;
    await reviewDeliverable(leadVideo(), { deliverableId: slot, decision: 'approved' });
    deliveries.push(Number((await sql`SELECT id FROM deliveries WHERE deliverable_id = ${slot}`)[0].id));
  }
  return { projectId: p.projectId, slots: a.deliverableIds, files, deliveries };
}

before(async () => {
  if (skip) return;
  storageRoot = await mkdtemp(path.join(tmpdir(), 'aktivacity-portal-'));
  process.env.STORAGE_ROOT = storageRoot;
  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });
  portal = await import('../src/lib/portal/portal');
  access = await import('../src/lib/portal/access');
  authz = await import('../src/lib/authz');
  authzQueries = await import('../src/lib/authz/queries');
  uploads = await import('../src/lib/files/uploads');
  ({ fileProject } = await import('../src/lib/projects/file-project'));
  ({ triageProject } = await import('../src/lib/projects/triage'));
  ({ createAssignment } = await import('../src/lib/planning/assign'));
  ({ reviewDeliverable } = await import('../src/lib/qa/review'));
  ({ updateDelivery } = await import('../src/lib/delivery/deliveries'));
  ({ projectActivity } = await import('../src/lib/activity/feed'));
  ({ getDb } = await import('../src/db'));
  await purge();

  ids.video = Number((await sql`SELECT id FROM departments WHERE slug = 'video'`)[0].id);
  for (const [key, role] of [['sales', 'sales'], ['pm', 'project_manager'], ['ceo', 'ceo'], ['leadVideo', 'team_lead'], ['ahmed', 'executive']] as const) {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role) VALUES (${key + DOMAIN}, 'x', ${key}, ${role}) RETURNING id`;
    ids[key] = Number(row.id);
  }
  await sql`INSERT INTO department_members (user_id, department_id, is_lead) VALUES (${ids.leadVideo}, ${ids.video}, true), (${ids.ahmed}, ${ids.video}, false)`;
  for (const [key, name] of [['acme', 'Portal Test Acme'], ['rival', 'Portal Test Rival']] as const) {
    const [c] = await sql<{ id: number }[]>`
      INSERT INTO clients (name, owner_user_id, created_by) VALUES (${name}, ${ids.sales}, ${ids.sales}) RETURNING id`;
    ids[key] = Number(c.id);
  }
});

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('client logins (brief §29)', { skip }, () => {
  test('Sales gives someone at their client access, with a one-time password', async () => {
    const created = await access.createPortalLogin(sales(), { clientId: ids.acme, fullName: 'Amira Acme', email: `Amira${DOMAIN}` });
    ids.acmeLogin = created.userId;
    assert.ok(created.temporaryPassword.length >= 20);
    const [u] = await sql`SELECT role, client_id, must_change_password, email FROM users WHERE id = ${created.userId}`;
    assert.deepEqual([u.role, Number(u.client_id), u.must_change_password, u.email], ['client', ids.acme, true, `amira${DOMAIN}`]);
    ids.rivalLogin = (await access.createPortalLogin(ceo(), { clientId: ids.rival, fullName: 'Rafi Rival', email: `rafi${DOMAIN}` })).userId;
    await assert.rejects(access.createPortalLogin(sales(), { clientId: ids.acme, fullName: 'Dup', email: `amira${DOMAIN}` }), /already/);
    await assert.rejects(access.createPortalLogin(leadVideo(), { clientId: ids.acme, fullName: 'X', email: `x${DOMAIN}` }), /not permitted/);
    assert.deepEqual((await access.listPortalLogins(sales(), ids.acme))!.map((l) => l.fullName), ['Amira Acme']);
    assert.equal(await access.listPortalLogins(leadVideo(), ids.acme), null);
  });

  test('a client login holds no capability and sees no project inside the portal proper', async () => {
    const actions: Action[] = ['projects.create', 'pricing.view', 'clients.manage', 'delivery.manage', 'revisions.create', 'reports.export'];
    const withGrants = { ...acme(), permissions: new Set<Permission>(['view_pricing', 'view_all_clients', 'export_reports']) };
    for (const a of actions) assert.equal(authz.can(withGrants, a), false, a);
    const work = await approvedWork('acme', 1);
    assert.equal(await authzQueries.isProjectVisible(getDb(), acme(), work.projectId), false);
    await assert.rejects(portal.portalProjects(sales()), /Not found/);
  });
});

describe('the portal (brief §29)', { skip }, () => {
  let work: Awaited<ReturnType<typeof approvedWork>>;
  let theirs: Awaited<ReturnType<typeof approvedWork>>;
  before(async () => {
    if (skip) return;
    work = await approvedWork('acme', 2);
    theirs = await approvedWork('rival', 1);
    await updateDelivery(sales(), { deliveryId: theirs.deliveries[0], status: 'delivered' });
  });

  test('nothing is visible until it is delivered; then only to its own client', async () => {
    assert.equal(await portal.clientMayReadFile(acme(), work.files[0]), false, 'approved but not delivered');
    const listed = (await portal.portalProjects(acme())).find((p) => p.id === work.projectId)!;
    assert.deepEqual([listed.deliverables, listed.delivered, listed.status], [2, 0, 'In production']);

    await updateDelivery(sales(), { deliveryId: work.deliveries[0], status: 'delivered' });
    assert.equal(await portal.clientMayReadFile(acme(), work.files[0]), true);
    assert.equal(await portal.clientMayReadFile(acme(), work.files[1]), false, 'the other slot is still with Sales');
    assert.equal(await portal.clientMayReadFile(rival(), work.files[0]), false, 'another client never');
    assert.equal(await portal.clientMayReadFile(acme(), theirs.files[0]), false);
    assert.equal((await portal.portalProjects(acme())).some((p) => p.id === theirs.projectId), false);
    assert.equal(await portal.portalProject(acme(), theirs.projectId), null);

    const note = await sql`SELECT link_path FROM notifications WHERE user_id = ${ids.acmeLogin} AND type = 'portal.delivered'`;
    assert.deepEqual(note.map((n) => n.link_path), [`/portal/projects/${work.projectId}`]);
  });

  test('the project page carries no internal notes or price', async () => {
    const detail = (await portal.portalProject(acme(), work.projectId))!;
    const text = JSON.stringify(detail);
    assert.doesNotMatch(text, /Margin is thin|5000/);
    assert.equal(detail.objective, 'Launch reach');
    assert.equal(detail.items.length, 1);
    assert.equal(detail.items[0].files[0].canDecide, true);
  });

  test('asking for changes needs words, reaches Sales and the PM, and cannot be repeated', async () => {
    await assert.rejects(portal.clientDecide(acme(), { deliveryId: work.deliveries[0], decision: 'changes_requested' }), /what should change/);
    await assert.rejects(portal.clientDecide(rival(), { deliveryId: work.deliveries[0], decision: 'approved' }), /Not found/);
    await portal.clientDecide(acme(), { deliveryId: work.deliveries[0], decision: 'changes_requested', feedback: 'Logo larger at the end' });
    const [dl] = await sql`SELECT status, client_decision, client_feedback, client_decided_by FROM deliveries WHERE id = ${work.deliveries[0]}`;
    assert.deepEqual([dl.status, dl.client_decision, dl.client_feedback, Number(dl.client_decided_by)],
      ['client_feedback_received', 'changes_requested', 'Logo larger at the end', ids.acmeLogin]);
    for (const who of [ids.sales, ids.pm]) {
      const n = await sql`SELECT body FROM notifications WHERE user_id = ${who} AND type = 'delivery.client_changes' AND entity_id = ${work.projectId}`;
      assert.equal(n.length, 1);
      assert.match(n[0].body, /Logo larger/);
    }
    await assert.rejects(portal.clientDecide(acme(), { deliveryId: work.deliveries[0], decision: 'approved' }), /already been reviewed/);
  });

  test('approving completes the delivery', async () => {
    await updateDelivery(sales(), { deliveryId: work.deliveries[1], status: 'delivered' });
    await portal.clientDecide(acme(), { deliveryId: work.deliveries[1], decision: 'approved' });
    const [dl] = await sql`SELECT status, client_decision FROM deliveries WHERE id = ${work.deliveries[1]}`;
    assert.deepEqual([dl.status, dl.client_decision], ['completed', 'approved']);
    const n = await sql`SELECT 1 FROM notifications WHERE user_id = ${ids.sales} AND type = 'delivery.client_approved'`;
    assert.ok(n.length >= 1);
  });

  test('a closed month stops decisions', async () => {
    const [m] = await sql`SELECT client_month_id FROM projects WHERE id = ${theirs.projectId}`;
    await sql`UPDATE client_months SET status = 'closed', closed_at = now(), closed_by = ${ids.pm} WHERE id = ${m.client_month_id}`;
    try {
      await assert.rejects(portal.clientDecide(rival(), { deliveryId: theirs.deliveries[0], decision: 'approved' }), /closed/);
      const detail = (await portal.portalProject(rival(), theirs.projectId))!;
      assert.equal(detail.items[0].files[0].canDecide, false);
    } finally {
      await sql`UPDATE client_months SET status = 'open', closed_at = NULL, closed_by = NULL WHERE id = ${m.client_month_id}`;
    }
  });
});

describe('automated client delivery (brief §29)', { skip }, () => {
  test('with auto-delivery on, a file that clears QA is in the portal at once', async () => {
    await access.setAutoDeliver(sales(), { clientId: ids.acme, on: true });
    const work = await approvedWork('acme', 1);
    const [dl] = await sql`SELECT status, delivered_at, notes FROM deliveries WHERE id = ${work.deliveries[0]}`;
    assert.equal(dl.status, 'delivered');
    assert.ok(dl.delivered_at);
    const [d] = await sql`SELECT status FROM deliverables WHERE id = ${work.slots[0]}`;
    assert.equal(d.status, 'delivered');
    assert.equal(await portal.clientMayReadFile(acme(), work.files[0]), true);
    const [p] = await sql`SELECT status FROM projects WHERE id = ${work.projectId}`;
    assert.equal(p.status, 'delivered');

    // The timeline reads approval, then the delivery Sales received, then
    // the portal sending it (§25).
    const feed = (await projectActivity(work.projectId)).map((l) => l.text);
    assert.deepEqual(feed, [
      'leadVideo approved Deliverable 01 v1',
      'Sales received delivery of Deliverable 01 v1',
      'Deliverable 01 was delivered to the client portal automatically',
    ]);
  });

  test('with nobody to deliver to, it waits for Sales as before', async () => {
    await access.setPortalLoginActive(sales(), { userId: ids.acmeLogin, active: false });
    try {
      const work = await approvedWork('acme', 1);
      const [dl] = await sql`SELECT status FROM deliveries WHERE id = ${work.deliveries[0]}`;
      assert.equal(dl.status, 'pending_delivery');
      await assert.rejects(portal.portalProjects({ ...acme(), isActive: false }), /Not found/);
    } finally {
      await access.setPortalLoginActive(sales(), { userId: ids.acmeLogin, active: true });
      await access.setAutoDeliver(sales(), { clientId: ids.acme, on: false });
    }
  });

  test('resetting a password forces a new one at next sign-in', async () => {
    await sql`UPDATE users SET must_change_password = false WHERE id = ${ids.acmeLogin}`;
    const r = await access.resetPortalPassword(sales(), ids.acmeLogin);
    assert.ok(r.temporaryPassword);
    const [u] = await sql`SELECT must_change_password FROM users WHERE id = ${ids.acmeLogin}`;
    assert.equal(u.must_change_password, true);
    await assert.rejects(access.resetPortalPassword(sales(), ids.sales), /Unknown login/, 'staff are not portal logins');
  });
});
