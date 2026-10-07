/**
 * Planning, assigning and the Executive's side of it (brief §6–§11).
 *
 * The work list says what each assignment owes (its slots), how far the
 * uploads are, what was said and where the client's revision stands; the
 * workspace keeps a QA decision and a note on every version; references
 * hang off the project, one assignment or one revision and are read exactly
 * as their project is; an upload that outlives its assignment is refused
 * when it completes; the planning board shows the PM every routed team and
 * a lead only their own; a rep the project is shared with reads it and
 * nothing more.
 *
 * Needs DATABASE_URL pointing at a migrated database. Everything is filed in
 * 2072-09 under a "W3 planning" client by people at @w3planning.local, and
 * only those rows are purged.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
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
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run planning tests';

let sql: ReturnType<typeof postgres>;
let storageRoot: string;

let uploads: typeof import('../src/lib/files/uploads');
let access: typeof import('../src/lib/files/access');
let storage: typeof import('../src/lib/files/storage');
let attachments: typeof import('../src/lib/files/attachments');
let myWork: typeof import('../src/lib/workspace/my-work').myWork;
let loadWorkspace: typeof import('../src/lib/workspace/workspace').loadWorkspace;
let addComment: typeof import('../src/lib/workspace/comments').addComment;
let planningBoard: typeof import('../src/lib/planning/board').planningBoard;
let createAssignment: typeof import('../src/lib/planning/assign').createAssignment;
let reviewDeliverable: typeof import('../src/lib/qa/review').reviewDeliverable;
let createRevision: typeof import('../src/lib/revisions/revisions').createRevision;
let closeRevision: typeof import('../src/lib/revisions/revisions').closeRevision;
let revisionList: typeof import('../src/lib/revisions/queries').revisionList;
let loadRevision: typeof import('../src/lib/revisions/queries').loadRevision;
let shareProject: typeof import('../src/lib/projects/viewers').shareProject;
let unshareProject: typeof import('../src/lib/projects/viewers').unshareProject;
let fileProject: typeof import('../src/lib/projects/file-project').fileProject;
let triageProject: typeof import('../src/lib/projects/triage').triageProject;
let route: typeof import('../src/app/api/files/[storageKey]/route');

const ids: Record<string, number> = {};

const NAMES: Record<string, string> = {
  sales: 'Sam Sales', repB: 'Rita Rep', pm: 'Pat PM', admin: 'Ada Admin',
  leadVideo: 'Lena Video', coLeadVideo: 'Carl Video', leadDesign: 'Dana Design',
  ahmed: 'Ahmed', omar: 'Omar', sara: 'Sara', noor: 'Noor',
};

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0, email: `${role}@w3planning.local`, fullName: role, role,
    isActive: true, mustChangePassword: false,
    leadDepartmentIds: [], departmentIds: [], permissions: new Set<Permission>(), ...over,
  };
}
const as = (key: string, role: Role, over: Partial<Actor> = {}) =>
  actor(role, { id: ids[key], fullName: NAMES[key], email: `${key}@w3planning.local`, ...over });
const sales = () => as('sales', 'sales');
const repB = () => as('repB', 'sales');
const pm = () => as('pm', 'project_manager');
const admin = () => as('admin', 'admin');
const leadVideo = () => as('leadVideo', 'team_lead', { leadDepartmentIds: [ids.video], departmentIds: [ids.video] });
const coLeadVideo = () => as('coLeadVideo', 'team_lead', { leadDepartmentIds: [ids.video], departmentIds: [ids.video] });
const leadDesign = () => as('leadDesign', 'team_lead', { leadDepartmentIds: [ids.design], departmentIds: [ids.design] });
const ahmed = () => as('ahmed', 'executive', { departmentIds: [ids.video] });
const omar = () => as('omar', 'executive', { departmentIds: [ids.video] });
const sara = () => as('sara', 'executive', { departmentIds: [ids.design] });

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE '%@w3planning.local'`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM upload_sessions WHERE created_by IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'W3 planning %')`;
  await sql`DELETE FROM clients WHERE name LIKE 'W3 planning %'`;
  await sql`DELETE FROM files WHERE uploaded_by IN (${users})`;
  await sql`DELETE FROM notifications WHERE user_id IN (${users})`;
  await sql`DELETE FROM department_members WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE '%@w3planning.local'`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2072`;
}

const bytes = () => randomBytes(64);
const stream = (b: Buffer) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(b)); c.close(); } });

async function upload(who: Actor, deliverableId: number, filename: string, notes?: string) {
  const b = bytes();
  const { session } = await uploads.createUploadSession(who, {
    target: 'deliverable', deliverableId, filename, size: b.length, mimeType: 'video/mp4', notes,
  });
  await uploads.appendChunk(who, session.id, 0, stream(b));
  return uploads.completeUpload(who, session.id);
}

async function attach(who: Actor, projectId: number, filename: string, parent: { assignmentId?: number; revisionId?: number } = {}) {
  const b = bytes();
  const { session } = await uploads.createUploadSession(who, {
    target: 'attachment', projectId, ...parent, filename, size: b.length,
  });
  await uploads.appendChunk(who, session.id, 0, stream(b));
  return uploads.completeUpload(who, session.id);
}

const itemOf = async (who: Actor, assignmentId: number) => {
  const work = await myWork(who);
  const item = [...work.current, ...work.previous].find((w) => w.assignmentId === assignmentId);
  assert.ok(item, `assignment ${assignmentId} is on ${who.fullName}’s list`);
  return item;
};

const slotOf = async (who: Actor, deliverableId: number) => {
  const ws = await loadWorkspace(who, ids.project);
  assert.ok(ws, `${who.fullName} sees the project`);
  const slot = ws.teams.flatMap((t) => t.deliverables).find((d) => d.id === deliverableId);
  assert.ok(slot, `slot ${deliverableId} is in the workspace`);
  return slot;
};

const slotStatus = async (id: number) => (await sql`SELECT status FROM deliverables WHERE id = ${id}`)[0].status as string;
const projectStatus = async (id: number) => (await sql`SELECT status FROM projects WHERE id = ${id}`)[0].status as string;

async function teamOf(projectId: number, slug: string) {
  return Number((await sql`SELECT id FROM project_departments WHERE project_id = ${projectId} AND department_id = ${ids[slug]}`)[0].id);
}

before(async () => {
  if (skip) return;
  try {
    await setUp();
  } catch (error) {
    // node:test can hang rather than report a rejected before() hook.
    console.error('\n[w3-planning.test] fixture setup failed:', error);
    throw error;
  }
});

async function setUp() {
  // A directory of this run's own under the OS tmpdir, so the sweep at the
  // end removes only what this suite wrote and never a shared STORAGE_ROOT.
  storageRoot = await mkdtemp(path.join(tmpdir(), 'aktivacity-w3-planning-'));
  process.env.STORAGE_ROOT = storageRoot;
  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });

  uploads = await import('../src/lib/files/uploads');
  access = await import('../src/lib/files/access');
  storage = await import('../src/lib/files/storage');
  attachments = await import('../src/lib/files/attachments');
  ({ myWork } = await import('../src/lib/workspace/my-work'));
  ({ loadWorkspace } = await import('../src/lib/workspace/workspace'));
  ({ addComment } = await import('../src/lib/workspace/comments'));
  ({ planningBoard } = await import('../src/lib/planning/board'));
  ({ createAssignment } = await import('../src/lib/planning/assign'));
  ({ reviewDeliverable } = await import('../src/lib/qa/review'));
  ({ createRevision, closeRevision } = await import('../src/lib/revisions/revisions'));
  ({ revisionList, loadRevision } = await import('../src/lib/revisions/queries'));
  ({ shareProject, unshareProject } = await import('../src/lib/projects/viewers'));
  ({ fileProject } = await import('../src/lib/projects/file-project'));
  ({ triageProject } = await import('../src/lib/projects/triage'));
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

  for (const slug of ['video', 'design']) {
    ids[slug] = Number((await sql`SELECT id FROM departments WHERE slug = ${slug}`)[0].id);
  }
  for (const [key, role] of [
    ['sales', 'sales'], ['repB', 'sales'], ['pm', 'project_manager'], ['admin', 'admin'],
    ['leadVideo', 'team_lead'], ['coLeadVideo', 'team_lead'], ['leadDesign', 'team_lead'],
    ['ahmed', 'executive'], ['omar', 'executive'], ['sara', 'executive'], ['noor', 'executive'],
  ] as const) {
    // Past the first-login password change, which the file route would
    // otherwise demand of the person downloading.
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role, must_change_password)
      VALUES (${`${key}@w3planning.local`}, 'x', ${NAMES[key]}, ${role}, false) RETURNING id`;
    ids[key] = Number(row.id);
  }
  for (const [key, slug, lead] of [
    ['leadVideo', 'video', true], ['coLeadVideo', 'video', true], ['leadDesign', 'design', true],
    ['ahmed', 'video', false], ['omar', 'video', false], ['sara', 'design', false], ['noor', 'design', false],
  ] as const) {
    await sql`INSERT INTO department_members (user_id, department_id, is_lead) VALUES (${ids[key]}, ${ids[slug]}, ${lead})`;
  }
  const [client] = await sql<{ id: number }[]>`
    INSERT INTO clients (name, owner_user_id, created_by) VALUES ('W3 planning Client', ${ids.sales}, ${ids.sales}) RETURNING id`;
  ids.client = Number(client.id);

  // The shared project: Video (Ahmed) and Design (Sara, Noor) on one job.
  const filed = await fileProject(sales(), {
    clientId: ids.client, period: '2072-09', title: 'Launch films', deadline: '2072-09-30',
    priceAmount: '9000.00', requiresPmQa: false,
    departments: [
      { departmentId: ids.video, plannedDeliverables: 2 },
      { departmentId: ids.design, plannedDeliverables: 3 },
    ],
  });
  ids.project = filed.projectId;
  await triageProject(pm(), {
    projectId: ids.project,
    teams: [
      { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 2 },
      { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 3 },
    ],
  });
  ids.videoTeam = await teamOf(ids.project, 'video');
  ids.designTeam = await teamOf(ids.project, 'design');

  const cut = await createAssignment(leadVideo(), {
    projectDepartmentId: ids.videoTeam, assigneeId: ids.ahmed, title: 'Cut',
    instructions: 'Match the storyboard.', startDate: '2072-09-01', endDate: '2072-09-10', priority: 'high',
    deliverableCount: 2, deliverableBaseName: 'Video', deliverableDescription: 'Vertical cut with subtitles',
  });
  ids.ahmedAssignment = cut.assignmentId;
  [ids.video01, ids.video02] = cut.deliverableIds;
  // Open-ended work for the same person, planned earlier: it keeps Ahmed on
  // the project when "Cut" changes hands below, and is the row the planning
  // board must ignore once cancelled.
  ids.ahmedExtra = (await createAssignment(leadVideo(), {
    projectDepartmentId: ids.videoTeam, assigneeId: ids.ahmed, title: 'Colour grade',
    startDate: '2072-08-20', endDate: '2072-08-25', deliverableCount: 0,
  })).assignmentId;

  const thumbs = await createAssignment(leadDesign(), {
    projectDepartmentId: ids.designTeam, assigneeId: ids.sara, title: 'Thumbnails',
    startDate: '2072-09-05', endDate: '2072-09-15', deliverableCount: 2, deliverableBaseName: 'Thumbnail',
  });
  ids.saraAssignment = thumbs.assignmentId;
  [ids.thumb01] = thumbs.deliverableIds;
  ids.noorAssignment = (await createAssignment(leadDesign(), {
    projectDepartmentId: ids.designTeam, assigneeId: ids.noor, title: 'Banners',
    startDate: '2072-09-10', endDate: '2072-09-20', deliverableCount: 1, deliverableBaseName: 'Banner',
  })).assignmentId;

  // A second project only Omar works on.
  const solo = await fileProject(sales(), {
    clientId: ids.client, period: '2072-09', title: 'Solo cut', requiresPmQa: false,
    departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
  });
  ids.otherProject = solo.projectId;
  await triageProject(pm(), {
    projectId: ids.otherProject,
    teams: [{ departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 }],
  });
  ids.omarAssignment = (await createAssignment(leadVideo(), {
    projectDepartmentId: await teamOf(ids.otherProject, 'video'), assigneeId: ids.omar, title: 'Solo',
    deliverableCount: 1, deliverableBaseName: 'Video',
  })).assignmentId;

  // Filed with Design ticked, still waiting in the PM's intake queue.
  ids.unroutedProject = (await fileProject(sales(), {
    clientId: ids.client, period: '2072-09', title: 'Awaiting routing',
    departments: [{ departmentId: ids.design, plannedDeliverables: 2 }],
  })).projectId;
}

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('deliverables on the work list (brief §8, §11)', { skip }, () => {
  test('each slot is listed by name, with its description and status', async () => {
    const item = await itemOf(ahmed(), ids.ahmedAssignment);
    assert.deepEqual(item.slots, [
      { id: ids.video01, name: 'Video 01', description: 'Vertical cut with subtitles', status: 'pending' },
      { id: ids.video02, name: 'Video 02', description: 'Vertical cut with subtitles', status: 'pending' },
    ]);
    assert.deepEqual([item.total, item.uploaded, item.approved], [2, 0, 0]);
    assert.deepEqual((await itemOf(ahmed(), ids.ahmedExtra)).slots, [], 'open-ended work has no slots');
  });

  test('the first upload reads 1/2 uploaded while the counter waits for QA (0/2 → 1/2)', async () => {
    const done = await upload(ahmed(), ids.video01, 'Video_01.mp4');
    assert.equal(done.versionNo, 1);
    const item = await itemOf(ahmed(), ids.ahmedAssignment);
    assert.deepEqual([item.total, item.uploaded, item.approved, item.inQa], [2, 1, 0, 1]);
    assert.deepEqual(item.slots.map((s) => s.status), ['awaiting_lead_qa', 'pending']);
    assert.equal(item.status, 'in_progress', 'the first file starts the assignment (§18)');

    const ws = await loadWorkspace(ahmed(), ids.project);
    const a = ws!.teams.flatMap((t) => t.assignments).find((x) => x.id === ids.ahmedAssignment)!;
    assert.deepEqual([a.uploaded, a.approved, a.total], [1, 0, 2], 'the workspace row says the same');
  });
});

describe('today on the work list (brief §21)', { skip }, () => {
  test('an assignment whose planned dates hold today is in today as well as current', async () => {
    const inToday = async () => (await myWork(ahmed())).today.some((w) => w.assignmentId === ids.ahmedAssignment);
    const inCurrent = async () => (await myWork(ahmed())).current.some((w) => w.assignmentId === ids.ahmedAssignment);
    try {
      await sql`UPDATE assignments SET start_date = current_date - 1, end_date = current_date + 1 WHERE id = ${ids.ahmedAssignment}`;
      assert.equal(await inToday(), true);
      assert.equal((await itemOf(ahmed(), ids.ahmedAssignment)).isToday, true);

      await sql`UPDATE assignments SET end_date = current_date - 1 WHERE id = ${ids.ahmedAssignment}`;
      assert.equal(await inToday(), false, 'the window has passed');
      assert.equal(await inCurrent(), true, 'but the work is still open');

      await sql`UPDATE assignments SET end_date = NULL WHERE id = ${ids.ahmedAssignment}`;
      assert.equal(await inToday(), true, 'no end date: started and still on');
    } finally {
      await sql`UPDATE assignments SET start_date = '2072-09-01', end_date = '2072-09-10' WHERE id = ${ids.ahmedAssignment}`;
    }
    assert.equal(await inToday(), false, 'planned for 2072 again');
    assert.equal((await itemOf(ahmed(), ids.ahmedExtra)).isToday, false);
  });
});

describe('comments on the work list (brief §8)', { skip }, () => {
  test('project comments and those pinned to a slot are counted, with the newest time', async () => {
    await addComment(ahmed(), { projectId: ids.project, body: 'Storyboard attached.' });
    await addComment(sara(), { deliverableId: ids.video01, body: 'Logo looks small.' });

    const item = await itemOf(ahmed(), ids.ahmedAssignment);
    assert.equal(item.commentCount, 2);
    assert.match(item.lastCommentAt ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal((await itemOf(sara(), ids.saraAssignment)).commentCount, 2, 'one thread per project');

    const omars = await itemOf(omar(), ids.omarAssignment);
    assert.deepEqual([omars.commentCount, omars.lastCommentAt], [0, null]);
  });
});

describe('every version keeps its own QA decision and note (brief §10, §19)', { skip }, () => {
  test('v1 is sent back, v2 goes up with a note and is approved; each version says so', async () => {
    const back = await reviewDeliverable(leadVideo(), {
      deliverableId: ids.video01, decision: 'changes_requested', comments: 'Opening too long.',
    });
    assert.equal(back.newStatus, 'changes_requested');
    assert.equal((await itemOf(ahmed(), ids.ahmedAssignment)).changesRequested, 1, '"1 to redo" on the list');

    const v2 = await upload(ahmed(), ids.video01, 'Video_01.mp4', 'Logo moved');
    assert.equal(v2.versionNo, 2);
    ids.video01v2 = v2.fileId;
    const ok = await reviewDeliverable(leadVideo(), { deliverableId: ids.video01, decision: 'approved' });
    assert.equal(ok.newStatus, 'approved', 'no PM QA on this project');
    assert.ok(ok.deliveryId, 'a delivery row waits for Sales');

    const slot = await slotOf(ahmed(), ids.video01);
    assert.deepEqual(slot.versions.map((v) => v.versionNo), [2, 1], 'newest first');
    const [second, first] = slot.versions;
    assert.equal(first.reviews.length, 1);
    assert.deepEqual([first.reviews[0].decision, first.reviews[0].versionNo, first.reviews[0].comments, first.reviews[0].reviewer],
      ['changes_requested', 1, 'Opening too long.', 'Lena Video']);
    assert.equal(second.reviews.length, 1);
    assert.deepEqual([second.reviews[0].decision, second.reviews[0].versionNo], ['approved', 2]);
    assert.deepEqual([slot.lastReview?.decision, slot.lastReview?.versionNo], ['approved', 2]);
    assert.equal(slot.currentVersion?.notes, 'Logo moved');
    assert.equal(first.notes, null, 'uploaded without a note');
    const [row] = await sql`SELECT notes FROM deliverable_versions WHERE deliverable_id = ${ids.video01} AND version_no = 2`;
    assert.equal(row.notes, 'Logo moved');

    const item = await itemOf(ahmed(), ids.ahmedAssignment);
    assert.deepEqual([item.approved, item.uploaded, item.total, item.changesRequested], [1, 1, 2, 0], '1/2 approved');
  });

  test('the download route names the version so copies on a desk do not overwrite one another', async () => {
    const [f] = await sql<{ key: string }[]>`SELECT storage_key::text AS key FROM files WHERE id = ${ids.video01v2}`;
    const response = await getAs(ids.ahmed, f.key);
    assert.equal(response.status, 200);
    // The name ends in the version (the route may lead with the project code, §24).
    assert.match(response.headers.get('content-disposition') ?? '', /filename="[^"]*Video_01_v2\.mp4"/);
    await response.body?.cancel();

    const denied = await getAs(ids.omar, f.key);
    assert.equal(denied.status, 404, 'Omar is not on this project: the file does not exist for him');
  });

  /**
   * Runs the GET handler inside a request scope whose cookie is a real
   * session, so the actor is resolved by the data access layer exactly as in
   * production. The scope is built with Next's own store factories.
   */
  async function getAs(userId: number, storageKey: string): Promise<Response> {
    const [session] = await sql<{ id: string }[]>`
      INSERT INTO sessions (user_id, expires_at) VALUES (${userId}, now() + interval '1 hour')
      RETURNING id::text AS id`;
    const request = new NextRequest(`http://portal.test/api/files/${storageKey}`, {
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
          route.GET(request, { params: Promise.resolve({ storageKey }) })));
    } finally {
      await sql`DELETE FROM sessions WHERE id = ${session.id}::uuid`;
    }
  }
});

describe('revision status on the work list (brief §8, §15)', { skip }, () => {
  test('a revision on Ahmed’s slot shows on his row, and on nobody else’s', async () => {
    const rev = await createRevision(sales(), {
      projectId: ids.project, title: 'Logo', clientFeedback: 'Bigger logo.', deliverableIds: [ids.video01],
    });
    ids.rev1 = rev.revisionId;
    assert.equal(rev.revisionNo, 1);
    assert.equal(await slotStatus(ids.video01), 'changes_requested');

    const item = await itemOf(ahmed(), ids.ahmedAssignment);
    assert.deepEqual([item.openRevisions, item.latestRevisionNo, item.latestRevisionStatus], [1, 1, 'new']);
    assert.equal(item.changesRequested, 1, 'the slot came back');
    const saras = await itemOf(sara(), ids.saraAssignment);
    assert.deepEqual([saras.openRevisions, saras.latestRevisionNo, saras.latestRevisionStatus], [0, null, null],
      'the same project, another team’s slot');
    const extra = await itemOf(ahmed(), ids.ahmedExtra);
    assert.deepEqual([extra.openRevisions, extra.latestRevisionNo], [0, null], 'his other assignment holds no slot of it');
  });

  test('what is said on the revision thread is not a project comment', async () => {
    await addComment(sales(), { revisionId: ids.rev1, body: 'Twice the size, the client says.' });
    assert.equal((await itemOf(ahmed(), ids.ahmedAssignment)).commentCount, 2);
  });

  test('the revision list narrows to one project (the link from the work list)', async () => {
    assert.deepEqual((await revisionList(ahmed(), { projectId: ids.project })).map((r) => r.id), [ids.rev1]);
    assert.deepEqual(await revisionList(ahmed(), { projectId: ids.otherProject }), []);
    assert.deepEqual(await revisionList(omar(), { projectId: ids.project }), [], 'Omar is not on the project');
    assert.deepEqual((await revisionList(leadDesign(), { projectId: ids.project })), [],
      'the Design lead does not see a revision that touches only Video (§16)');
  });
});

describe('attachments (brief §3, §7, §15)', { skip }, () => {
  test('a project attachment lands under client → month → project and downloads by its key', async () => {
    const done = await attach(sales(), ids.project, 'PO-4411.pdf');
    ids.poFile = done.fileId;
    assert.match(done.storagePath, new RegExp(`^files/clients/${ids.client}/2072-09/projects/${ids.project}/attachments/[0-9a-f-]{36}\\.pdf$`));
    await stat(storage.absolutePath(done.storagePath));
    const [item] = await attachments.listProjectAttachments(sales(), ids.project);
    assert.deepEqual(item.parent, { kind: 'project' });
    assert.equal(item.downloadUrl, `/api/files/${done.storageKey}`);
    assert.equal(item.uploadedBy, 'Sam Sales');
  });

  test('an assignment’s references name it and its assignee; a revision’s name its number', async () => {
    const refs = await attach(leadVideo(), ids.project, 'storyboard.pdf', { assignmentId: ids.ahmedAssignment });
    assert.equal(refs.assignmentTitle, 'Cut');
    const markup = await attach(sales(), ids.project, 'client-markup.png', { revisionId: ids.rev1 });
    assert.equal(markup.revisionNo, 1);

    const list = await attachments.listProjectAttachments(leadVideo(), ids.project);
    assert.deepEqual(list.map((a) => a.originalFilename), ['PO-4411.pdf', 'storyboard.pdf', 'client-markup.png']);
    assert.deepEqual(list.map((a) => a.parent), [
      { kind: 'project' },
      { kind: 'assignment', id: ids.ahmedAssignment, title: 'Cut', assignee: 'Ahmed' },
      { kind: 'revision', id: ids.rev1, revisionNo: 1, title: 'Logo' },
    ]);
    assert.ok(list.every((a) => !a.isDeleted));
  });

  test('the Design lead does not see the video revision’s markup; someone off the project sees nothing', async () => {
    const names = async (who: Actor) =>
      (await attachments.listProjectAttachments(who, ids.project)).map((a) => a.originalFilename).sort();
    assert.deepEqual(await names(leadDesign()), ['PO-4411.pdf', 'storyboard.pdf']);
    assert.deepEqual(await names(sara()), ['PO-4411.pdf', 'client-markup.png', 'storyboard.pdf'], 'an Executive on the project sees it all');
    assert.deepEqual(await names(omar()), []);
  });

  test('the PM may pin references to any assignment; a deactivated assignee may not', async () => {
    assert.equal((await access.canAttachToProject(pm(), ids.project, { assignmentId: ids.ahmedAssignment })).allowed, true);
    const team = { assigneeId: ids.ahmed, departmentId: ids.video };
    assert.equal(access.mayAttachToAssignment(ahmed(), team), true);
    assert.equal(access.mayAttachToAssignment({ ...ahmed(), isActive: false }, team), false);
    assert.equal(access.mayAttachToAssignment(coLeadVideo(), team), true, 'a co-lead of the department');
    assert.equal(access.mayAttachToAssignment(sara(), team), false, 'a colleague on another team');
    const sarasTry = await access.canAttachToProject(sara(), ids.project, { assignmentId: ids.ahmedAssignment });
    assert.deepEqual(sarasTry, { allowed: false, reason: 'That assignment is not yours to add references to.' });
  });

  test('a deleted attachment disappears, except for those who may delete, who see it struck through', async () => {
    await sql`UPDATE files SET deleted_at = now(), deleted_by = ${ids.pm} WHERE id = ${ids.poFile}`;
    const forAhmed = await attachments.listProjectAttachments(ahmed(), ids.project);
    assert.deepEqual(forAhmed.map((a) => a.originalFilename), ['storyboard.pdf', 'client-markup.png']);
    const forAdmin = await attachments.listProjectAttachments(admin(), ids.project);
    assert.equal(forAdmin.find((a) => a.fileId === ids.poFile)?.isDeleted, true);

    const [f] = await sql<{ key: string }[]>`SELECT storage_key::text AS key FROM files WHERE id = ${ids.poFile}`;
    const ctx = await access.loadFileContext(f.key);
    assert.deepEqual(await access.decideFileAccess(ahmed(), ctx!), { allowed: false, reason: 'deleted' });
    assert.deepEqual(await access.decideFileAccess(admin(), ctx!), { allowed: true });
  });
});

describe('an upload is checked again when it completes (brief §43)', { skip }, () => {
  const versionsOf = async (deliverableId: number) =>
    Number((await sql`SELECT count(*)::int AS n FROM deliverable_versions WHERE deliverable_id = ${deliverableId}`)[0].n);
  const referencesOn = async (assignmentId: number) =>
    Number((await sql`SELECT count(*)::int AS n FROM attachments WHERE assignment_id = ${assignmentId}`)[0].n);
  const handOver = () => sql`UPDATE assignments SET assignee_id = ${ids.omar} WHERE id = ${ids.ahmedAssignment}`;
  const handBack = () => sql`UPDATE assignments SET assignee_id = ${ids.ahmed} WHERE id = ${ids.ahmedAssignment}`;
  const refused = (pattern: RegExp) => (error: unknown) =>
    error instanceof uploads.UploadError && error.status === 403 && pattern.test(error.message);

  test('a deliverable session whose assignment changed hands is refused; nothing is written, the bytes are kept', async () => {
    const b = bytes();
    const { session } = await uploads.createUploadSession(ahmed(), {
      target: 'deliverable', deliverableId: ids.video02, filename: 'Video_02.mp4', size: b.length,
    });
    await uploads.appendChunk(ahmed(), session.id, 0, stream(b));
    const before = await versionsOf(ids.video02);
    await handOver();
    try {
      await assert.rejects(uploads.completeUpload(ahmed(), session.id), refused(/not assigned to you/));
      assert.equal(await versionsOf(ids.video02), before);
      assert.equal(await slotStatus(ids.video02), 'pending');
      assert.equal((await stat(storage.absolutePath(session.tempPath))).size, b.length, 'ready to retry');
      const [row] = await sql`SELECT completed_at FROM upload_sessions WHERE id = ${session.id}`;
      assert.equal(row.completed_at, null);
    } finally {
      await handBack();
      await uploads.abortUpload(ahmed(), session.id);
    }
  });

  test('so is an attachment session pinned to that assignment', async () => {
    const b = bytes();
    const { session } = await uploads.createUploadSession(ahmed(), {
      target: 'attachment', projectId: ids.project, assignmentId: ids.ahmedAssignment, filename: 'notes.txt', size: b.length,
    });
    await uploads.appendChunk(ahmed(), session.id, 0, stream(b));
    const before = await referencesOn(ids.ahmedAssignment);
    await handOver();
    try {
      await assert.rejects(uploads.completeUpload(ahmed(), session.id), refused(/not yours to add references/));
      assert.equal(await referencesOn(ids.ahmedAssignment), before);
      await stat(storage.absolutePath(session.tempPath));
    } finally {
      await handBack();
    }
    // Handed back, the same session completes.
    const done = await uploads.completeUpload(ahmed(), session.id);
    assert.equal(done.assignmentTitle, 'Cut');
    assert.equal(await referencesOn(ids.ahmedAssignment), before + 1);
  });
});

describe('closing the revision (brief §8: the status follows it)', { skip }, () => {
  test('closed: the slot gets its approval back and the row says so', async () => {
    const closed = await closeRevision(sales(), { revisionId: ids.rev1, outcome: 'closed' });
    assert.equal(closed.status, 'closed');
    assert.equal(await slotStatus(ids.video01), 'approved');
    const item = await itemOf(ahmed(), ids.ahmedAssignment);
    assert.deepEqual([item.openRevisions, item.latestRevisionNo, item.latestRevisionStatus, item.changesRequested],
      [0, 1, 'closed', 0]);
    assert.equal(await projectStatus(ids.project), 'in_progress', 'the rest of the work is still to make');
  });
});

describe('the planning overview (brief §6)', { skip }, () => {
  const mine = async (who: Actor) =>
    (await planningBoard(who)).filter((r) => [ids.project, ids.otherProject, ids.unroutedProject].includes(r.projectId));
  const row = (rows: Awaited<ReturnType<typeof mine>>, projectId: number, department: string) =>
    rows.find((r) => r.projectId === projectId && r.department === department);

  test('the PM sees every routed team, with who is on it and when — and what still waits for routing', async () => {
    const rows = await mine(pm());
    assert.deepEqual(rows.map((r) => [r.title, r.department]).sort(), [
      ['Awaiting routing', 'Design'], ['Launch films', 'Design'], ['Launch films', 'Video'], ['Solo cut', 'Video'],
    ]);
    const video = row(rows, ids.project, 'Video')!;
    assert.deepEqual(
      [video.teamId, video.teamLead, video.assignees, video.startsOn, video.endsOn, video.planned, video.slots, video.approved,
        video.status, video.deadline, video.clientName, video.periodYear, video.periodMonth],
      [ids.videoTeam, 'Lena Video', 'Ahmed', '2072-08-20', '2072-09-10', 2, 2, 1, 'in_progress', '2072-09-30',
        'W3 planning Client', 2072, 9],
      'Ahmed holds two assignments and is listed once; the span covers both',
    );
    const design = row(rows, ids.project, 'Design')!;
    assert.deepEqual(
      [design.teamLead, design.assignees, design.startsOn, design.endsOn, design.planned, design.slots, design.approved],
      ['Dana Design', 'Noor, Sara', '2072-09-05', '2072-09-20', 3, 3, 0],
    );
    const waiting = row(rows, ids.unroutedProject, 'Design')!;
    assert.deepEqual([waiting.teamLead, waiting.assignees, waiting.startsOn, waiting.endsOn, waiting.slots, waiting.status],
      [null, null, null, null, 0, 'new']);
  });

  test('a cancelled assignment counts for nothing', async () => {
    await sql`UPDATE assignments SET status = 'cancelled' WHERE id = ${ids.ahmedExtra}`;
    const video = row(await mine(pm()), ids.project, 'Video')!;
    assert.deepEqual([video.assignees, video.startsOn, video.endsOn], ['Ahmed', '2072-09-01', '2072-09-10']);
  });

  test('a Team Lead sees the teams they lead — co-leads too — and nothing unrouted', async () => {
    for (const lead of [leadVideo(), coLeadVideo()]) {
      const rows = await mine(lead);
      assert.deepEqual(rows.map((r) => [r.title, r.department]).sort(), [['Launch films', 'Video'], ['Solo cut', 'Video']],
        `${lead.fullName} gets the Video rows and not Design’s`);
    }
    const design = await mine(leadDesign());
    assert.deepEqual(design.map((r) => [r.title, r.department]), [['Launch films', 'Design']],
      'the unrouted project has no lead yet, so it is not on the board');
    assert.deepEqual(await planningBoard(ahmed()), [], 'an Executive has no board');
    assert.deepEqual(await planningBoard({ ...pm(), isActive: false }), [], 'nor does a deactivated account');
  });
});

describe('a project shared with a Sales rep is read-only (brief §10, §23)', { skip }, () => {
  test('the rep reads the workspace and its files, and can neither upload nor attach', async () => {
    assert.equal(await loadWorkspace(repB(), ids.project), null, 'not hers until it is shared');
    await shareProject(pm(), { projectId: ids.project, userId: ids.repB });

    const ws = await loadWorkspace(repB(), ids.project);
    assert.ok(ws);
    assert.deepEqual(ws.teams.map((t) => t.department).sort(), ['Design', 'Video']);
    const slots = ws.teams.flatMap((t) => t.deliverables);
    assert.equal(slots.length, 5);
    assert.ok(slots.every((d) => !d.canUpload), 'no upload button anywhere');
    assert.equal(ws.comments.length, 2, 'she reads the thread');

    const [f] = await sql<{ key: string }[]>`SELECT storage_key::text AS key FROM files WHERE id = ${ids.video01v2}`;
    const ctx = await access.loadFileContext(f.key);
    assert.deepEqual(await access.decideFileAccess(repB(), ctx!), { allowed: true });
    assert.deepEqual(await access.canAttachToProject(repB(), ids.project), { allowed: false, reason: 'No such project.' });
    assert.equal((await access.canUploadToDeliverable(repB(), ids.video02)).allowed, false);
    const names = (await attachments.listProjectAttachments(repB(), ids.project)).map((a) => a.originalFilename).sort();
    assert.deepEqual(names, ['client-markup.png', 'notes.txt', 'storyboard.pdf'],
      'every reference is hers to read, the revision’s included — and not what was deleted');

    // The revision the workspace links to opens for her, and is on her list (§16, §23).
    assert.deepEqual(ws.revisions.map((r) => [r.id, r.status]), [[ids.rev1, 'closed']]);
    assert.equal((await loadRevision(repB(), ids.rev1))?.title, 'Logo');
    assert.deepEqual((await revisionList(repB(), { projectId: ids.project, includeClosed: true })).map((r) => r.id), [ids.rev1]);
    assert.deepEqual(await revisionList(repB(), { projectId: ids.project }), [], 'closed, so not among the open ones');
  });

  test('unshared, it is gone again', async () => {
    await unshareProject(pm(), { projectId: ids.project, userId: ids.repB });
    assert.equal(await loadWorkspace(repB(), ids.project), null);
    assert.equal(await loadRevision(repB(), ids.rev1), null);
    assert.deepEqual(await revisionList(repB(), { projectId: ids.project, includeClosed: true }), []);
    const [f] = await sql<{ key: string }[]>`SELECT storage_key::text AS key FROM files WHERE id = ${ids.video01v2}`;
    const ctx = await access.loadFileContext(f.key);
    assert.deepEqual(await access.decideFileAccess(repB(), ctx!), { allowed: false, reason: 'out_of_scope' });
  });
});

describe('file names and paths (brief §19, §42)', () => {
  before(async () => {
    process.env.STORAGE_ROOT ??= '/var/lib/aktivacity/storage';
    storage = await import('../src/lib/files/storage');
  });

  test('an attachment path has the client → month → project shape, with no version level', () => {
    assert.equal(
      storage.attachmentRelativePath({ clientId: 1, periodYear: 2096, periodMonth: 3, projectId: 7, storageKey: 'k', originalFilename: 'a.pdf' }),
      'files/clients/1/2096-03/projects/7/attachments/k.pdf',
    );
    assert.equal(
      storage.attachmentRelativePath({ clientId: 1, periodYear: 2096, periodMonth: 12, projectId: 7, storageKey: 'k', originalFilename: '../x.php%00' }),
      'files/clients/1/2096-12/projects/7/attachments/k',
      'a hostile name leaves only the key',
    );
  });

  test('a version downloads with its number in the name; an attachment keeps its own', () => {
    assert.equal(storage.downloadFilename('Video_Final.mp4', 2), 'Video_Final_v2.mp4');
    assert.equal(storage.downloadFilename('Video_Final_v2.mp4', 2), 'Video_Final_v2.mp4', 'already suffixed');
    assert.equal(storage.downloadFilename('Video_Final-V2.mp4', 2), 'Video_Final-V2.mp4', 'whatever the case or separator');
    assert.equal(storage.downloadFilename('Video_Final_v2.mp4', 3), 'Video_Final_v2_v3.mp4', 'a different number is not the same suffix');
    assert.equal(storage.downloadFilename('README', 3), 'README_v3');
    assert.equal(storage.downloadFilename('.env', 1), '.env_v1', 'a leading dot is not an extension');
    assert.equal(storage.downloadFilename('brief.pdf', null), 'brief.pdf');
  });
});
