/**
 * The Executive workspace (brief §8, §9, §10) — M6.
 *
 * The milestone criterion is the shared-workspace suite: a Video Executive
 * sees the Design Executive's thumbnails on the project they share, and the
 * workspace carries no pricing for anyone.
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
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run workspace tests';

let sql: ReturnType<typeof postgres>;
let storageRoot: string;
let myWork: typeof import('../src/lib/workspace/my-work').myWork;
let loadWorkspace: typeof import('../src/lib/workspace/workspace').loadWorkspace;
let addComment: typeof import('../src/lib/workspace/comments').addComment;
let WorkspaceError: typeof import('../src/lib/workspace/comments').WorkspaceError;
let loadClientReport: typeof import('../src/lib/reports/monthly').loadClientReport;
let uploads: typeof import('../src/lib/files/uploads');

const ids: Record<string, number> = {};

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0, email: `${role}@m6test.local`, fullName: role, role,
    isActive: true, mustChangePassword: false,
    leadDepartmentIds: [], departmentIds: [], permissions: new Set<Permission>(), ...over,
  };
}

function streamOf(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

async function upload(who: Actor, deliverableId: number, filename: string) {
  const bytes = randomBytes(1024);
  const { session } = await uploads.createUploadSession(who, {
    target: 'deliverable', deliverableId, filename, size: bytes.length, mimeType: 'image/png',
  });
  await uploads.appendChunk(who, session.id, 0, streamOf(bytes));
  return uploads.completeUpload(who, session.id);
}

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE '%@m6test.local'`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM upload_sessions WHERE created_by IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'M6 Test%')`;
  await sql`DELETE FROM clients WHERE name LIKE 'M6 Test%'`;
  await sql`DELETE FROM files WHERE uploaded_by IN (${users})`;
  await sql`DELETE FROM department_members WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE '%@m6test.local'`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2095`;
}

before(async () => {
  if (skip) return;
  try {
    await setUp();
  } catch (error) {
    console.error('\n[workspace.test] fixture setup failed:', error);
    throw error;
  }
});

async function setUp() {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'aktivacity-m6-'));
  process.env.STORAGE_ROOT = storageRoot;

  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });
  ({ myWork } = await import('../src/lib/workspace/my-work'));
  ({ loadWorkspace } = await import('../src/lib/workspace/workspace'));
  ({ addComment, WorkspaceError } = await import('../src/lib/workspace/comments'));
  ({ loadClientReport } = await import('../src/lib/reports/monthly'));
  uploads = await import('../src/lib/files/uploads');
  const { fileProject } = await import('../src/lib/projects/file-project');
  const { triageProject } = await import('../src/lib/projects/triage');
  const { createAssignment } = await import('../src/lib/planning/assign');
  await purge();

  for (const slug of ['video', 'design']) {
    ids[slug] = Number((await sql`SELECT id FROM departments WHERE slug = ${slug}`)[0].id);
  }
  const mkUser = async (key: string, role: string) => {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES (${`${key}@m6test.local`}, 'x', ${key}, ${role}) RETURNING id`;
    ids[key] = Number(row.id);
  };
  await mkUser('sales', 'sales');
  await mkUser('pm', 'project_manager');
  await mkUser('leadVideo', 'team_lead');
  await mkUser('leadDesign', 'team_lead');
  await mkUser('ahmed', 'executive');   // video
  await mkUser('sara', 'executive');    // design
  await mkUser('omar', 'executive');    // video, on a different project

  const member = async (key: string, slug: string, isLead = false) =>
    sql`INSERT INTO department_members (user_id, department_id, is_lead)
        VALUES (${ids[key]}, ${ids[slug]}, ${isLead})`;
  await member('leadVideo', 'video', true);
  await member('leadDesign', 'design', true);
  await member('ahmed', 'video');
  await member('sara', 'design');
  await member('omar', 'video');

  const [client] = await sql<{ id: number }[]>`
    INSERT INTO clients (name, owner_user_id, created_by)
    VALUES ('M6 Test Client', ${ids.sales}, ${ids.sales}) RETURNING id`;
  ids.client = Number(client.id);

  const sales = actor('sales', { id: ids.sales });
  const pm = actor('project_manager', { id: ids.pm });

  // The shared project: Video (Ahmed) and Design (Sara) on the same job.
  const shared = await fileProject(sales, {
    clientId: ids.client, period: '2095-09', title: 'ABC social media videos',
    objective: 'Three launch videos with thumbnails',
    poReference: 'PO-2095-001', requirements: '9:16, subtitles',
    priceAmount: '12000.00', deadline: '2095-09-30',
    departments: [
      { departmentId: ids.video, plannedDeliverables: 3 },
      { departmentId: ids.design, plannedDeliverables: 3 },
    ],
  });
  ids.project = shared.projectId;
  await triageProject(pm, {
    projectId: ids.project,
    teams: [
      { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 3 },
      { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 3 },
    ],
  });
  for (const t of await sql<{ id: number; department_id: number }[]>`
      SELECT id, department_id FROM project_departments WHERE project_id = ${ids.project}`) {
    if (Number(t.department_id) === ids.video) ids.videoTeam = Number(t.id);
    if (Number(t.department_id) === ids.design) ids.designTeam = Number(t.id);
  }

  const videoWork = await createAssignment(
    actor('team_lead', { id: ids.leadVideo, leadDepartmentIds: [ids.video] }),
    {
      projectDepartmentId: ids.videoTeam, assigneeId: ids.ahmed, title: 'Edit the three launch cuts',
      instructions: 'Match the storyboard. Burn in subtitles.',
      startDate: '2095-09-24', endDate: '2095-09-26', priority: 'high',
      deliverableCount: 3, deliverableBaseName: 'Video',
    },
  );
  ids.ahmedAssignment = videoWork.assignmentId;
  [ids.video01, ids.video02, ids.video03] = videoWork.deliverableIds;

  const designWork = await createAssignment(
    actor('team_lead', { id: ids.leadDesign, leadDepartmentIds: [ids.design] }),
    {
      projectDepartmentId: ids.designTeam, assigneeId: ids.sara, title: 'Thumbnails',
      deliverableCount: 3, deliverableBaseName: 'Thumbnail',
    },
  );
  ids.saraAssignment = designWork.assignmentId;
  [ids.thumb01] = designWork.deliverableIds;

  // A second project only Omar works on.
  const other = await fileProject(sales, {
    clientId: ids.client, period: '2095-09', title: 'Omar only',
    departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
  });
  ids.otherProject = other.projectId;
  await triageProject(pm, {
    projectId: ids.otherProject,
    teams: [{ departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 }],
  });
  const [otherTeam] = await sql<{ id: number }[]>`
    SELECT id FROM project_departments WHERE project_id = ${ids.otherProject}`;
  const omarWork = await createAssignment(
    actor('team_lead', { id: ids.leadVideo, leadDepartmentIds: [ids.video] }),
    {
      projectDepartmentId: Number(otherTeam.id), assigneeId: ids.omar, title: 'Solo edit',
      deliverableCount: 1, deliverableBaseName: 'Video',
    },
  );
  ids.omarAssignment = omarWork.assignmentId;
}

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('my work (brief §8)', { skip }, () => {
  test('an Executive sees the assignments they hold, with what they need to start', async () => {
    const ahmed = actor('executive', { id: ids.ahmed, departmentIds: [ids.video] });
    const { current, previous } = await myWork(ahmed);

    assert.equal(previous.length, 0);
    assert.equal(current.length, 1);
    const [item] = current;
    assert.equal(item.projectId, ids.project);
    assert.equal(item.assignmentId, ids.ahmedAssignment);
    assert.equal(item.projectTitle, 'ABC social media videos');
    assert.equal(item.clientName, 'M6 Test Client');
    assert.equal(item.department, 'Video');
    assert.equal(item.startDate, '2095-09-24');
    assert.equal(item.endDate, '2095-09-26');
    assert.equal(item.deadline, '2095-09-30');
    assert.equal(item.priority, 'high');
    assert.equal(item.instructions, 'Match the storyboard. Burn in subtitles.');
    assert.deepEqual(
      { total: item.total, approved: item.approved, uploaded: item.uploaded },
      { total: 3, approved: 0, uploaded: 0 },
    );
  });

  test('someone else’s assignment on the same project is not in my list', async () => {
    const ahmed = actor('executive', { id: ids.ahmed });
    const { current } = await myWork(ahmed);
    assert.ok(!current.some((i) => i.assignmentId === ids.saraAssignment));
  });

  test('a completed assignment moves to previous projects', async () => {
    await sql`UPDATE assignments SET status = 'completed' WHERE id = ${ids.omarAssignment}`;
    try {
      const omar = actor('executive', { id: ids.omar });
      const { current, previous } = await myWork(omar);
      assert.equal(current.length, 0);
      assert.equal(previous.length, 1);
      assert.equal(previous[0].assignmentId, ids.omarAssignment);
    } finally {
      await sql`UPDATE assignments SET status = 'planned' WHERE id = ${ids.omarAssignment}`;
    }
  });

  test('a closed project moves its assignments to previous even if the assignment is open', async () => {
    await sql`UPDATE projects SET status = 'completed' WHERE id = ${ids.otherProject}`;
    try {
      const omar = actor('executive', { id: ids.omar });
      const { current, previous } = await myWork(omar);
      assert.equal(current.length, 0);
      assert.equal(previous.length, 1);
    } finally {
      await sql`UPDATE projects SET status = 'planned' WHERE id = ${ids.otherProject}`;
    }
  });
});

describe('the shared workspace (brief §9, §10) — milestone criterion', { skip }, () => {
  test('Sara uploads a thumbnail; the slot becomes v1 awaiting QA', async () => {
    const sara = actor('executive', { id: ids.sara, departmentIds: [ids.design] });
    const result = await upload(sara, ids.thumb01, 'Thumb_01.png');
    ids.thumbFile = result.fileId;
    assert.equal(result.versionNo, 1);
  });

  test('uploading the first file moves the assignment and the project to in progress (§18)', async () => {
    const [asg] = await sql`SELECT status FROM assignments WHERE id = ${ids.saraAssignment}`;
    assert.equal(asg.status, 'in_progress');
    const [project] = await sql`SELECT status FROM projects WHERE id = ${ids.project}`;
    assert.equal(project.status, 'in_progress');
  });

  test('Ahmed (Video) sees Sara’s (Design) thumbnail in the same workspace', async () => {
    const ahmed = actor('executive', { id: ids.ahmed, departmentIds: [ids.video] });
    const ws = await loadWorkspace(ahmed, ids.project);
    assert.ok(ws, 'Ahmed holds an assignment on this project');

    const design = ws.teams.find((t) => t.department === 'Design');
    assert.ok(design, 'the Design team is part of the workspace');
    assert.ok(design.members.some((m) => m.name === 'sara'), 'Sara is listed as a team member');

    const thumb = design.deliverables.find((d) => d.id === ids.thumb01);
    assert.ok(thumb);
    assert.equal(thumb.status, 'awaiting_lead_qa');
    assert.equal(thumb.assignee, 'sara');
    assert.ok(thumb.currentVersion, 'the uploaded file is attached to the slot');
    assert.equal(thumb.currentVersion.versionNo, 1);
    assert.equal(thumb.currentVersion.originalFilename, 'Thumb_01.png');
    assert.equal(thumb.currentVersion.uploadedBy, 'sara');
    assert.match(thumb.currentVersion.downloadUrl, /^\/api\/files\/[0-9a-f-]{36}$/);
  });

  test('the workspace carries no pricing, for anyone', async () => {
    const pm = actor('project_manager', { id: ids.pm });
    const ws = await loadWorkspace(pm, ids.project);
    assert.ok(ws);
    assert.ok(!/price/i.test(JSON.stringify(ws)), 'pricing must not appear in the workspace payload');
  });

  test('Ahmed may upload to his own slot but not to Sara’s', async () => {
    const ahmed = actor('executive', { id: ids.ahmed });
    const ws = await loadWorkspace(ahmed, ids.project);
    assert.ok(ws);
    const video = ws.teams.find((t) => t.department === 'Video')!;
    const design = ws.teams.find((t) => t.department === 'Design')!;
    assert.ok(video.deliverables.every((d) => d.canUpload));
    assert.ok(design.deliverables.every((d) => !d.canUpload));
  });

  test('the Video Team Lead may upload to Video slots, not Design ones', async () => {
    const lead = actor('team_lead', { id: ids.leadVideo, leadDepartmentIds: [ids.video] });
    const ws = await loadWorkspace(lead, ids.project);
    assert.ok(ws);
    assert.ok(ws.teams.find((t) => t.department === 'Video')!.deliverables.every((d) => d.canUpload));
    assert.ok(ws.teams.find((t) => t.department === 'Design')!.deliverables.every((d) => !d.canUpload));
  });

  test('a second upload is listed as v2, with v1 kept in the history', async () => {
    const sara = actor('executive', { id: ids.sara });
    await upload(sara, ids.thumb01, 'Thumb_01_fixed.png');

    const ws = await loadWorkspace(sara, ids.project);
    const thumb = ws!.teams.find((t) => t.department === 'Design')!.deliverables.find((d) => d.id === ids.thumb01)!;
    assert.equal(thumb.currentVersion!.versionNo, 2);
    assert.deepEqual(thumb.versions.map((v) => v.versionNo), [2, 1]);
  });

  test('Omar, on another project, gets nothing — not even confirmation the project exists', async () => {
    const omar = actor('executive', { id: ids.omar, departmentIds: [ids.video] });
    assert.equal(await loadWorkspace(omar, ids.project), null);
  });
});

describe('comments (brief §9)', { skip }, () => {
  test('a member of the workspace can comment on the project', async () => {
    const ahmed = actor('executive', { id: ids.ahmed });
    const result = await addComment(ahmed, { projectId: ids.project, body: 'Storyboard v2 is in the brief folder.' });
    assert.equal(result.projectId, ids.project);

    const ws = await loadWorkspace(actor('executive', { id: ids.sara }), ids.project);
    const found = ws!.comments.find((c) => c.id === result.commentId);
    assert.ok(found, 'Sara sees Ahmed’s comment');
    assert.equal(found.author, 'ahmed');
    assert.equal(found.deliverableId, null);
  });

  test('a comment can be pinned to a deliverable and resolves to its project', async () => {
    const sara = actor('executive', { id: ids.sara });
    const result = await addComment(sara, { deliverableId: ids.thumb01, body: 'Logo moved to the top-left.' });
    assert.equal(result.projectId, ids.project);

    const ws = await loadWorkspace(sara, ids.project);
    const found = ws!.comments.find((c) => c.id === result.commentId);
    assert.ok(found);
    assert.equal(found.deliverableId, ids.thumb01);
    assert.equal(found.deliverableName, 'Thumbnail 01');
  });

  test('someone outside the project cannot comment on it', async () => {
    const omar = actor('executive', { id: ids.omar });
    await assert.rejects(
      addComment(omar, { projectId: ids.project, body: 'Hello?' }),
      WorkspaceError,
    );
    await assert.rejects(
      addComment(omar, { deliverableId: ids.thumb01, body: 'Hello?' }),
      /No such/,
    );
  });

  test('an empty comment is refused', async () => {
    const ahmed = actor('executive', { id: ids.ahmed });
    await assert.rejects(addComment(ahmed, { projectId: ids.project, body: '   ' }), /Write something/);
  });
});

// Placed last: it puts a v3 on Thumbnail 01, which the version tests above
// must not see.
describe('comments on a file version (brief §10, §19)', { skip }, () => {
  const ahmed = () => actor('executive', { id: ids.ahmed, departmentIds: [ids.video] });
  const sara = () => actor('executive', { id: ids.sara, departmentIds: [ids.design] });
  const thumbOf = async (who: Actor) => {
    const ws = await loadWorkspace(who, ids.project);
    assert.ok(ws);
    return { ws, thumb: ws.teams.find((t) => t.department === 'Design')!.deliverables.find((d) => d.id === ids.thumb01)! };
  };

  test('the Design lead puts a v3 on Sara’s slot', async () => {
    const lead = actor('team_lead', { id: ids.leadDesign, leadDepartmentIds: [ids.design] });
    const result = await upload(lead, ids.thumb01, 'Thumb_01_v3.png');
    assert.equal(result.versionNo, 3);
    const { thumb } = await thumbOf(sara());
    assert.equal(thumb.currentVersion!.versionNo, 3);
    ids.thumbV3 = thumb.currentVersion!.id;
    ids.thumbV2 = thumb.versions.find((v) => v.versionNo === 2)!.id;
  });

  test('Ahmed comments on v3; it is listed under that version and nowhere else', async () => {
    const before = (await myWork(ahmed())).current.find((i) => i.assignmentId === ids.ahmedAssignment)!.commentCount;

    const result = await addComment(ahmed(), { versionId: ids.thumbV3, body: 'Crop is tighter now.' });
    ids.versionComment = result.commentId;
    assert.equal(result.projectId, ids.project);
    assert.deepEqual(result.slot, {
      deliverableId: ids.thumb01, deliverableName: 'Thumbnail 01', versionId: ids.thumbV3, versionNo: 3,
    });

    const { ws, thumb } = await thumbOf(sara());
    assert.equal(thumb.currentVersion!.comments.length, 1);
    const [c] = thumb.currentVersion!.comments;
    assert.equal(c.id, result.commentId);
    assert.equal(c.author, 'ahmed');
    assert.equal(c.body, 'Crop is tighter now.');
    assert.equal(c.versionId, ids.thumbV3);
    assert.equal(c.versionNo, 3);
    assert.equal(c.deliverableId, ids.thumb01);
    assert.equal(c.deliverableName, 'Thumbnail 01');
    for (const v of thumb.versions.filter((v) => v.id !== ids.thumbV3)) {
      assert.equal(v.comments.length, 0, `v${v.versionNo} carries no comment`);
    }
    // A version thread lives under its version, not in the project thread —
    // which still carries the earlier project- and slot-level comments.
    assert.ok(!ws.comments.some((x) => x.id === result.commentId));
    assert.ok(ws.comments.some((x) => x.deliverableId === null && x.author === 'ahmed'));
    assert.ok(ws.comments.some((x) => x.deliverableId === ids.thumb01 && x.author === 'sara'));

    const [row] = await sql`
      SELECT project_id, deliverable_id, assignment_id, revision_id, version_id
      FROM comments WHERE id = ${result.commentId}`;
    assert.deepEqual(
      [row.project_id, row.deliverable_id, row.assignment_id, row.revision_id, Number(row.version_id)],
      [null, null, null, null, ids.thumbV3],
    );

    // §8 "comments": the count on My work includes the version thread.
    const after = (await myWork(ahmed())).current.find((i) => i.assignmentId === ids.ahmedAssignment)!.commentCount;
    assert.equal(after, before + 1);
  });

  test('the uploader and the slot’s executive are told; the author is not', async () => {
    const rows = await sql<{ user_id: string; type: string; title: string; link_path: string }[]>`
      SELECT user_id, type, title, link_path FROM notifications
      WHERE entity_type = 'comment' AND entity_id = ${ids.versionComment}
      ORDER BY user_id`;
    assert.deepEqual(rows.map((r) => Number(r.user_id)), [ids.leadDesign, ids.sara].sort((a, b) => a - b));
    for (const r of rows) {
      assert.equal(r.type, 'comment.posted');
      assert.match(r.title, /Thumbnail 01 v3/);
      assert.equal(r.link_path, `/projects/${ids.project}#version-${ids.thumbV3}`);
    }

    // Sara on her own v2: uploader, executive and author are one person.
    const own = await addComment(sara(), { versionId: ids.thumbV2, body: 'Noted, thanks.' });
    const none = await sql`
      SELECT 1 FROM notifications WHERE entity_type = 'comment' AND entity_id = ${own.commentId}`;
    assert.equal(none.length, 0);
    const { thumb } = await thumbOf(sara());
    assert.equal(thumb.versions.find((v) => v.id === ids.thumbV2)!.comments.length, 1);
  });

  test('outside the project, or a version that does not exist, reads the same', async () => {
    const omar = actor('executive', { id: ids.omar, departmentIds: [ids.video] });
    await assert.rejects(addComment(omar, { versionId: ids.thumbV3, body: 'Hi' }), /No such/);
    await assert.rejects(addComment(ahmed(), { versionId: 0, body: 'Hi' }), /No such/);
  });

  test('the month report labels the version comment with the file version', async () => {
    const report = await loadClientReport(actor('project_manager', { id: ids.pm }), ids.client, { year: 2095, month: 9 });
    assert.ok(report);
    const c = report.comments.find((x) => x.id === ids.versionComment);
    assert.ok(c, 'the version comment is part of the month');
    assert.equal(c.about, 'Thumbnail 01 v3');
    assert.equal(c.projectId, ids.project);
    assert.equal(c.author, 'ahmed');
    const project = report.projects.find((p) => p.id === ids.project);
    assert.ok(project);
    assert.ok(project.comments >= 1);
  });
});

describe('the feed line for a comment (brief §25)', () => {
  test('names the slot and the version the comment was left on', async () => {
    const { describeActivity } = await import('../src/lib/activity/describe');
    const line = (metadata: Record<string, unknown>) =>
      describeActivity({ action: 'comment.posted', actorName: 'ahmed', metadata });
    assert.equal(line({ deliverableName: 'Thumbnail 01', versionNo: 3 }), 'ahmed commented on Thumbnail 01 v3');
    assert.equal(line({ deliverableName: 'Thumbnail 01' }), 'ahmed commented on Thumbnail 01');
    assert.equal(line({}), 'ahmed commented');
  });
});
