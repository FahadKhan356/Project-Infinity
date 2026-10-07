/**
 * Roles, ownership and the project ID (brief §2–§5, §23, §24).
 *
 * Sales files the PO with the project and the Project Manager reads it as
 * the PO, not a stray reference; every file resolves to its project's ID
 * and downloads under it; a Sales rep the project is shared with reads it
 * through every concrete path — the workspace, the files, the client's
 * month history, the deadlines — and through none of the write paths, and
 * the flags the project and client pages gate their controls on say so;
 * giving and taking back that access is on the project's timeline; and
 * when someone files for a client, the rep who owns the client is told who
 * did — unless they have left Sales.
 *
 * Needs DATABASE_URL pointing at a migrated database. Everything is filed in
 * 2071-09 under "W3 roles" clients by people at @w3roles.local, and only
 * those rows are purged.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
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
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run the roles tests';

let sql: ReturnType<typeof postgres>;
let storageRoot: string;

let access: typeof import('../src/lib/files/access');
let attachments: typeof import('../src/lib/files/attachments');
let storage: typeof import('../src/lib/files/storage');
let uploads: typeof import('../src/lib/files/uploads');
let viewers: typeof import('../src/lib/projects/viewers');
let scope: typeof import('../src/lib/authz/scope');
let fileProject: typeof import('../src/lib/projects/file-project').fileProject;
let parseProjectForm: typeof import('../src/lib/projects/file-project').parseProjectForm;
let triageProject: typeof import('../src/lib/projects/triage').triageProject;
let createAssignment: typeof import('../src/lib/planning/assign').createAssignment;
let loadWorkspace: typeof import('../src/lib/workspace/workspace').loadWorkspace;
let monthSummaries: typeof import('../src/lib/months/queries').monthSummaries;
let upcomingDeadlines: typeof import('../src/lib/notifications/inbox').upcomingDeadlines;
let projectActivity: typeof import('../src/lib/activity/feed').projectActivity;
let route: typeof import('../src/app/api/files/[storageKey]/route');
let db: ReturnType<typeof import('../src/db').getDb>;
let q: typeof import('drizzle-orm').sql;

const ids: Record<string, number> = {};
const keys: Record<string, string> = {};
let code = '';

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0, email: `${role}@w3roles.local`, fullName: role, role,
    isActive: true, mustChangePassword: false,
    leadDepartmentIds: [], departmentIds: [], permissions: new Set<Permission>(), ...over,
  };
}
const ceo = () => actor('ceo', { id: ids.ceo, fullName: 'Chris CEO' });
const pm = () => actor('project_manager', { id: ids.pm, fullName: 'Pat PM' });
/** Owns the client. */
const rep = () => actor('sales', { id: ids.rep, fullName: 'Rania Rep' });
/** A colleague in Sales with no client of their own here. */
const rep2 = () => actor('sales', { id: ids.rep2, fullName: 'Sam Rep' });
const leadVideo = () => actor('team_lead', {
  id: ids.leadVideo, fullName: 'Lina Lead', leadDepartmentIds: [ids.video], departmentIds: [ids.video],
});
const ahmed = () => actor('executive', { id: ids.ahmed, fullName: 'Ahmed', departmentIds: [ids.video] });

const bytes = () => randomBytes(48);
const stream = (b: Buffer) =>
  new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(b)); c.close(); } });

type SessionInput = Omit<import('../src/lib/files/uploads').CreateSessionInput, 'size'>;
async function upload(who: Actor, input: SessionInput) {
  const b = bytes();
  const { session } = await uploads.createUploadSession(who, { ...input, size: b.length });
  await uploads.appendChunk(who, session.id, 0, stream(b));
  return uploads.completeUpload(who, session.id);
}

/** Today plus `offset` days, as the database sees it. */
async function day(offset: number): Promise<string> {
  const [row] = await sql<{ d: string }[]>`SELECT to_char(current_date + ${offset}::int, 'YYYY-MM-DD') AS d`;
  return row.d;
}

/** What one person was told about one project, oldest first. */
async function told(userId: number, projectId: number, type?: string) {
  const rows = await sql<{ type: string; title: string; body: string | null }[]>`
    SELECT type, title, body FROM notifications
    WHERE user_id = ${userId} AND entity_type = 'project' AND entity_id = ${projectId}
    ${type ? sql`AND type = ${type}` : sql``} ORDER BY id`;
  return rows.map((r) => ({ type: r.type, title: r.title, body: r.body }));
}

/**
 * The two flags the project page gates its controls on (app/projects/[id]):
 * theirs to work on, and theirs to read. A share sets the second alone.
 */
async function projectFlags(who: Actor, projectId: number) {
  const [row] = await db.execute<{ owned: boolean; readable: boolean }>(q`
    SELECT (${scope.projectScope(who, 'p')}) AS owned,
           (${scope.projectScope(who, 'p', { shared: true })}) AS readable
    FROM projects p WHERE p.id = ${projectId}`);
  return { owned: row.owned === true, readable: row.readable === true };
}
/** The same pair on the client page (app/clients/[id]). */
async function clientFlags(who: Actor, clientId: number) {
  const [row] = await db.execute<{ owned: boolean; readable: boolean }>(q`
    SELECT (${scope.clientScope(who, 'c')}) AS owned,
           (${scope.clientScope(who, 'c', { shared: true })}) AS readable
    FROM clients c WHERE c.id = ${clientId}`);
  return { owned: row.owned === true, readable: row.readable === true };
}

/**
 * DELETE /api/files/:storageKey as `userId`, run the way Next runs it: inside
 * a request scope whose cookie is a real session, so the actor — and the
 * per-user grants — are resolved by the data access layer exactly as in
 * production. The scope is built with Next's own store factories.
 */
async function deleteAs(userId: number, storageKey: string): Promise<Response> {
  const [session] = await sql<{ id: string }[]>`
    INSERT INTO sessions (user_id, expires_at) VALUES (${userId}, now() + interval '1 hour')
    RETURNING id::text AS id`;
  const request = new NextRequest(`http://portal.test/api/files/${storageKey}`, {
    method: 'DELETE',
    headers: { cookie: `aktivacity_session=${session.id}` },
  });
  const requestStore = createRequestStoreForAPI(
    request, request.nextUrl, undefined as never, undefined, undefined as never, undefined,
  );
  const workStore = createWorkStore({
    page: '/api/files/[storageKey]/route',
    renderOpts: { experimental: {}, supportsDynamicResponse: true } as never,
    buildId: 'test',
    deploymentId: 'test',
    previouslyRevalidatedTags: [],
  });
  try {
    return await workUnitAsyncStorage.run(requestStore, () =>
      workAsyncStorage.run(workStore, () =>
        route.DELETE(request, { params: Promise.resolve({ storageKey }) })));
  } finally {
    await sql`DELETE FROM sessions WHERE id = ${session.id}::uuid`;
  }
}

/** The row the sharing action writes (app/projects/actions.ts changeSharing), so the feed can be read back. */
async function logShare(
  action: 'project.shared' | 'project.unshared',
  actorId: number, projectId: number, user: { id: number; name: string },
) {
  await sql`INSERT INTO activity_log (actor_id, action, entity_type, entity_id, project_id, metadata)
    VALUES (${actorId}, ${action}, 'project', ${projectId}, ${projectId},
            ${sql.json({ userId: user.id, userName: user.name })})`;
}

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE '%@w3roles.local'`;
  const clients = sql`SELECT id FROM clients WHERE name LIKE 'W3 roles %'`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM notifications WHERE user_id IN (${users})`;
  await sql`DELETE FROM upload_sessions WHERE created_by IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (${clients})`;
  await sql`DELETE FROM clients WHERE name LIKE 'W3 roles %'`;
  await sql`DELETE FROM files WHERE uploaded_by IN (${users})`;
  await sql`DELETE FROM department_members WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE '%@w3roles.local'`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2071`;
}

before(async () => {
  if (skip) return;
  storageRoot = await mkdtemp(path.join(tmpdir(), 'aktivacity-w3-roles-'));
  process.env.STORAGE_ROOT = storageRoot;
  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });

  access = await import('../src/lib/files/access');
  attachments = await import('../src/lib/files/attachments');
  storage = await import('../src/lib/files/storage');
  uploads = await import('../src/lib/files/uploads');
  viewers = await import('../src/lib/projects/viewers');
  scope = await import('../src/lib/authz/scope');
  ({ fileProject, parseProjectForm } = await import('../src/lib/projects/file-project'));
  ({ triageProject } = await import('../src/lib/projects/triage'));
  ({ createAssignment } = await import('../src/lib/planning/assign'));
  ({ loadWorkspace } = await import('../src/lib/workspace/workspace'));
  ({ monthSummaries } = await import('../src/lib/months/queries'));
  ({ upcomingDeadlines } = await import('../src/lib/notifications/inbox'));
  ({ projectActivity } = await import('../src/lib/activity/feed'));
  db = (await import('../src/db')).getDb();
  ({ sql: q } = await import('drizzle-orm'));
  // Next compiles route handlers for its server layer, where
  // `next/navigation` is the react-server build (see next's
  // build/create-compiler-aliases.js). Plain Node has no such alias, so the
  // same substitution is made here before the route loads.
  const load = createRequire(__filename);
  const serverNavigation = load.resolve('next/dist/client/components/navigation.react-server');
  load(serverNavigation);
  load.cache[load.resolve('next/navigation')] = load.cache[serverNavigation];
  route = await import('../src/app/api/files/[storageKey]/route');
  await purge();

  ids.video = Number((await sql`SELECT id FROM departments WHERE slug = 'video'`)[0].id);
  const mkUser = async (key: string, role: string, name: string) => {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES (${`${key}@w3roles.local`}, 'x', ${name}, ${role}) RETURNING id`;
    ids[key] = Number(row.id);
  };
  await mkUser('ceo', 'ceo', 'Chris CEO');
  await mkUser('pm', 'project_manager', 'Pat PM');
  await mkUser('rep', 'sales', 'Rania Rep');
  await mkUser('rep2', 'sales', 'Sam Rep');
  await mkUser('leadVideo', 'team_lead', 'Lina Lead');
  await mkUser('ahmed', 'executive', 'Ahmed');
  await sql`INSERT INTO department_members (user_id, department_id, is_lead) VALUES (${ids.leadVideo}, ${ids.video}, true)`;
  await sql`INSERT INTO department_members (user_id, department_id, is_lead) VALUES (${ids.ahmed}, ${ids.video}, false)`;

  const [client] = await sql<{ id: number }[]>`
    INSERT INTO clients (name, owner_user_id, created_by)
    VALUES ('W3 roles Client', ${ids.rep}, ${ids.rep}) RETURNING id`;
  ids.client = Number(client.id);
});

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('Sales files the PO with the project; the PM reads it as the PO (brief §3, §5)', { skip }, () => {
  test('the intake form parses to the domain input; the flag to stay for the files is not part of the record', async () => {
    const form = new FormData();
    form.append('clientId', String(ids.client));
    form.append('period', '2071-09');
    form.append('title', 'Brand film');
    form.append('objective', 'Launch the autumn range');
    form.append('poReference', 'PO-2071-44');
    form.append('department', String(ids.video));
    form.append(`planned_${ids.video}`, '1');
    form.append('deadline', await day(1));
    form.append('priceAmount', '2500');
    form.append('requiresPmQa', 'on');
    // The form sets this to hold the page open while the PO uploads (§3);
    // the action reads it, the record never sees it.
    form.append('stayAfterCreate', '1');
    const input = parseProjectForm(form);
    assert.equal(input.clientId, ids.client);
    assert.equal(input.poReference, 'PO-2071-44');
    assert.equal(input.priceAmount, '2500.00');
    assert.deepEqual(input.departments, [{ departmentId: ids.video, plannedDeliverables: 1 }]);
    assert.ok(!('stayAfterCreate' in input), 'the form-only flag never reaches the record');

    const filed = await fileProject(rep(), input);
    ids.project = filed.projectId;
    code = filed.projectCode;
    assert.match(code, /^AKT-2071-\d{4}$/, 'the ID the brief asks for (§24)');
    const [row] = await sql<{ status: string; sales_owner_id: string; po_reference: string; price_amount: string }[]>`
      SELECT status, sales_owner_id, po_reference, price_amount FROM projects WHERE id = ${ids.project}`;
    assert.deepEqual(
      [row.status, Number(row.sales_owner_id), row.po_reference, row.price_amount],
      ['new', ids.rep, 'PO-2071-44', '2500.00'],
    );
  });

  test('the PO the form sends after filing lands on the project as its brief, for the filer and the PM alike', async () => {
    const done = await upload(rep(), {
      target: 'attachment', projectId: ids.project, purpose: 'brief',
      filename: 'PO-2071-44.pdf', mimeType: 'application/pdf',
    });
    assert.equal(done.projectId, ids.project);
    assert.equal(done.versionNo, null, 'an attachment is not a version');
    assert.equal(done.assignmentTitle, null);
    keys.po = done.storageKey;

    const shape = (a: import('../src/lib/files/attachments').ProjectAttachment) =>
      ({ name: a.originalFilename, purpose: a.purpose, parent: a.parent.kind, by: a.uploadedBy });
    const forRep = (await attachments.listProjectAttachments(rep(), ids.project)).map(shape);
    assert.deepEqual(forRep, [{ name: 'PO-2071-44.pdf', purpose: 'brief', parent: 'project', by: 'Rania Rep' }]);
    assert.deepEqual((await attachments.listProjectAttachments(pm(), ids.project)).map(shape), forRep,
      'the PM who did not file it reads the same PO');
    assert.deepEqual(await attachments.listProjectAttachments(rep2(), ids.project), [],
      'a colleague with no share sees nothing');
  });

  test('a reference attached later is a plain reference, told apart from the PO', async () => {
    const done = await upload(rep(), { target: 'attachment', projectId: ids.project, filename: 'brand-guide.pdf' });
    keys.ref = done.storageKey;
    const purposes = (await attachments.listProjectAttachments(pm(), ids.project))
      .map((a) => [a.originalFilename, a.purpose]);
    assert.deepEqual(purposes, [['PO-2071-44.pdf', 'brief'], ['brand-guide.pdf', 'reference']]);
  });
});

describe('the project ID follows the files (brief §24)', { skip }, () => {
  before(async () => {
    if (skip) return;
    await triageProject(pm(), {
      projectId: ids.project,
      teams: [{ departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 }],
    });
    const [team] = await sql<{ id: number }[]>`SELECT id FROM project_departments WHERE project_id = ${ids.project}`;
    const cut = await createAssignment(leadVideo(), {
      projectDepartmentId: Number(team.id), assigneeId: ids.ahmed, title: 'Cut', deliverableCount: 1,
    });
    ids.slot = cut.deliverableIds[0];
    keys.v1 = (await upload(ahmed(), { target: 'deliverable', deliverableId: ids.slot, filename: 'Video_Final.mp4' })).storageKey;
    keys.v2 = (await upload(ahmed(), { target: 'deliverable', deliverableId: ids.slot, filename: 'Video_Final.mp4' })).storageKey;
  });

  test('an attachment resolves to its project and its code, and downloads with the code in front', async () => {
    const ctx = await access.loadFileContext(keys.po);
    assert.ok(ctx);
    assert.deepEqual([ctx.projectId, ctx.projectCode, ctx.versionNo, ctx.deliverableId], [ids.project, code, null, null]);
    assert.equal(storage.downloadFilename(ctx.originalFilename, ctx.versionNo, ctx.projectCode), `${code}_PO-2071-44.pdf`);
  });

  test('a version resolves the same way and downloads as code, name and version number', async () => {
    const v1 = await access.loadFileContext(keys.v1);
    const v2 = await access.loadFileContext(keys.v2);
    assert.ok(v1 && v2);
    assert.deepEqual([v1.projectId, v1.projectCode, v1.versionNo, v1.deliverableId], [ids.project, code, 1, ids.slot]);
    assert.deepEqual([v2.projectId, v2.projectCode, v2.versionNo, v2.deliverableId], [ids.project, code, 2, ids.slot]);
    assert.equal(storage.downloadFilename(v1.originalFilename, v1.versionNo, v1.projectCode), `${code}_Video_Final_v1.mp4`);
    assert.equal(storage.downloadFilename(v2.originalFilename, v2.versionNo, v2.projectCode), `${code}_Video_Final_v2.mp4`);
  });

  test('a file that belongs to no project has no code, and only an administrator may read it', async () => {
    const [orphan] = await sql<{ key: string }[]>`
      INSERT INTO files (storage_path, original_filename, size_bytes, uploaded_by)
      VALUES ('files/w3-roles-orphan', 'stray.bin', 1, ${ids.rep}) RETURNING storage_key::text AS key`;
    const ctx = await access.loadFileContext(orphan.key);
    assert.ok(ctx);
    assert.deepEqual([ctx.projectId, ctx.projectCode, ctx.versionNo], [null, null, null]);
    assert.deepEqual(await access.decideFileAccess(rep(), ctx), { allowed: false, reason: 'orphaned' });
    assert.deepEqual(await access.decideFileAccess(ceo(), ctx), { allowed: true });
  });
});

describe('a rep the project is shared with reads it through every path, and changes nothing (brief §23)', { skip }, () => {
  const mine = async (who: Actor) => (await upcomingDeadlines(who, 3))
    .filter((d) => d.projectCode === code)
    .map((d) => [d.kind, d.title, d.daysLeft, d.linkPath]);

  test('before the share, nothing of it reaches the colleague', async () => {
    assert.deepEqual(await projectFlags(rep2(), ids.project), { owned: false, readable: false });
    assert.equal(await loadWorkspace(rep2(), ids.project), null);
    assert.deepEqual(await attachments.listProjectAttachments(rep2(), ids.project), []);
    const po = await access.loadFileContext(keys.po);
    assert.ok(po);
    assert.deepEqual(await access.decideFileAccess(rep2(), po), { allowed: false, reason: 'out_of_scope' });
    assert.deepEqual(
      (await monthSummaries(rep2(), ids.client)).map((m) => [m.year, m.month, m.projects, m.deliverables]),
      [[2071, 9, 0, 0]],
      'the month exists; nothing in it is theirs to count',
    );
    assert.deepEqual(await mine(rep2()), []);
    assert.deepEqual(await clientFlags(rep2(), ids.client), { owned: false, readable: false });
  });

  test('the owner and the PM have it as their own, and the owner is chased for its deadline', async () => {
    assert.deepEqual(await projectFlags(rep(), ids.project), { owned: true, readable: true });
    assert.deepEqual(await projectFlags(pm(), ids.project), { owned: true, readable: true });
    assert.deepEqual(await clientFlags(rep(), ids.client), { owned: true, readable: true });
    assert.deepEqual(await mine(rep()), [['project', 'Brand film', 1, `/projects/${ids.project}`]]);
  });

  test('once the PM shares it, every read path opens', async () => {
    const shared = await viewers.shareProject(pm(), { projectId: ids.project, userId: ids.rep2 });
    assert.equal(shared.changed, true);
    await logShare('project.shared', ids.pm, ids.project, { id: ids.rep2, name: 'Sam Rep' });

    assert.deepEqual(await projectFlags(rep2(), ids.project), { owned: false, readable: true }, 'to read, not to work');

    const ws = await loadWorkspace(rep2(), ids.project);
    assert.ok(ws, 'the workspace opens');
    assert.equal(ws.projectId, ids.project);
    assert.deepEqual(ws.teams.map((t) => [t.department, t.teamLead, t.deliverables.length]), [['Video', 'Lina Lead', 1]]);
    assert.deepEqual(ws.teams[0].assignments.map((a) => [a.title, a.assignee, a.uploaded, a.total]), [['Cut', 'Ahmed', 1, 1]]);
    assert.equal(ws.teams[0].deliverables[0].canUpload, false, 'reading is not uploading');
    assert.deepEqual(ws.teams[0].deliverables[0].versions.map((v) => v.versionNo), [2, 1], 'every version, newest first');

    assert.deepEqual(
      (await attachments.listProjectAttachments(rep2(), ids.project)).map((a) => [a.originalFilename, a.purpose]),
      [['PO-2071-44.pdf', 'brief'], ['brand-guide.pdf', 'reference']],
    );
    for (const key of [keys.po, keys.ref, keys.v1, keys.v2]) {
      const ctx = await access.loadFileContext(key);
      assert.ok(ctx);
      assert.deepEqual(await access.decideFileAccess(rep2(), ctx), { allowed: true }, ctx.originalFilename);
    }
    assert.deepEqual(
      (await monthSummaries(rep2(), ids.client)).map((m) => [m.projects, m.deliverables, m.inQa]),
      [[1, 1, 1]],
      'the shared project counts in the client history they read',
    );
    assert.deepEqual(await mine(rep2()), [['project', 'Brand film', 1, `/projects/${ids.project}`]]);
  });

  test('and no write path does: what the page hides, the server refuses', async () => {
    assert.deepEqual(await access.canAttachToProject(rep2(), ids.project), { allowed: false, reason: 'No such project.' });
    const { addComment } = await import('../src/lib/workspace/comments');
    await assert.rejects(addComment(rep2(), { projectId: ids.project, body: 'Hello' }), /No such project/);
    const { changeProjectStatus } = await import('../src/lib/projects/status');
    await assert.rejects(changeProjectStatus(rep2(), { projectId: ids.project, change: 'hold' }), /No such project/);
    const { editProjectDetails } = await import('../src/lib/projects/edit');
    await assert.rejects(editProjectDetails(rep2(), {
      projectId: ids.project,
      details: {
        title: 'Renamed', projectType: null, objective: null, description: null, poReference: null,
        requirements: null, clientNotes: null, priceAmount: '1', recursMonthly: false, otherInfo: null,
      },
    }), /No such project/);
    const { createRevision } = await import('../src/lib/revisions/revisions');
    await assert.rejects(createRevision(rep2(), {
      projectId: ids.project, title: 'Recut', clientFeedback: 'Shorter', deliverableIds: [ids.slot],
    }), /No such project/);

    // An attachment session opened anyway is refused where it would land.
    const b = bytes();
    const { session } = await uploads.createUploadSession(rep2(), {
      target: 'attachment', projectId: ids.project, filename: 'sneak.pdf', size: b.length,
    });
    await uploads.appendChunk(rep2(), session.id, 0, stream(b));
    await assert.rejects(uploads.completeUpload(rep2(), session.id), /No such project/);
    assert.deepEqual(
      (await attachments.listProjectAttachments(pm(), ids.project)).map((a) => a.originalFilename),
      ['PO-2071-44.pdf', 'brand-guide.pdf'],
    );

    const [row] = await sql<{ title: string; status: string }[]>`SELECT title, status FROM projects WHERE id = ${ids.project}`;
    assert.deepEqual([row.title, row.status], ['Brand film', 'qa']);
  });

  test('the Attach button follows the one rule the server applies, through every project status (brief §18)', async () => {
    // The project page gates "Attach files" on mayAttachToProject, the pure
    // half of canAttachToProject: wherever the two disagree, the page offers a
    // button the upload route refuses. A held, cancelled or completed project
    // takes no references, and a share never earns the button at all.
    const statuses = [
      'new', 'awaiting_assignment', 'planned', 'in_progress', 'qa', 'revision_required',
      'approved', 'ready_for_delivery', 'delivered', 'completed', 'on_hold', 'cancelled',
    ];
    const takesNone = ['on_hold', 'cancelled', 'completed'];
    // held_from_status is set exactly while on hold (the schema checks it).
    const [before] = await sql<{ status: string; held: string | null }[]>`
      SELECT status, held_from_status AS held FROM projects WHERE id = ${ids.project}`;
    try {
      for (const status of statuses) {
        await sql`UPDATE projects SET status = ${status}::project_status,
          held_from_status = ${status === 'on_hold' ? before.status : null}::project_status
          WHERE id = ${ids.project}`;
        const { owned } = await projectFlags(pm(), ids.project);
        const button = access.mayAttachToProject({ owned, monthOpen: true, status });
        const server = await access.canAttachToProject(pm(), ids.project);
        assert.equal(button, server.allowed, `${status}: the page and the server disagree`);
        assert.equal(button, !takesNone.includes(status), status);

        const shared = await projectFlags(rep2(), ids.project);
        assert.equal(shared.owned, false, `${status}: shared to read, not to work`);
        assert.equal(access.mayAttachToProject({ owned: shared.owned, monthOpen: true, status }), false, `${status}: no button on a share`);
        assert.equal((await access.canAttachToProject(rep2(), ids.project)).allowed, false, `${status}: the server refuses the share`);
      }
    } finally {
      await sql`UPDATE projects SET status = ${before.status}::project_status,
        held_from_status = ${before.held}::project_status WHERE id = ${ids.project}`;
    }
    assert.equal(access.mayAttachToProject({ owned: true, monthOpen: false, status: 'in_progress' }), false, 'a closed month');
  });

  test('the client page opens to them to read: the client is readable, not theirs to work', async () => {
    assert.deepEqual(await clientFlags(rep2(), ids.client), { owned: false, readable: true });
    const { closeMonth } = await import('../src/lib/months/lifecycle');
    const [month] = await sql<{ id: number }[]>`SELECT id FROM client_months WHERE client_id = ${ids.client}`;
    await assert.rejects(closeMonth(rep2(), { clientMonthId: Number(month.id) }), /No such month/);
    await assert.rejects(fileProject(rep2(), {
      clientId: ids.client, period: '2071-09', title: 'Another',
      departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
    }), /Choose a client/);
  });

  test('the share is on the project’s timeline (brief §25)', async () => {
    const lines = await projectActivity(ids.project);
    assert.deepEqual(
      lines.filter((l) => l.action === 'project.shared').map((l) => [l.actorName, l.text]),
      [['Pat PM', 'Pat PM shared the project with Sam Rep']],
    );
  });

  test('a revision on it opens to them to read — from the workspace, the list, its references and the month’s report — and not to act on (brief §16)', async () => {
    const { createRevision, closeRevision } = await import('../src/lib/revisions/revisions');
    const { loadRevision, revisionList } = await import('../src/lib/revisions/queries');
    const { addComment } = await import('../src/lib/workspace/comments');
    const { loadClientReport } = await import('../src/lib/reports/monthly');

    const opened = await createRevision(rep(), {
      projectId: ids.project, title: 'Recut', clientFeedback: 'Shorter', deliverableIds: [ids.slot],
    });
    ids.revision = opened.revisionId;
    keys.markup = (await upload(rep(), {
      target: 'attachment', projectId: ids.project, revisionId: ids.revision, filename: 'client-markup.png',
    })).storageKey;

    // What the workspace lists and links to, the link opens.
    const ws = await loadWorkspace(rep2(), ids.project);
    assert.ok(ws);
    assert.deepEqual(ws.revisions.map((r) => [r.id, r.title, r.status]), [[ids.revision, 'Recut', 'new']]);
    assert.equal(ws.teams[0].deliverables[0].openRevision?.id, ids.revision, 'the slot says what it is reworked for');
    const detail = await loadRevision(rep2(), ids.revision);
    assert.ok(detail, 'the revision page opens');
    assert.deepEqual([detail.title, detail.projectCode, detail.deliverables.map((d) => d.id)], ['Recut', code, [ids.slot]]);
    assert.deepEqual((await revisionList(rep2(), { projectId: ids.project })).map((r) => r.id), [ids.revision], 'and it is on their list');
    assert.deepEqual(
      (await attachments.listProjectAttachments(rep2(), ids.project)).map((a) => [a.originalFilename, a.parent.kind]),
      [['PO-2071-44.pdf', 'project'], ['brand-guide.pdf', 'project'], ['client-markup.png', 'revision']],
      'its references are read with the rest',
    );
    const markup = await access.loadFileContext(keys.markup);
    assert.ok(markup);
    assert.deepEqual(await access.decideFileAccess(rep2(), markup), { allowed: true });
    const report = await loadClientReport(rep2(), ids.client, { year: 2071, month: 9 });
    assert.ok(report, 'the month’s report opens');
    assert.deepEqual(report.revisions.map((r) => [r.projectCode, r.revisionNo, r.title]), [[code, 1, 'Recut']]);

    // Reading is not acting: the flag the revision page gates its controls
    // on is off, and the server refuses each of them anyway.
    assert.deepEqual(await projectFlags(rep2(), ids.project), { owned: false, readable: true });
    await assert.rejects(closeRevision(rep2(), { revisionId: ids.revision, outcome: 'closed' }), /No such revision/);
    await assert.rejects(addComment(rep2(), { revisionId: ids.revision, body: 'Noted.' }), /No such revision/);
    assert.deepEqual(
      await access.canAttachToProject(rep2(), ids.project, { revisionId: ids.revision }),
      { allowed: false, reason: 'No such project.' },
    );
    const [row] = await sql<{ status: string; comments: number }[]>`
      SELECT r.status, (SELECT count(*)::int FROM comments c WHERE c.revision_id = r.id) AS comments
      FROM revisions r WHERE r.id = ${ids.revision}`;
    assert.deepEqual([row.status, row.comments], ['new', 0]);
    assert.equal((await loadRevision(rep(), ids.revision))?.id, ids.revision, 'the owner’s view is unchanged');
  });

  test('a delete_files grant does not turn the share into a key: the route answers as for a file that is not there', async () => {
    await sql`
      INSERT INTO user_permissions (user_id, permission, granted_by)
      VALUES (${ids.rep2}, 'delete_files', ${ids.pm}), (${ids.rep}, 'delete_files', ${ids.pm})`;
    // Past the first-login password change, which the API would otherwise demand.
    await sql`UPDATE users SET must_change_password = false WHERE id IN (${ids.rep}, ${ids.rep2})`;
    const [v2] = await sql<{ id: number }[]>`SELECT id FROM files WHERE storage_key = ${keys.v2}::uuid`;
    const fileId = Number(v2.id);
    const isDeleted = async () =>
      (await sql<{ deleted: boolean }[]>`SELECT deleted_at IS NOT NULL AS deleted FROM files WHERE id = ${fileId}`)[0].deleted;
    try {
      const granted = actor('sales', { id: ids.rep2, fullName: 'Sam Rep', permissions: new Set<Permission>(['delete_files']) });
      const ctx = await access.loadFileContext(keys.v2);
      assert.ok(ctx);
      assert.deepEqual(await access.decideFileAccess(granted, ctx), { allowed: true }, 'the share is for reading');
      assert.deepEqual(await access.decideFileAccess(granted, ctx, 'write'), { allowed: false, reason: 'out_of_scope' },
        'not for deleting — the flag the pages gate their Delete buttons on');

      const response = await deleteAs(ids.rep2, keys.v2);
      assert.equal(response.status, 404, 'indistinguishable from a file that is not there');
      assert.equal(await isDeleted(), false);
      const denied = await sql<{ reason: string }[]>`
        SELECT metadata->>'reason' AS reason FROM activity_log
        WHERE actor_id = ${ids.rep2} AND action = 'file.delete_denied' AND entity_id = ${fileId}`;
      assert.deepEqual(denied.map((d) => d.reason), ['out_of_scope'], 'refused, and logged as such');

      // The same grant on a project that is theirs is a delete.
      const own = await deleteAs(ids.rep, keys.v2);
      assert.equal(own.status, 204);
      assert.equal(await isDeleted(), true);
    } finally {
      await sql`UPDATE files SET deleted_at = NULL, deleted_by = NULL WHERE id = ${fileId}`;
      await sql`DELETE FROM user_permissions WHERE user_id IN (${ids.rep}, ${ids.rep2})`;
    }
  });

  test('taking the share back closes every path again, and that is on the timeline too', async () => {
    const taken = await viewers.unshareProject(pm(), { projectId: ids.project, userId: ids.rep2 });
    assert.equal(taken.changed, true);
    await logShare('project.unshared', ids.pm, ids.project, { id: ids.rep2, name: 'Sam Rep' });

    assert.deepEqual(await projectFlags(rep2(), ids.project), { owned: false, readable: false });
    assert.equal(await loadWorkspace(rep2(), ids.project), null);
    assert.deepEqual(await attachments.listProjectAttachments(rep2(), ids.project), []);
    const { loadRevision, revisionList } = await import('../src/lib/revisions/queries');
    assert.equal(await loadRevision(rep2(), ids.revision), null);
    assert.deepEqual(await revisionList(rep2(), { projectId: ids.project }), []);
    const v2 = await access.loadFileContext(keys.v2);
    assert.ok(v2);
    assert.deepEqual(await access.decideFileAccess(rep2(), v2), { allowed: false, reason: 'out_of_scope' });
    assert.deepEqual((await monthSummaries(rep2(), ids.client)).map((m) => m.projects), [0]);
    assert.deepEqual(await mine(rep2()), []);
    assert.deepEqual(await clientFlags(rep2(), ids.client), { owned: false, readable: false });

    const shareLines = (await projectActivity(ids.project))
      .filter((l) => l.action === 'project.shared' || l.action === 'project.unshared')
      .map((l) => l.text);
    assert.deepEqual(shareLines, [
      'Pat PM shared the project with Sam Rep',
      'Pat PM stopped sharing the project with Sam Rep',
    ]);
  });
});

describe('who is told when a project is filed for a client (brief §20, Sales: project created)', { skip }, () => {
  test('a client owner who has left Sales is not told', async () => {
    await sql`UPDATE users SET role = 'team_lead' WHERE id = ${ids.rep}`;
    try {
      const filed = await fileProject(pm(), {
        clientId: ids.client, period: '2071-09', title: 'Filed while the rep was away',
        departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
      });
      ids.away = filed.projectId;
      assert.deepEqual(await told(ids.rep, ids.away), [], 'no longer in Sales, no longer told');
      assert.deepEqual(await told(ids.pm, ids.away), [], 'the filer is never told');
      assert.deepEqual(await told(ids.rep2, ids.away), [], 'not their client');
    } finally {
      await sql`UPDATE users SET role = 'sales' WHERE id = ${ids.rep}`;
    }
  });

  test('a colleague in Sales files for the client: the owner is told who filed it; the filer is not told', async () => {
    const trusted = actor('sales', { id: ids.rep2, fullName: 'Sam Rep', permissions: new Set<Permission>(['view_all_clients']) });
    const filed = await fileProject(trusted, {
      clientId: ids.client, period: '2071-09', title: 'Filed by a colleague',
      departments: [{ departmentId: ids.video, plannedDeliverables: 2 }],
    });
    ids.colleague = filed.projectId;

    const owner = await told(ids.rep, ids.colleague);
    assert.equal(owner.length, 1);
    assert.equal(owner[0].type, 'project.created');
    assert.equal(owner[0].title, `Project created for your client: ${filed.projectCode} · Filed by a colleague`);
    // The notice names the section the project waits in (brief §4): nobody
    // is sent to look for an "intake".
    assert.equal(owner[0].body, 'W3 roles Client. Filed by Sam Rep; waiting in the Project Closure Report for a Project Manager.');
    assert.deepEqual(await told(ids.rep2, ids.colleague), [], 'the filer hears nothing');
    assert.deepEqual(
      (await told(ids.pm, ids.colleague)).map((r) => [r.type, r.title]),
      [['project.created', `New project: ${filed.projectCode} · Filed by a colleague`]],
    );
  });

  test('a rep filing their own client’s order is told nothing; the Project Managers are', async () => {
    assert.deepEqual(await told(ids.rep, ids.project, 'project.created'), []);
    const managers = await told(ids.pm, ids.project, 'project.created');
    assert.deepEqual(
      managers.map((r) => [r.title, r.body]),
      [[`New project: ${code} · Brand film`, 'W3 roles Client. Waiting in the Project Closure Report for a Project Manager.']],
    );
    for (const r of managers) assert.doesNotMatch(r.body ?? '', /intake|triage/i, 'the old working name is not read anywhere');
  });
});

describe('the sentences and the names, without a database', () => {
  test('sharing reads as a sentence on the timeline (brief §25)', async () => {
    const { describeActivity } = await import('../src/lib/activity/describe');
    const { FEED_ACTIONS } = await import('../src/lib/activity/feed');
    const say = (action: string, metadata: Record<string, unknown>) =>
      describeActivity({ action, actorName: 'Pat PM', metadata });
    assert.equal(say('project.shared', { userId: 4, userName: 'Sam Rep' }), 'Pat PM shared the project with Sam Rep');
    assert.equal(say('project.unshared', { userId: 4, userName: 'Sam Rep' }), 'Pat PM stopped sharing the project with Sam Rep');
    assert.equal(say('project.shared', {}), 'Pat PM shared the project with a Sales representative');
    assert.equal(describeActivity({ action: 'project.unshared', actorName: null, metadata: { userName: 'Sam Rep' } }),
      'Someone stopped sharing the project with Sam Rep');
    assert.ok(FEED_ACTIONS.includes('project.shared'));
    assert.ok(FEED_ACTIONS.includes('project.unshared'));
  });

  test('the download name carries the version and the project ID (brief §19, §24)', async () => {
    const { downloadFilename } = await import('../src/lib/files/storage');
    assert.equal(downloadFilename('Video_Final.mp4', 2), 'Video_Final_v2.mp4');
    assert.equal(downloadFilename('Video_Final_v2.mp4', 2), 'Video_Final_v2.mp4', 'already numbered');
    assert.equal(downloadFilename('PO.pdf', null), 'PO.pdf', 'an attachment keeps its name');
    assert.equal(downloadFilename('README', 3), 'README_v3', 'no extension');
    assert.equal(downloadFilename('Video_Final.mp4', 2, 'AKT-2071-0001'), 'AKT-2071-0001_Video_Final_v2.mp4');
    assert.equal(downloadFilename('PO.pdf', null, 'AKT-2071-0001'), 'AKT-2071-0001_PO.pdf');
    assert.equal(downloadFilename('AKT-2071-0001_PO.pdf', null, 'AKT-2071-0001'), 'AKT-2071-0001_PO.pdf', 'not twice');
    assert.equal(downloadFilename('PO.pdf', null, null), 'PO.pdf');
  });
});
