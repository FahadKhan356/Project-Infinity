/**
 * The local server and its file store (brief §28 Phase 1 checklist, §40–§46),
 * through the domain layer.
 *
 *   - Where a file lands (§42): client → month → project, with the leaf an
 *     unguessable UUID; a hostile filename cannot steer the directory.
 *   - The only way bytes leave (§43): GET /api/files, which names the version
 *     in the download, previews only what cannot run script, logs every hit,
 *     answers an outsider and an undelivered client login with 404 — and
 *     `npm run setup`, which makes the store readable by the portal's own
 *     account alone.
 *   - A right that lapses while an upload is in flight (§43): the completion
 *     re-checks it, keeps the staged bytes for a retry, and records nothing.
 *   - A held, cancelled or completed project takes no new references (§18),
 *     the same rule as for deliverables.
 *   - Version notes (§10, §19) and attachment purposes (§3, §7, §15).
 *   - The nightly run (§20, §36): reminders once per line crossed, to the
 *     people on the work and not to management; months archived with no
 *     closer once their work is settled, and worded so in the activity log.
 *   - The demo seed (`npm run db:seed:demo`, §37): loads an empty database
 *     of its own, and a month it opens by hand is listed in that month's
 *     view like one opened from the client page.
 *
 * Needs DATABASE_URL pointing at a migrated database. Fixtures use the year
 * 2076, emails at @w3infra.local and clients named "W3 infra …", and only
 * those are purged.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';
// First of the Next imports, as in Next's own server: it provides the
// AsyncLocalStorage that request scopes (cookies(), headers()) live in.
import 'next/dist/server/node-environment-baseline';
import { NextRequest } from 'next/server';
import { workAsyncStorage } from 'next/dist/server/app-render/work-async-storage.external';
import { workUnitAsyncStorage } from 'next/dist/server/app-render/work-unit-async-storage.external';
import { createRequestStoreForAPI } from 'next/dist/server/async-storage/request-store';
import { createWorkStore } from 'next/dist/server/async-storage/work-store';
import postgres from 'postgres';
import type { Actor, Permission, Role } from '../src/lib/authz/types';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run the w3-infra tests';

const DOMAIN = '@w3infra.local';
const CLIENT_PREFIX = 'W3 infra ';
const PERIOD = '2076-09';
const YEAR = 2076;
const ROOT = path.resolve(__dirname, '..');

// The pure path rules need a root to resolve against, database or not.
process.env.STORAGE_ROOT ??= '/var/lib/aktivacity/storage';

let sql: ReturnType<typeof postgres>;
let storageRoot: string;

let storage: typeof import('../src/lib/files/storage');
let access: typeof import('../src/lib/files/access');
let uploads: typeof import('../src/lib/files/uploads');
let attachmentsMod: typeof import('../src/lib/files/attachments');
let lifecycle: typeof import('../src/lib/months/lifecycle');
let reminders: typeof import('../src/lib/notifications/reminders');
let inboxMod: typeof import('../src/lib/notifications/inbox');
let describeActivity: typeof import('../src/lib/activity/describe').describeActivity;
let getDb: typeof import('../src/db').getDb;
let fileProject: typeof import('../src/lib/projects/file-project').fileProject;
let triageProject: typeof import('../src/lib/projects/triage').triageProject;
let createAssignment: typeof import('../src/lib/planning/assign').createAssignment;
let reviewDeliverable: typeof import('../src/lib/qa/review').reviewDeliverable;
let updateDelivery: typeof import('../src/lib/delivery/deliveries').updateDelivery;
let createRevision: typeof import('../src/lib/revisions/revisions').createRevision;
let changeProjectStatus: typeof import('../src/lib/projects/status').changeProjectStatus;
let shareProject: typeof import('../src/lib/projects/viewers').shareProject;
let loadWorkspace: typeof import('../src/lib/workspace/workspace').loadWorkspace;

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
const otherSales = () => actor('sales', { id: ids.otherSales });
const pm = () => actor('project_manager', { id: ids.pm });
const leadVideo = () => actor('team_lead', { id: ids.leadVideo, leadDepartmentIds: [ids.video], departmentIds: [ids.video] });
const leadDesign = () => actor('team_lead', { id: ids.leadDesign, leadDepartmentIds: [ids.design], departmentIds: [ids.design] });
const ahmed = () => actor('executive', { id: ids.ahmed, departmentIds: [ids.video] });

/** Every staff user this suite makes. The client login is added after its client exists. */
const USERS = [
  ['sales', 'sales'], ['otherSales', 'sales'], ['pm', 'project_manager'], ['pm2', 'project_manager'],
  ['ceo', 'ceo'], ['leadVideo', 'team_lead'], ['leadDesign', 'team_lead'],
  ['ahmed', 'executive'], ['sara', 'executive'], ['omar', 'executive'],
] as const;

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE ${`%${DOMAIN}`}`;
  const clients = sql`SELECT id FROM clients WHERE name LIKE ${`${CLIENT_PREFIX}%`}`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  // The automatic archive writes with no actor; its rows carry the client.
  await sql`DELETE FROM activity_log WHERE client_id IN (${clients})`;
  await sql`DELETE FROM sessions WHERE user_id IN (${users})`;
  await sql`DELETE FROM upload_sessions WHERE created_by IN (${users})`;
  await sql`DELETE FROM notifications WHERE user_id IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (${clients})`;
  // A client login points at its client, and the client at the rep who made it.
  await sql`DELETE FROM users WHERE email LIKE ${`%${DOMAIN}`} AND role = 'client'`;
  await sql`DELETE FROM clients WHERE name LIKE ${`${CLIENT_PREFIX}%`}`;
  await sql`DELETE FROM files WHERE uploaded_by IN (${users})`;
  await sql`DELETE FROM department_members WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE ${`%${DOMAIN}`}`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = ${YEAR}`;
}

const bytes = (n = 48) => randomBytes(n);
const stream = (b: Buffer) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(b)); c.close(); } });

type Extra = { mimeType?: string; notes?: string; purpose?: string; assignmentId?: number; revisionId?: number };

/** Opens a session and sends every byte, without completing it. */
async function stage(who: Actor, input: Parameters<typeof uploads.createUploadSession>[1]) {
  const payload = bytes();
  const { session } = await uploads.createUploadSession(who, { ...input, size: payload.length });
  await uploads.appendChunk(who, session.id, 0, stream(payload));
  return { session, payload };
}
async function uploadTo(who: Actor, deliverableId: number, filename: string, extra: Extra = {}) {
  const { session, payload } = await stage(who, { target: 'deliverable', deliverableId, filename, size: 0, ...extra });
  return { ...(await uploads.completeUpload(who, session.id)), payload };
}
async function attach(who: Actor, projectId: number, filename: string, extra: Extra = {}) {
  const { session, payload } = await stage(who, { target: 'attachment', projectId, filename, size: 0, ...extra });
  return { ...(await uploads.completeUpload(who, session.id)), payload };
}

async function teamOf(projectId: number, slug: string) {
  return Number((await sql`SELECT id FROM project_departments WHERE project_id = ${projectId} AND department_id = ${ids[slug]}`)[0].id);
}

/** Files and routes a project; a team whose lead is null is left without one. */
async function newProject(title: string, teams: { slug: string; lead: string | null; n: number }[]) {
  const p = await fileProject(sales(), {
    clientId: ids.client, period: PERIOD, title, priceAmount: '1000.00', requiresPmQa: false,
    departments: teams.map((t) => ({ departmentId: ids[t.slug], plannedDeliverables: t.n })),
  });
  await triageProject(pm(), {
    projectId: p.projectId,
    teams: teams.map((t) => ({ departmentId: ids[t.slug], teamLeadId: t.lead ? ids[t.lead] : null, plannedDeliverables: t.n })),
  });
  return { projectId: p.projectId, code: p.projectCode };
}

/** Today plus `offset` days, as the database sees it. */
async function day(offset: number): Promise<string> {
  const [row] = await sql<{ d: string }[]>`SELECT to_char(current_date + ${offset}::int, 'YYYY-MM-DD') AS d`;
  return row.d;
}

const stagedSize = (session: { tempPath: string }) => storage.fileSize(session.tempPath);

before(async () => {
  if (skip) return;
  try {
    await setUp();
  } catch (error) {
    // node:test can hang rather than report a rejected before() hook.
    console.error('\n[w3-infra.test] fixture setup failed:', error);
    throw error;
  }
});

async function setUp() {
  // A directory of this run's own under the OS tmpdir: suites run in
  // parallel and must never share, or sweep, one another's file store.
  storageRoot = await mkdtemp(path.join(tmpdir(), 'w3-infra-'));
  process.env.STORAGE_ROOT = storageRoot;
  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });

  storage = await import('../src/lib/files/storage');
  access = await import('../src/lib/files/access');
  uploads = await import('../src/lib/files/uploads');
  attachmentsMod = await import('../src/lib/files/attachments');
  lifecycle = await import('../src/lib/months/lifecycle');
  reminders = await import('../src/lib/notifications/reminders');
  inboxMod = await import('../src/lib/notifications/inbox');
  ({ describeActivity } = await import('../src/lib/activity/describe'));
  ({ getDb } = await import('../src/db'));
  ({ fileProject } = await import('../src/lib/projects/file-project'));
  ({ triageProject } = await import('../src/lib/projects/triage'));
  ({ createAssignment } = await import('../src/lib/planning/assign'));
  ({ reviewDeliverable } = await import('../src/lib/qa/review'));
  ({ updateDelivery } = await import('../src/lib/delivery/deliveries'));
  ({ createRevision } = await import('../src/lib/revisions/revisions'));
  ({ changeProjectStatus } = await import('../src/lib/projects/status'));
  ({ shareProject } = await import('../src/lib/projects/viewers'));
  ({ loadWorkspace } = await import('../src/lib/workspace/workspace'));
  await purge();

  for (const slug of ['video', 'design']) {
    ids[slug] = Number((await sql`SELECT id FROM departments WHERE slug = ${slug}`)[0].id);
  }
  for (const [key, role] of USERS) {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role, must_change_password)
      VALUES (${`${key}${DOMAIN}`}, 'x', ${key}, ${role}, false) RETURNING id`;
    ids[key] = Number(row.id);
  }
  for (const [key, slug, lead] of [
    ['leadVideo', 'video', true], ['leadDesign', 'design', true],
    ['ahmed', 'video', false], ['omar', 'video', false], ['sara', 'design', false],
  ] as const) {
    await sql`INSERT INTO department_members (user_id, department_id, is_lead) VALUES (${ids[key]}, ${ids[slug]}, ${lead})`;
  }
  const [client] = await sql<{ id: number }[]>`
    INSERT INTO clients (name, owner_user_id, created_by) VALUES (${`${CLIENT_PREFIX}Client`}, ${ids.sales}, ${ids.sales}) RETURNING id`;
  ids.client = Number(client.id);
  const [login] = await sql<{ id: number }[]>`
    INSERT INTO users (email, password_hash, full_name, role, client_id, must_change_password)
    VALUES (${`client${DOMAIN}`}, 'x', 'Client One', 'client', ${ids.client}, false) RETURNING id`;
  ids.clientLogin = Number(login.id);
}

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
  await rm(storageRoot, { recursive: true, force: true });
});

/* ------------------------------------------------------------ §42 paths */

describe('where a file lands (brief §42)', () => {
  test('an attachment sits under the client, the month and the project; the filename cannot steer it', async () => {
    const s = await import('../src/lib/files/storage');
    const at = (originalFilename: string) => s.attachmentRelativePath({
      clientId: 7, periodYear: 2026, periodMonth: 3, projectId: 12,
      storageKey: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', originalFilename,
    });
    const expected = 'files/clients/7/2026-03/projects/12/attachments/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.pdf';
    assert.equal(at('brief.pdf'), expected, 'the month is zero-padded');
    assert.equal(at('../../x.pdf'), expected, 'only the extension survives, and only when it is plain');
    assert.equal(at('payload.php%00'), expected.replace(/\.pdf$/, ''), 'a doubtful extension is dropped');
    assert.doesNotThrow(() => s.absolutePath(at('../../x.pdf')));
  });

  test('a real attachment and a real version are filed under their project’s month', { skip }, async () => {
    const { projectId } = await newProject('Filed', [{ slug: 'video', lead: 'leadVideo', n: 1 }]);
    const po = await attach(sales(), projectId, 'PO-4411.pdf');
    assert.match(po.storagePath, new RegExp(`^files/clients/${ids.client}/2076-09/projects/${projectId}/attachments/[0-9a-f-]{36}\\.pdf$`));
    assert.equal((await stat(storage.absolutePath(po.storagePath))).size, po.payload.length, 'the bytes are where the row says');
    const [row] = await sql`SELECT storage_path FROM files WHERE id = ${po.fileId}`;
    assert.equal(row.storage_path, po.storagePath);

    const [slot] = (await createAssignment(leadVideo(), {
      projectDepartmentId: await teamOf(projectId, 'video'), assigneeId: ids.ahmed, title: 'Cut', deliverableCount: 1,
    })).deliverableIds;
    const cut = await uploadTo(ahmed(), slot, 'cut.mp4');
    assert.match(cut.storagePath, new RegExp(`^files/clients/${ids.client}/2076-09/projects/${projectId}/deliverables/${slot}/v1/[0-9a-f-]{36}\\.mp4$`));
  });
});

describe('the name a file downloads as (brief §19, §43)', () => {
  test('a version carries its number; an attachment keeps its name', async () => {
    const s = await import('../src/lib/files/storage');
    assert.equal(s.downloadFilename('Video_Final.mp4', 2), 'Video_Final_v2.mp4');
    assert.equal(s.downloadFilename('Video_Final_v2.mp4', 2), 'Video_Final_v2.mp4', 'already numbered');
    assert.equal(s.downloadFilename('Video_Final-v2.mp4', 2), 'Video_Final-v2.mp4', 'either separator');
    assert.equal(s.downloadFilename('README', 3), 'README_v3', 'no extension');
    assert.equal(s.downloadFilename('brief.pdf', null), 'brief.pdf', 'an attachment has no version');
  });
});

/* ---------------------------------------------------- §7/§43 pure rule */

describe('who may pin references to an assignment (brief §7, §43)', () => {
  // A pure rule: ids here are only numbers that must agree with one another.
  const VIDEO = 2, DESIGN = 3;
  const work = { assigneeId: 11, departmentId: VIDEO };
  const person = (role: Role, over: Partial<Actor> = {}) => actor(role, { id: 99, ...over });

  test('the assignee, the lead of that department and the Project Manager may', async () => {
    const { mayAttachToAssignment } = await import('../src/lib/files/access');
    assert.equal(mayAttachToAssignment(person('executive', { id: 11, departmentIds: [VIDEO] }), work), true, 'the assignee');
    assert.equal(mayAttachToAssignment(person('team_lead', { leadDepartmentIds: [VIDEO], departmentIds: [VIDEO] }), work), true, 'the lead');
    assert.equal(mayAttachToAssignment(person('project_manager'), work), true, 'the PM plans every team');
    assert.equal(mayAttachToAssignment(person('ceo'), work), true, 'management sees every plan');
  });

  test('a colleague, another team’s lead and executive, Sales, and anyone deactivated may not', async () => {
    const { mayAttachToAssignment } = await import('../src/lib/files/access');
    assert.equal(mayAttachToAssignment(person('executive', { id: 12, departmentIds: [VIDEO] }), work), false, 'a colleague in Video');
    assert.equal(mayAttachToAssignment(person('executive', { id: 13, departmentIds: [DESIGN] }), work), false, 'a Design executive');
    assert.equal(mayAttachToAssignment(person('team_lead', { leadDepartmentIds: [DESIGN], departmentIds: [DESIGN] }), work), false, 'the Design lead');
    assert.equal(mayAttachToAssignment(person('sales'), work), false);
    assert.equal(mayAttachToAssignment(person('executive', { id: 11, departmentIds: [VIDEO], isActive: false }), work), false, 'the assignee, deactivated');
    assert.equal(mayAttachToAssignment(person('project_manager', { isActive: false }), work), false, 'a deactivated PM');
  });
});

/* ------------------------------------------------ §18 no refs while held */

describe('a held, cancelled or completed project takes no new references (brief §18, §43)', { skip }, () => {
  let projectId: number;
  let assignmentId: number;

  before(async () => {
    if (skip) return;
    ({ projectId } = await newProject('Held refs', [{ slug: 'video', lead: 'leadVideo', n: 1 }]));
    assignmentId = (await createAssignment(leadVideo(), {
      projectDepartmentId: await teamOf(projectId, 'video'), assigneeId: ids.ahmed, title: 'Cut', deliverableCount: 1,
    })).assignmentId;
  });

  const attachmentsOn = async () =>
    Number((await sql`SELECT count(*)::int AS n FROM attachments a
      LEFT JOIN assignments asg ON asg.id = a.assignment_id
      WHERE a.project_id = ${projectId} OR asg.project_id = ${projectId}`)[0].n);

  test('on hold: refused at the gate, and when an upload already in flight completes', async () => {
    assert.equal((await access.canAttachToProject(sales(), projectId)).allowed, true, 'before the hold');
    const { session, payload } = await stage(sales(), { target: 'attachment', projectId, filename: 'PO.pdf', size: 0 });

    await changeProjectStatus(pm(), { projectId, change: 'hold', reason: 'Client paused' });
    for (const [who, parent] of [[sales(), {}], [ahmed(), { assignmentId }], [pm(), {}]] as const) {
      const gate = await access.canAttachToProject(who, projectId, parent);
      assert.equal(gate.allowed, false, who.role);
      assert.match(gate.reason ?? '', /on hold/);
    }
    await assert.rejects(uploads.completeUpload(sales(), session.id), (e: unknown) =>
      e instanceof uploads.UploadError && e.status === 403 && /on hold/.test(e.message));
    assert.equal(await attachmentsOn(), 0, 'nothing was recorded');
    assert.equal(await stagedSize(session), payload.length, 'the staged bytes are kept for a retry');
    const [s] = await sql`SELECT completed_at FROM upload_sessions WHERE id = ${session.id}::uuid`;
    assert.equal(s.completed_at, null);

    await changeProjectStatus(pm(), { projectId, change: 'resume' });
    assert.equal((await access.canAttachToProject(sales(), projectId)).allowed, true, 'resumed');
    const done = await uploads.completeUpload(sales(), session.id);
    assert.equal(done.projectId, projectId, 'the same session completes once the project resumes');
    assert.equal(await attachmentsOn(), 1);
  });

  test('cancelled: final, for the PM too', async () => {
    await changeProjectStatus(pm(), { projectId, change: 'cancel', reason: 'Withdrawn' });
    for (const who of [sales(), pm(), leadVideo()]) {
      const gate = await access.canAttachToProject(who, projectId);
      assert.equal(gate.allowed, false, who.role);
      assert.match(gate.reason ?? '', /cancelled/);
    }
  });

  test('completed: the work is over', async () => {
    const done = await newProject('Done refs', [{ slug: 'video', lead: 'leadVideo', n: 1 }]);
    await sql`UPDATE projects SET status = 'completed' WHERE id = ${done.projectId}`;
    const gate = await access.canAttachToProject(sales(), done.projectId);
    assert.equal(gate.allowed, false);
    assert.match(gate.reason ?? '', /completed/);
  });
});

/* --------------------------------------- §43 a right that lapses mid-upload */

describe('an upload session outlives the right that opened it (brief §43)', { skip }, () => {
  let projectId: number;
  let cut: { assignmentId: number; slot: number };
  let grade: { assignmentId: number; slot: number };

  before(async () => {
    if (skip) return;
    ({ projectId } = await newProject('Handover', [{ slug: 'video', lead: 'leadVideo', n: 2 }]));
    const team = await teamOf(projectId, 'video');
    const a = await createAssignment(leadVideo(), { projectDepartmentId: team, assigneeId: ids.ahmed, title: 'Cut', deliverableCount: 1 });
    const b = await createAssignment(leadVideo(), { projectDepartmentId: team, assigneeId: ids.ahmed, title: 'Grade', deliverableCount: 1 });
    cut = { assignmentId: a.assignmentId, slot: a.deliverableIds[0] };
    grade = { assignmentId: b.assignmentId, slot: b.deliverableIds[0] };
  });

  const versionsOf = async (slot: number) =>
    Number((await sql`SELECT count(*)::int AS n FROM deliverable_versions WHERE deliverable_id = ${slot}`)[0].n);

  test('deliverable: the slot was handed to a colleague before the bytes were all in', async () => {
    const { session, payload } = await stage(ahmed(), { target: 'deliverable', deliverableId: cut.slot, filename: 'cut.mp4', size: 0 });
    // Ahmed keeps "Grade", so he still sees the project; only this slot is no longer his.
    await sql`UPDATE assignments SET assignee_id = ${ids.omar} WHERE id = ${cut.assignmentId}`;
    try {
      await assert.rejects(uploads.completeUpload(ahmed(), session.id), (e: unknown) =>
        e instanceof uploads.UploadError && e.status === 403 && /not assigned to you/.test(e.message));
      assert.equal(await versionsOf(cut.slot), 0, 'no version was recorded');
      assert.equal(await stagedSize(session), payload.length, 'the staged file is still there');
      assert.equal((await sql`SELECT completed_at FROM upload_sessions WHERE id = ${session.id}::uuid`)[0].completed_at, null);
    } finally {
      await sql`UPDATE assignments SET assignee_id = ${ids.ahmed} WHERE id = ${cut.assignmentId}`;
    }
    const done = await uploads.completeUpload(ahmed(), session.id);
    assert.equal(done.versionNo, 1, 'given the slot back, the same session completes without re-sending');
    assert.equal(await versionsOf(cut.slot), 1);
  });

  test('attachment pinned to an assignment that was handed over', async () => {
    const { session, payload } = await stage(ahmed(), {
      target: 'attachment', projectId, assignmentId: grade.assignmentId, filename: 'refs.pdf', size: 0,
    });
    await sql`UPDATE assignments SET assignee_id = ${ids.omar} WHERE id = ${grade.assignmentId}`;
    try {
      await assert.rejects(uploads.completeUpload(ahmed(), session.id), (e: unknown) =>
        e instanceof uploads.UploadError && e.status === 403 && /not yours to add references/.test(e.message));
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM attachments WHERE assignment_id = ${grade.assignmentId}`;
      assert.equal(Number(n), 0);
      assert.equal(await stagedSize(session), payload.length);
    } finally {
      await sql`UPDATE assignments SET assignee_id = ${ids.ahmed} WHERE id = ${grade.assignmentId}`;
    }
    const done = await uploads.completeUpload(ahmed(), session.id);
    assert.equal(done.assignmentTitle, 'Grade');
  });

  test('a shared view is read-only, and the rep who loses the project loses the upload', async () => {
    await shareProject(pm(), { projectId, userId: ids.otherSales });
    assert.deepEqual(await access.canAttachToProject(otherSales(), projectId),
      { allowed: false, reason: 'No such project.' }, 'a share lets a rep look, not add');

    const { session, payload } = await stage(sales(), { target: 'attachment', projectId, filename: 'PO.pdf', size: 0 });
    // The client and its project move to another rep while the bytes are in flight.
    await sql`UPDATE projects SET sales_owner_id = ${ids.otherSales}, created_by = ${ids.otherSales} WHERE id = ${projectId}`;
    await sql`UPDATE clients SET owner_user_id = ${ids.otherSales} WHERE id = ${ids.client}`;
    try {
      await assert.rejects(uploads.completeUpload(sales(), session.id), (e: unknown) =>
        e instanceof uploads.UploadError && e.status === 403 && /No such project/.test(e.message));
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM attachments WHERE project_id = ${projectId}`;
      assert.equal(Number(n), 0);
      assert.equal(await stagedSize(session), payload.length);
    } finally {
      await sql`UPDATE clients SET owner_user_id = ${ids.sales} WHERE id = ${ids.client}`;
      await sql`UPDATE projects SET sales_owner_id = ${ids.sales}, created_by = ${ids.sales} WHERE id = ${projectId}`;
    }
  });
});

/* ------------------------------------------------- §10/§19 version notes */

describe('a version note travels with the version (brief §10, §19)', { skip }, () => {
  let projectId: number;
  let slot: number;

  before(async () => {
    if (skip) return;
    ({ projectId } = await newProject('Noted', [{ slug: 'video', lead: 'leadVideo', n: 1 }]));
    slot = (await createAssignment(leadVideo(), {
      projectDepartmentId: await teamOf(projectId, 'video'), assigneeId: ids.ahmed, title: 'Cut', deliverableCount: 1,
    })).deliverableIds[0];
  });

  const noteOf = async (fileId: number) =>
    (await sql`SELECT notes FROM deliverable_versions WHERE file_id = ${fileId}`)[0].notes as string | null;

  test('stored on the version and shown in the workspace history', async () => {
    const v1 = await uploadTo(ahmed(), slot, 'cut.mp4', { notes: 'Tightened the intro' });
    assert.equal(await noteOf(v1.fileId), 'Tightened the intro');
    const ws = await loadWorkspace(ahmed(), projectId);
    const d = ws!.teams.flatMap((t) => t.deliverables).find((x) => x.id === slot)!;
    assert.equal(d.currentVersion?.notes, 'Tightened the intro');
    assert.equal(d.versions.find((v) => v.versionNo === v1.versionNo)?.notes, 'Tightened the intro');
  });

  test('a blank note is no note', async () => {
    const v2 = await uploadTo(ahmed(), slot, 'cut.mp4', { notes: '   ' });
    assert.equal(v2.versionNo, 2);
    assert.equal(await noteOf(v2.fileId), null);
    const v3 = await uploadTo(ahmed(), slot, 'cut.mp4');
    assert.equal(await noteOf(v3.fileId), null);
    const ws = await loadWorkspace(leadVideo(), projectId);
    const d = ws!.teams.flatMap((t) => t.deliverables).find((x) => x.id === slot)!;
    assert.deepEqual(d.versions.map((v) => [v.versionNo, v.notes]), [[3, null], [2, null], [1, 'Tightened the intro']], 'newest first');
  });
});

/* ------------------------------------------- §3/§7/§15 attachment purpose */

describe('what an attachment is for (brief §3, §7, §15)', { skip }, () => {
  test('the purpose comes from the form, defaults to “reference” and is cut at 40 characters', async () => {
    const { projectId } = await newProject('Purposes', [{ slug: 'video', lead: 'leadVideo', n: 1 }]);
    const a = await createAssignment(leadVideo(), {
      projectDepartmentId: await teamOf(projectId, 'video'), assigneeId: ids.ahmed, title: 'Cut', deliverableCount: 1,
    });
    await uploadTo(ahmed(), a.deliverableIds[0], 'cut.mp4');
    await reviewDeliverable(leadVideo(), { deliverableId: a.deliverableIds[0], decision: 'approved' });
    const rev = await createRevision(sales(), { projectId, title: 'Logo', clientFeedback: 'Bigger.', deliverableIds: [a.deliverableIds[0]] });

    await attach(sales(), projectId, 'PO-4411.pdf', { purpose: 'brief' });
    await attach(sales(), projectId, 'PO-4412.pdf', { purpose: 'po' });
    await attach(sales(), projectId, 'moodboard.png');
    await attach(sales(), projectId, 'blank.png', { purpose: '  ' });
    await attach(leadVideo(), projectId, 'storyboard.pdf', { assignmentId: a.assignmentId, purpose: 'x'.repeat(60) });
    await attach(sales(), projectId, 'markup.png', { revisionId: rev.revisionId, purpose: 'client_reference' });

    const listed = await attachmentsMod.listProjectAttachments(sales(), projectId);
    assert.deepEqual(
      Object.fromEntries(listed.map((x) => [x.originalFilename, x.purpose])),
      {
        'PO-4411.pdf': 'brief', 'PO-4412.pdf': 'po', 'moodboard.png': 'reference', 'blank.png': 'reference',
        'storyboard.pdf': 'x'.repeat(40), 'markup.png': 'client_reference',
      },
    );
    assert.deepEqual(listed.map((x) => x.parent.kind), ['project', 'project', 'project', 'project', 'assignment', 'revision']);
    const [row] = await sql`SELECT length(purpose)::int AS n FROM attachments a JOIN files f ON f.id = a.file_id
      WHERE f.original_filename = 'storyboard.pdf' AND a.assignment_id = ${a.assignmentId}`;
    assert.equal(Number(row.n), 40);
    // The Design lead is off this project, so sees none of it.
    assert.deepEqual(await attachmentsMod.listProjectAttachments(leadDesign(), projectId), []);
  });

  test('the tag beside a file: a PO, a PO or brief, the client’s reference; a plain reference has none', async () => {
    // The list is a client component (it pulls in next/navigation), so it is
    // read as the browser build reads it, without the react-server condition.
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '-e', `
      const { purposeLabel } = require('./src/components/files/attachment-list.tsx');
      console.log(JSON.stringify(['po', 'brief', 'client_reference', 'reference', 'x'.repeat(40), null].map(purposeLabel)));
    `], { cwd: ROOT, timeout: 60_000 });
    assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1)!), ['PO', 'brief', 'client reference', '', '', '']);
  });
});

/* ------------------------------ §3/§7/§15 files chosen before the record */

describe('files chosen before the record exists (brief §3, §7, §15)', () => {
  let uploadPending: typeof import('../src/components/files/pending-attachments').uploadPending;
  before(async () => {
    ({ uploadPending } = await import('../src/components/files/pending-attachments'));
  });

  /**
   * Stands in for /api/uploads: opens every session with 4-byte chunks,
   * takes every chunk, and refuses to open the files named in `refuse`.
   */
  function serve(refuse: string[]): typeof fetch {
    return async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url === '/api/uploads') {
        const { filename } = JSON.parse(String(init?.body)) as { filename: string };
        return refuse.includes(filename)
          ? Response.json({ error: 'Too big.' }, { status: 400 })
          : Response.json({ uploadId: `u-${filename}`, chunkSize: 4 });
      }
      if (method === 'PATCH') {
        const offset = Number(new Headers(init?.headers).get('Upload-Offset'));
        return new Response(null, { status: 204, headers: { 'Upload-Offset': String(offset + (init?.body as Blob).size) } });
      }
      if (method === 'POST' && url.endsWith('/complete')) return Response.json({ ok: true });
      throw new Error(`unexpected ${method} ${url}`);
    };
  }
  async function withServer<T>(refuse: string[], run: () => Promise<T>): Promise<T> {
    const real = globalThis.fetch;
    globalThis.fetch = serve(refuse);
    try { return await run(); } finally { globalThis.fetch = real; }
  }
  const file = (name: string) => new File([new Uint8Array(6)], name, { type: 'application/pdf' });
  const open = { target: 'attachment' as const, projectId: 1, purpose: 'brief' };

  test('every file goes up in turn, and the progress text is cleared at the end', async () => {
    const progress: string[] = [];
    const outcome = await withServer([], () => uploadPending([file('a.pdf'), file('b.pdf')], open, (t) => progress.push(t)));
    assert.deepEqual(outcome, { done: 2, failed: null });
    assert.deepEqual(progress, [
      'Attaching 1/2: 67%', 'Attaching 1/2: 100%', 'Attaching 1/2: checking…',
      'Attaching 2/2: 67%', 'Attaching 2/2: 100%', 'Attaching 2/2: checking…',
      '',
    ]);
  });

  test('a refused file stops the run, is named, and the progress text is cleared all the same', async () => {
    const progress: string[] = [];
    const outcome = await withServer(['b.pdf'], () =>
      uploadPending([file('a.pdf'), file('b.pdf'), file('c.pdf')], open, (t) => progress.push(t)));
    assert.deepEqual(outcome, { done: 1, failed: 'b.pdf: Too big.' });
    assert.equal(progress.at(-1), '', 'the form is never left reading “Attaching 2/3”');
    assert.ok(progress.slice(0, -1).every((t) => t.startsWith('Attaching 1/3: ')), 'c.pdf was never started');
  });

  test('nothing to send is done at once', async () => {
    const progress: string[] = [];
    assert.deepEqual(await withServer([], () => uploadPending([], open, (t) => progress.push(t))), { done: 0, failed: null });
    assert.deepEqual(progress, ['']);
  });
});

/* ------------------------------------------------ §43 the download route */

describe('GET /api/files — the only way bytes leave the server (brief §43)', { skip }, () => {
  let route: typeof import('../src/app/api/files/[storageKey]/route');
  let projectId: number;
  let slot: number;
  let video: Awaited<ReturnType<typeof uploadTo>>;
  let archive: Awaited<ReturnType<typeof attach>>;

  before(async () => {
    if (skip) return;
    // Next compiles route handlers for its server layer, where
    // `next/navigation` is the react-server build (see next's
    // build/create-compiler-aliases.js). Plain Node has no such alias, so the
    // same substitution is made here before the route loads.
    const load = createRequire(__filename);
    const serverNavigation = load.resolve('next/dist/client/components/navigation.react-server');
    load(serverNavigation);
    load.cache[load.resolve('next/navigation')] = load.cache[serverNavigation];
    route = await import('../src/app/api/files/[storageKey]/route');

    ({ projectId } = await newProject('Download', [{ slug: 'video', lead: 'leadVideo', n: 1 }]));
    slot = (await createAssignment(leadVideo(), {
      projectDepartmentId: await teamOf(projectId, 'video'), assigneeId: ids.ahmed, title: 'Cut', deliverableCount: 1,
      deliverableBaseName: 'Video',
    })).deliverableIds[0];
    video = await uploadTo(ahmed(), slot, 'Video_01.mp4', { mimeType: 'video/mp4' });
    archive = await attach(sales(), projectId, 'sources.zip', { mimeType: 'application/zip' });
  });

  /**
   * GET /api/files/:storageKey as `userId`, run the way Next runs it: inside
   * a request scope whose cookie is a real session, so the actor is resolved
   * by the data access layer exactly as in production.
   */
  async function getAs(userId: number, storageKey: string, query = ''): Promise<Response> {
    const [session] = await sql<{ id: string }[]>`
      INSERT INTO sessions (user_id, expires_at) VALUES (${userId}, now() + interval '1 hour')
      RETURNING id::text AS id`;
    const request = new NextRequest(`http://portal.test/api/files/${storageKey}${query}`, {
      method: 'GET', headers: { cookie: `aktivacity_session=${session.id}` },
    });
    const requestStore = createRequestStoreForAPI(
      request, request.nextUrl, undefined as never, undefined, undefined as never, undefined,
    );
    const workStore = createWorkStore({
      page: '/api/files/[storageKey]/route',
      renderOpts: { experimental: {}, supportsDynamicResponse: true } as never,
      buildId: 'test', deploymentId: 'test', previouslyRevalidatedTags: [],
    });
    try {
      return await workUnitAsyncStorage.run(requestStore, () =>
        workAsyncStorage.run(workStore, () =>
          route.GET(request, { params: Promise.resolve({ storageKey }) })));
    } finally {
      await sql`DELETE FROM sessions WHERE id = ${session.id}::uuid`;
    }
  }

  const logged = async (actorId: number, action: string, fileId: number) => {
    const rows = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM activity_log WHERE actor_id = ${actorId} AND action = ${action} AND entity_id = ${fileId} ORDER BY id`;
    return rows.map((r) => r.metadata);
  };

  test('a version downloads under its versioned name, with its stored type, and is logged', async () => {
    const res = await getAs(ids.ahmed, video.storageKey);
    assert.equal(res.status, 200);
    const disposition = res.headers.get('content-disposition') ?? '';
    assert.ok(disposition.startsWith('attachment;'), disposition);
    assert.ok(disposition.includes('Video_01_v1.mp4'), disposition);
    assert.equal(res.headers.get('content-type'), 'video/mp4');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.equal(Buffer.compare(Buffer.from(await res.arrayBuffer()), video.payload), 0, 'the bytes that were uploaded');
    const rows = await logged(ids.ahmed, 'file.downloaded', video.fileId);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].inline, rows[0].partial, rows[0].storageKey], [false, false, video.storageKey]);
  });

  test('?inline=1 views a video in place; an archive is still a download', async () => {
    const res = await getAs(ids.ahmed, video.storageKey, '?inline=1');
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-disposition') ?? '').startsWith('inline;'));
    assert.equal(res.headers.get('content-type'), 'video/mp4');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    await res.arrayBuffer();
    const rows = await logged(ids.ahmed, 'file.downloaded', video.fileId);
    assert.deepEqual(rows.map((m) => m.inline), [false, true]);

    const zip = await getAs(ids.sales, archive.storageKey, '?inline=1');
    assert.equal(zip.status, 200);
    const disposition = zip.headers.get('content-disposition') ?? '';
    assert.ok(disposition.startsWith('attachment;'), disposition);
    assert.ok(disposition.includes('sources.zip'), 'an attachment keeps its name, no version');
    assert.equal(zip.headers.get('content-type'), 'application/zip');
    await zip.arrayBuffer();
  });

  test('someone off the project gets 404, and the refusal is on the record', async () => {
    const res = await getAs(ids.omar, video.storageKey);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Not found.' });
    const denied = await logged(ids.omar, 'file.download_denied', video.fileId);
    assert.deepEqual(denied.map((m) => m.reason), ['out_of_scope']);
    assert.deepEqual(await logged(ids.omar, 'file.downloaded', video.fileId), []);
  });

  test('a client login reads only what was delivered to it', async () => {
    const before = await getAs(ids.clientLogin, video.storageKey);
    assert.equal(before.status, 404);
    await before.json();
    assert.deepEqual((await logged(ids.clientLogin, 'file.download_denied', video.fileId)).map((m) => m.reason), ['not_delivered_to_client']);

    const { deliveryId } = await reviewDeliverable(leadVideo(), { deliverableId: slot, decision: 'approved' });
    const [d] = await sql`SELECT delivered_at FROM deliveries WHERE id = ${deliveryId}`;
    if (!d.delivered_at) await updateDelivery(sales(), { deliveryId: deliveryId!, status: 'delivered' });

    const after = await getAs(ids.clientLogin, video.storageKey);
    assert.equal(after.status, 200);
    assert.ok((after.headers.get('content-disposition') ?? '').includes('Video_01_v1.mp4'));
    await after.arrayBuffer();
    assert.equal((await logged(ids.clientLogin, 'file.downloaded', video.fileId)).length, 1);
    // Delivered or not, the PO is internal.
    const po = await getAs(ids.clientLogin, archive.storageKey);
    assert.equal(po.status, 404);
    await po.json();
  });

  test('an unknown key is 404 and logged as such', async () => {
    const key = randomUUID();
    const res = await getAs(ids.ahmed, key);
    assert.equal(res.status, 404);
    await res.json();
    const [row] = await sql`SELECT metadata FROM activity_log WHERE actor_id = ${ids.ahmed}
      AND action = 'file.download_denied' AND metadata->>'storageKey' = ${key}`;
    assert.equal(row.metadata.reason, 'not_found');
  });
});

/* ----------------------------------------- §43 the store on a plain install */

describe('npm run setup makes the file store private (brief §43)', {
  skip: skip || (process.platform === 'win32' ? 'POSIX modes only' : !existsSync(path.join(ROOT, '.env')) && 'setup reads the repo .env'),
}, () => {
  test('a new store is 700, an existing looser one is tightened, and the runbook is pointed at', async () => {
    const store = path.join(storageRoot, 'private-store');
    await mkdir(store, { recursive: true, mode: 0o755 });
    await chmod(store, 0o755);
    assert.equal((await stat(store)).mode & 0o777, 0o755, 'starts open');

    const { stdout } = await promisify(execFile)(process.execPath, ['scripts/setup.mjs', '--no-seed'], {
      cwd: ROOT, timeout: 90_000,
      env: { ...process.env, DATABASE_URL: DATABASE_URL!, STORAGE_ROOT: store },
    });
    assert.equal((await stat(store)).mode & 0o777, 0o700);
    assert.match(stdout, /readable by this account only/);
    assert.match(stdout, /The file store without Docker/);

    const fresh = path.join(storageRoot, 'fresh-store');
    await promisify(execFile)(process.execPath, ['scripts/setup.mjs', '--no-seed'], {
      cwd: ROOT, timeout: 90_000,
      env: { ...process.env, DATABASE_URL: DATABASE_URL!, STORAGE_ROOT: fresh },
    });
    assert.equal((await stat(fresh)).mode & 0o777, 0o700, 'made from nothing, already private');
  });
});

/* ----------------------------------------------------- §37 the demo seed */

describe('the demo seed (npm run db:seed:demo, brief §37)', { skip }, () => {
  // The seed fills an empty portal and refuses one with users, so it gets a
  // database of its own, made from this suite's connection: CREATE DATABASE
  // needs a role that may (the CI role and a local superuser do); anywhere
  // else the test says so and skips.
  const name = `w3infra_seed_${randomBytes(4).toString('hex')}`;
  let url: string | null = null;

  after(async () => {
    if (!url) return;
    await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  });

  test('loads an empty database, and a month opened by hand is listed in that month’s view', async (t) => {
    try {
      await sql.unsafe(`CREATE DATABASE "${name}"`);
    } catch (error) {
      if ((error as { code?: string }).code === '42501') return t.skip('this role may not CREATE DATABASE');
      throw error;
    }
    const scratch = new URL(DATABASE_URL!);
    scratch.pathname = `/${name}`;
    url = scratch.href;
    const store = path.join(storageRoot, 'demo-store');
    const run = (args: string[], timeout: number) => promisify(execFile)(process.execPath, args, {
      cwd: ROOT, timeout, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, DATABASE_URL: url!, STORAGE_ROOT: store },
    });
    await run(['--import', 'tsx', 'scripts/migrate.ts'], 90_000);
    const { stdout } = await run(['--conditions=react-server', '--import', 'tsx', 'scripts/seed-demo.ts'], 300_000);
    assert.match(stdout, /Demo data loaded in \d+ s/);

    // "Open next month" on the client page hangs its "opened" line off the
    // month row (entity_type client_month, entity_id the month), which is
    // where the month view looks for the month's own lines. The seed's step
    // must write the same shape, or the demo's hand-opened month shows
    // "closed" and "copied" lines but never "opened".
    const { formatMonth } = await import('../src/lib/projects/intake');
    const demo = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const opened = await demo<{
        client: string; actor: string | null; entity_type: string; entity_id: number; month_id: number | null;
        metadata: Record<string, unknown>;
      }[]>`
        SELECT c.name AS client, u.full_name AS actor, al.entity_type, al.entity_id, al.metadata,
               (SELECT cm.id FROM client_months cm
                 WHERE cm.client_id = al.client_id
                   AND cm.period_year = (al.metadata->>'year')::int
                   AND cm.period_month = (al.metadata->>'month')::int) AS month_id
        FROM activity_log al
        JOIN clients c ON c.id = al.client_id
        LEFT JOIN users u ON u.id = al.actor_id
        WHERE al.action = 'client.month_opened'
        ORDER BY al.id`;
      assert.ok(opened.length >= 1, 'the story opens at least one month by hand (the retainer, for next month)');
      for (const row of opened) {
        assert.equal(row.entity_type, 'client_month', row.client);
        assert.ok(row.month_id !== null, `${row.client}: the month it names exists`);
        assert.equal(Number(row.entity_id), Number(row.month_id), `${row.client}: the line hangs off its month`);
        assert.equal(
          describeActivity({ action: 'client.month_opened', actorName: row.actor, metadata: row.metadata }),
          `${row.actor} opened ${formatMonth(Number(row.metadata.year), Number(row.metadata.month))}`,
        );
      }
    } finally {
      await demo.end();
    }
  });
});

/* ---------------------------------------------- §20/§28 nightly reminders */

describe('the nightly reminders (brief §20, §28)', { skip }, () => {
  let projectId: number;
  let assignmentId: number;
  const run = (userIds: number[]) => reminders.sendDeadlineReminders({ userIds });

  async function rows(userId: number, type: string, entityType: string, entityId: number) {
    const found = await sql<{ title: string; body: string | null; link_path: string | null }[]>`
      SELECT title, body, link_path FROM notifications
      WHERE user_id = ${userId} AND type = ${type} AND entity_type = ${entityType} AND entity_id = ${entityId} ORDER BY id`;
    return found.map((r) => ({ title: r.title, body: r.body, linkPath: r.link_path }));
  }
  // Only this suite's task and project: other suites' deadlines reach the same
  // leads and PMs in the shared database.
  const anyReminder = async (userId: number) => Number((await sql`
    SELECT count(*)::int AS n FROM notifications
    WHERE user_id = ${userId} AND (type LIKE 'deadline.%' OR type = 'project.delayed')
      AND ((entity_type = 'assignment' AND entity_id = ${assignmentId})
        OR (entity_type = 'project' AND entity_id = ${projectId}))`)[0].n);

  before(async () => {
    if (skip) return;
    const p = await newProject('Reminder', [{ slug: 'video', lead: 'leadVideo', n: 1 }]);
    projectId = p.projectId;
    codes.reminder = p.code;
    await sql`UPDATE projects SET deadline = current_date - 1 WHERE id = ${projectId}`;
    const [row] = await sql`SELECT project_manager_id FROM projects WHERE id = ${projectId}`;
    assert.equal(Number(row.project_manager_id), ids.pm, 'routing it made our PM its manager');
    assignmentId = (await createAssignment(leadVideo(), {
      projectDepartmentId: await teamOf(projectId, 'video'), assigneeId: ids.ahmed, title: 'Cut the reel',
      deliverableCount: 1, endDate: await day(2),
    })).assignmentId;
  });

  test('the first run writes to the people on the work, once each, and to nobody else', async () => {
    await run([ids.ahmed, ids.omar, ids.leadVideo, ids.leadDesign, ids.pm, ids.pm2, ids.ceo, ids.sales]);
    const approaching = {
      title: 'Deadline approaching: Cut the reel',
      body: `${codes.reminder} · due in 2 days (${await day(2)}).`,
      linkPath: `/projects/${projectId}#workspace`,
    };
    assert.deepEqual(await rows(ids.ahmed, 'deadline.approaching', 'assignment', assignmentId), [approaching], 'the Executive');
    assert.deepEqual(await rows(ids.leadVideo, 'deadline.approaching', 'assignment', assignmentId), [approaching], 'the lead');
    assert.equal(await anyReminder(ids.omar), 0, 'a colleague is not on it');
    assert.equal(await anyReminder(ids.leadDesign), 0, 'another team');

    const delayed = {
      title: 'Overdue: Reminder',
      body: `${codes.reminder} · 1 day overdue (${await day(-1)}).`,
      linkPath: `/projects/${projectId}`,
    };
    assert.deepEqual(await rows(ids.pm, 'project.delayed', 'project', projectId), [delayed], 'the PM who manages it');
    assert.deepEqual(await rows(ids.sales, 'project.delayed', 'project', projectId), [delayed], 'the rep who owns it');
    assert.deepEqual(await rows(ids.leadVideo, 'project.delayed', 'project', projectId), [delayed], 'the team on it');
    assert.equal(await anyReminder(ids.pm2), 0, 'a PM who does not manage it');
    assert.equal(await anyReminder(ids.ceo), 0, 'management has the dashboard');
    assert.deepEqual(await rows(ids.ahmed, 'project.delayed', 'project', projectId), [], 'an Executive is reminded of the task, not the project');

    // What was stored is what the inbox lists, item for item.
    const listed = (await inboxMod.upcomingDeadlines(pm(), 3)).find((d) => d.kind === 'project' && d.id === projectId);
    assert.equal(listed?.linkPath, delayed.linkPath);
    const task = (await inboxMod.upcomingDeadlines(ahmed(), 3)).find((d) => d.kind === 'assignment' && d.id === assignmentId);
    assert.equal(task?.linkPath, approaching.linkPath);
  });

  test('a second run the same night sends nothing', async () => {
    assert.deepEqual(await run([ids.ahmed]), { usersChecked: 1, sent: 0 });
    await run([ids.leadVideo, ids.pm, ids.sales]);
    assert.equal((await rows(ids.leadVideo, 'deadline.approaching', 'assignment', assignmentId)).length, 1);
    assert.equal((await rows(ids.pm, 'project.delayed', 'project', projectId)).length, 1);
    assert.equal((await rows(ids.sales, 'project.delayed', 'project', projectId)).length, 1);
  });

  test('an overdue project is chased again after a week, not nightly', async () => {
    await sql`UPDATE notifications SET created_at = now() - interval '8 days'
      WHERE user_id = ${ids.pm} AND type = 'project.delayed' AND entity_type = 'project' AND entity_id = ${projectId}`;
    await run([ids.pm, ids.sales]);
    assert.equal((await rows(ids.pm, 'project.delayed', 'project', projectId)).length, 2, 'a week on, once more');
    assert.equal((await rows(ids.sales, 'project.delayed', 'project', projectId)).length, 1, 'the rep’s is recent');
  });

  test('due today is its own line, once', async () => {
    await sql`UPDATE assignments SET end_date = current_date WHERE id = ${assignmentId}`;
    await run([ids.ahmed]);
    await run([ids.ahmed]);
    assert.deepEqual((await rows(ids.ahmed, 'deadline.today', 'assignment', assignmentId)).map((r) => r.title), ['Due today: Cut the reel']);
    assert.equal((await rows(ids.ahmed, 'deadline.approaching', 'assignment', assignmentId)).length, 1, 'never a second “approaching”');
  });

  test('the userIds option limits the run, and management is never among those checked', async () => {
    assert.deepEqual(await run([ids.omar]), { usersChecked: 1, sent: 0 });
    assert.deepEqual(await run([ids.ceo]), { usersChecked: 0, sent: 0 });
    assert.equal(await anyReminder(ids.ceo), 0);
  });
});

/* ------------------------------------------------ §36 the month archive */

describe('the month archive (brief §36, run nightly)', { skip }, () => {
  let month: number;
  let empty: number;
  let done: number;
  let moving: number;

  before(async () => {
    if (skip) return;
    // A month long gone, made by hand so its date is not this year's (the
    // table accepts nothing before 2020; no other suite files into 2021).
    const mk = async (m: number) => Number((await sql<{ id: number }[]>`
      INSERT INTO client_months (client_id, period_year, period_month, created_by)
      VALUES (${ids.client}, 2021, ${m}, ${ids.sales}) RETURNING id`)[0].id);
    month = await mk(3);
    empty = await mk(4);
    const project = async (code: string, status: string) => Number((await sql<{ id: number }[]>`
      INSERT INTO projects (project_code, client_id, client_month_id, title, status, sales_owner_id, created_by)
      VALUES (${code}, ${ids.client}, ${month}, ${code}, ${status}::project_status, ${ids.sales}, ${ids.sales}) RETURNING id`)[0].id);
    done = await project('W3INFRA-2021-0001', 'completed');
    moving = await project('W3INFRA-2021-0002', 'in_progress');
  });

  // Held to this suite's client, so w3-clients' months and these never reach each other.
  const own = () => ({ clientIds: [ids.client] });
  const listedAt = async (asOf?: Date) =>
    (await lifecycle.settledMonths(asOf, own())).find((m) => m.clientMonthId === month) ?? null;
  const archive = () => lifecycle.closeSettledMonths(undefined, own());
  const status = async (id: number) => {
    const [r] = await sql`SELECT status, closed_by, closed_at FROM client_months WHERE id = ${id}`;
    return { status: r.status as string, closedBy: r.closed_by as number | null, closedAt: r.closed_at as Date | null };
  };

  test('listed only once every project is settled and the period is a week gone; an empty month never', async () => {
    assert.equal(await listedAt(), null, 'a project is still in progress');
    await sql`UPDATE projects SET status = 'cancelled' WHERE id = ${moving}`;
    assert.equal(await listedAt(new Date('2021-04-07T12:00:00Z')), null, 'six days after March ended: not yet');
    assert.deepEqual(await listedAt(new Date('2021-04-08T12:00:00Z')), {
      clientMonthId: month, clientId: ids.client, clientName: `${CLIENT_PREFIX}Client`, year: 2021, month: 3, projectCount: 2,
    });
    assert.ok(await listedAt(), 'and so today');
    const all = await lifecycle.settledMonths(undefined, own());
    assert.equal(all.some((m) => m.clientMonthId === empty), false, 'nothing to archive in an empty month');
    assert.deepEqual(await lifecycle.settledMonths(undefined, { clientIds: [] }), [], 'held to no client: nothing at all');
  });

  test('a project back in progress before the run keeps its month open', async () => {
    await sql`UPDATE projects SET status = 'in_progress' WHERE id = ${moving}`;
    const { closed } = await archive();
    assert.equal(closed.some((m) => m.clientMonthId === month), false);
    assert.equal((await status(month)).status, 'open');
    await sql`UPDATE projects SET status = 'cancelled' WHERE id = ${moving}`;
  });

  test('the run closes it with no closer, and the record says it was automatic', async () => {
    const { closed } = await archive();
    assert.deepEqual(closed.filter((m) => m.clientMonthId === month).map((m) => [m.year, m.month, m.projectCount]), [[2021, 3, 2]]);
    const row = await status(month);
    assert.equal(row.status, 'closed');
    assert.equal(row.closedBy, null, 'nobody closed it');
    assert.ok(row.closedAt);
    assert.equal((await status(empty)).status, 'open');

    const [log] = await sql<{ actor_id: number | null; entity_type: string; client_id: number; metadata: Record<string, unknown> }[]>`
      SELECT actor_id, entity_type, client_id, metadata FROM activity_log
      WHERE action = 'client.month_closed' AND entity_id = ${month}`;
    assert.ok(log, 'an activity row');
    assert.deepEqual([log.actor_id, log.entity_type, Number(log.client_id)], [null, 'client_month', ids.client]);
    assert.deepEqual(log.metadata, { year: 2021, month: 3, projectCount: 2, automatic: true });
    assert.equal(describeActivity({ action: 'client.month_closed', actorName: null, metadata: log.metadata }),
      'March 2021 was archived automatically');
    assert.equal(describeActivity({ action: 'client.month_closed', actorName: 'pm', metadata: { year: 2021, month: 3 } }),
      'pm closed March 2021', 'a closing by hand still names who');

    // Closed means read-only, through every door (§36).
    await assert.rejects(lifecycle.assertMonthOpen(getDb(), { clientMonthId: month }), /closed/);
    await assert.rejects(lifecycle.assertMonthOpen(getDb(), { projectId: done }), /read-only/);
  });

  test('a second run closes nothing', async () => {
    const { closed } = await archive();
    assert.equal(closed.some((m) => m.clientMonthId === month), false);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM activity_log WHERE action = 'client.month_closed' AND entity_id = ${month}`;
    assert.equal(Number(n), 1, 'and writes no second line');
  });
});
