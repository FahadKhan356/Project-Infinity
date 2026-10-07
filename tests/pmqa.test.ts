/**
 * Per-team PM QA (brief §13): whether a team's approved files also go to the
 * Project Manager before delivery is decided per team, not per project.
 *
 * Two teams on one project must be able to hold different answers through a
 * triage save and through the project edit form, and QA must follow each
 * team's own answer.
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
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run PM QA tests';

const DOMAIN = '@pmqatest.local';
const YEAR = 2061;

let sql: ReturnType<typeof postgres>;
let storageRoot: string;
let uploads: typeof import('../src/lib/files/uploads');
let triage: typeof import('../src/lib/projects/triage');
let edit: typeof import('../src/lib/projects/edit');
let fileProject: typeof import('../src/lib/projects/file-project').fileProject;
let createAssignment: typeof import('../src/lib/planning/assign').createAssignment;
let reviewDeliverable: typeof import('../src/lib/qa/review').reviewDeliverable;

const ids: Record<string, number> = {};

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0, email: `${role}${DOMAIN}`, fullName: role, role,
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

function streamOf(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

async function upload(who: Actor, deliverableId: number, filename: string) {
  const bytes = randomBytes(256);
  const { session } = await uploads.createUploadSession(who, {
    target: 'deliverable', deliverableId, filename, size: bytes.length,
  });
  await uploads.appendChunk(who, session.id, 0, streamOf(bytes));
  return uploads.completeUpload(who, session.id);
}

/** requires_pm_qa per department, keyed by department id. */
async function teamQa(projectId: number): Promise<Record<number, boolean>> {
  const rows = await sql<{ department_id: number; requires_pm_qa: boolean }[]>`
    SELECT department_id, requires_pm_qa FROM project_departments WHERE project_id = ${projectId}`;
  const out: Record<number, boolean> = {};
  for (const r of rows) out[Number(r.department_id)] = r.requires_pm_qa === true;
  return out;
}

async function projectQa(projectId: number): Promise<boolean> {
  const [row] = await sql<{ requires_pm_qa: boolean }[]>`
    SELECT requires_pm_qa FROM projects WHERE id = ${projectId}`;
  return row.requires_pm_qa === true;
}

async function teamRowId(projectId: number, departmentId: number): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    SELECT id FROM project_departments WHERE project_id = ${projectId} AND department_id = ${departmentId}`;
  return Number(row.id);
}

const noticesFor = async (userId: number, projectId: number) =>
  sql<{ body: string }[]>`
    SELECT body FROM notifications
    WHERE user_id = ${userId} AND type = 'project.details_edited' AND entity_id = ${projectId}
    ORDER BY id`;

/** What Sales filed on the main project; passed back unchanged to the edit. */
const DETAILS = {
  title: 'Launch — video and design', projectType: 'Campaign', objective: 'Launch reach',
  description: null, poReference: 'PO-QA-1', requirements: 'Two cuts, two thumbnails',
  clientNotes: null, otherInfo: null, priceAmount: '4000.00', recursMonthly: false,
};

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE ${'%' + DOMAIN}`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM upload_sessions WHERE created_by IN (${users})`;
  await sql`DELETE FROM notifications WHERE user_id IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'PMQA Test%')`;
  await sql`DELETE FROM clients WHERE name LIKE 'PMQA Test%'`;
  await sql`DELETE FROM files WHERE uploaded_by IN (${users})`;
  await sql`DELETE FROM department_members WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE ${'%' + DOMAIN}`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = ${YEAR}`;
}

before(async () => {
  if (skip) return;
  // The suite's own storage root, set before anything under src/lib loads.
  storageRoot = await mkdtemp(path.join(tmpdir(), 'pmqa-'));
  process.env.STORAGE_ROOT = storageRoot;

  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });
  uploads = await import('../src/lib/files/uploads');
  triage = await import('../src/lib/projects/triage');
  edit = await import('../src/lib/projects/edit');
  ({ fileProject } = await import('../src/lib/projects/file-project'));
  ({ createAssignment } = await import('../src/lib/planning/assign'));
  ({ reviewDeliverable } = await import('../src/lib/qa/review'));
  await purge();

  for (const slug of ['video', 'design']) {
    ids[slug] = Number((await sql`SELECT id FROM departments WHERE slug = ${slug}`)[0].id);
  }
  for (const [key, role] of [
    ['sales', 'sales'], ['pm', 'project_manager'], ['leadVideo', 'team_lead'],
    ['leadDesign', 'team_lead'], ['ahmed', 'executive'], ['sara', 'executive'],
  ] as const) {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES (${key + DOMAIN}, 'x', ${key}, ${role}) RETURNING id`;
    ids[key] = Number(row.id);
  }
  const member = (key: string, slug: string, isLead: boolean) =>
    sql`INSERT INTO department_members (user_id, department_id, is_lead)
        VALUES (${ids[key]}, ${ids[slug]}, ${isLead})`;
  await member('leadVideo', 'video', true);
  await member('leadDesign', 'design', true);
  await member('ahmed', 'video', false);
  await member('sara', 'design', false);

  const [client] = await sql<{ id: number }[]>`
    INSERT INTO clients (name, owner_user_id, created_by)
    VALUES ('PMQA Test Client', ${ids.sales}, ${ids.sales}) RETURNING id`;
  ids.client = Number(client.id);

  const main = await fileProject(sales(), {
    clientId: ids.client, period: `${YEAR}-09`, title: DETAILS.title, projectType: DETAILS.projectType,
    objective: DETAILS.objective, poReference: DETAILS.poReference, requirements: DETAILS.requirements,
    priceAmount: DETAILS.priceAmount, requiresPmQa: true,
    departments: [
      { departmentId: ids.video, plannedDeliverables: 2 },
      { departmentId: ids.design, plannedDeliverables: 2 },
    ],
  });
  ids.project = main.projectId;
});

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('the triage form carries one PM QA answer per team', { skip: false }, () => {
  test('the parser reads one PM QA value per selected team', async () => {
    const mod = await import('../src/lib/projects/triage');
    const form = new FormData();
    form.append('projectId', '12');
    form.append('department', '3');
    form.append('lead_3', '99');
    form.append('planned_3', '10');
    form.append('pmqa_3', 'on');
    form.append('department', '4');
    form.append('lead_4', '');
    form.append('planned_4', '0');

    const parsed = mod.parseTriageForm(form);
    assert.equal(parsed.teams[0].requiresPmQa, true);
    assert.equal(parsed.teams[1].requiresPmQa, false, 'an unticked box is absent from the form');
    assert.equal(parsed.requiresPmQa, undefined, 'the form no longer sends a project-wide answer');
  });

  test('parseTeamQaForm reads only the teams the form carried', async () => {
    const mod = await import('../src/lib/projects/edit');
    const form = new FormData();
    form.append('pmqaTeam', '5');
    form.append('pmqaTeam', '6');
    form.append('pmqa_5', 'on');
    form.append('pmqa_7', 'on');
    assert.deepEqual(mod.parseTeamQaForm(form), [
      { departmentId: 5, requiresPmQa: true },
      { departmentId: 6, requiresPmQa: false },
    ]);
  });
});

describe('intake seeds every team from the one checkbox (brief §13)', { skip }, () => {
  test('the value Sales chose lands on the project and on each team row', async () => {
    assert.equal(await projectQa(ids.project), true);
    assert.deepEqual(await teamQa(ids.project), { [ids.video]: true, [ids.design]: true });

    const filed = await fileProject(sales(), {
      clientId: ids.client, period: `${YEAR}-09`, title: 'No PM QA anywhere', requiresPmQa: false,
      departments: [
        { departmentId: ids.video, plannedDeliverables: 1 },
        { departmentId: ids.design, plannedDeliverables: 1 },
      ],
    });
    assert.equal(await projectQa(filed.projectId), false);
    assert.deepEqual(await teamQa(filed.projectId), { [ids.video]: false, [ids.design]: false });
  });
});

describe('a triage save writes each team’s own value and never another’s', { skip }, () => {
  test('two teams on one project keep different answers', async () => {
    await triage.triageProject(pm(), {
      projectId: ids.project,
      teams: [
        { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 2, requiresPmQa: true },
        { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 2, requiresPmQa: false },
      ],
    });
    assert.deepEqual(await teamQa(ids.project), { [ids.video]: true, [ids.design]: false });
    assert.equal(await projectQa(ids.project), true, 'the intake default is left alone');
  });

  test('a team the caller says nothing about keeps its value', async () => {
    await triage.triageProject(pm(), {
      projectId: ids.project,
      teams: [
        { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 2, requiresPmQa: true },
        { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 2 },
      ],
    });
    assert.deepEqual(await teamQa(ids.project), { [ids.video]: true, [ids.design]: false });
  });

  test('flipping both follows the form', async () => {
    await triage.triageProject(pm(), {
      projectId: ids.project,
      teams: [
        { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 2, requiresPmQa: false },
        { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 2, requiresPmQa: true },
      ],
    });
    assert.deepEqual(await teamQa(ids.project), { [ids.video]: false, [ids.design]: true });
    assert.equal(await projectQa(ids.project), true);
  });
});

describe('the edit form persists per-team values (brief §13)', { skip }, () => {
  test('saves each team, reports the change once, and tells the leads', async () => {
    const r = await edit.editProjectDetails(pm(), {
      projectId: ids.project, details: DETAILS,
      teamQa: [
        { departmentId: ids.video, requiresPmQa: true },
        { departmentId: ids.design, requiresPmQa: false },
      ],
    });
    assert.deepEqual(r.changed, ['pmQa']);
    assert.deepEqual(await teamQa(ids.project), { [ids.video]: true, [ids.design]: false });
    assert.equal(await projectQa(ids.project), true, 'the intake default is not rewritten');

    for (const who of [ids.leadVideo, ids.leadDesign]) {
      const notes = await noticesFor(who, ids.project);
      assert.equal(notes.length, 1, `lead ${who} is told once`);
      assert.match(notes[0].body, /PM QA/);
    }
    assert.equal((await noticesFor(ids.pm, ids.project)).length, 0, 'the editor is not told');
  });

  test('saving the same values again changes nothing and tells nobody', async () => {
    const r = await edit.editProjectDetails(pm(), {
      projectId: ids.project, details: DETAILS,
      teamQa: [
        { departmentId: ids.video, requiresPmQa: true },
        { departmentId: ids.design, requiresPmQa: false },
      ],
    });
    assert.deepEqual(r.changed, []);
    assert.equal((await noticesFor(ids.leadVideo, ids.project)).length, 1);
    assert.equal((await noticesFor(ids.leadDesign, ids.project)).length, 1);
  });

  test('a department not on the project is ignored', async () => {
    const [seo] = await sql<{ id: number }[]>`SELECT id FROM departments WHERE slug = 'seo'`;
    const r = await edit.editProjectDetails(pm(), {
      projectId: ids.project, details: DETAILS,
      teamQa: [{ departmentId: Number(seo.id), requiresPmQa: false }],
    });
    assert.deepEqual(r.changed, []);
    assert.deepEqual(await teamQa(ids.project), { [ids.video]: true, [ids.design]: false });
  });

  test('whoever may edit the project may set it; a Team Lead may not', async () => {
    const r = await edit.editProjectDetails(sales(), {
      projectId: ids.project, details: DETAILS,
      teamQa: [{ departmentId: ids.design, requiresPmQa: true }],
    });
    assert.deepEqual(r.changed, ['pmQa']);
    assert.deepEqual(await teamQa(ids.project), { [ids.video]: true, [ids.design]: true });

    await assert.rejects(edit.editProjectDetails(leadVideo(), {
      projectId: ids.project, details: DETAILS,
      teamQa: [{ departmentId: ids.video, requiresPmQa: false }],
    }), /not permitted/);

    // Back to the split the QA suite below relies on.
    await edit.editProjectDetails(pm(), {
      projectId: ids.project, details: DETAILS,
      teamQa: [{ departmentId: ids.design, requiresPmQa: false }],
    });
    assert.deepEqual(await teamQa(ids.project), { [ids.video]: true, [ids.design]: false });
  });
});

describe('QA follows each team’s own value (brief §13)', { skip }, () => {
  test('after the edit save: Video goes to the PM, Design is approved outright', async () => {
    const videoWork = await createAssignment(leadVideo(), {
      projectDepartmentId: await teamRowId(ids.project, ids.video), assigneeId: ids.ahmed,
      title: 'Edit the cuts', deliverableCount: 2, deliverableBaseName: 'Video',
    });
    [ids.video01, ids.video02] = videoWork.deliverableIds;
    const designWork = await createAssignment(leadDesign(), {
      projectDepartmentId: await teamRowId(ids.project, ids.design), assigneeId: ids.sara,
      title: 'Thumbnails', deliverableCount: 2, deliverableBaseName: 'Thumbnail',
    });
    [ids.thumb01, ids.thumb02] = designWork.deliverableIds;

    await upload(ahmed(), ids.video01, 'Video_01_v1.mp4');
    const video = await reviewDeliverable(leadVideo(), { deliverableId: ids.video01, decision: 'approved' });
    assert.equal(video.newStatus, 'awaiting_pm_qa');
    assert.equal(video.deliveryId, null);

    await upload(sara(), ids.thumb01, 'Thumb_01_v1.png');
    const thumb = await reviewDeliverable(leadDesign(), { deliverableId: ids.thumb01, decision: 'approved' });
    assert.equal(thumb.newStatus, 'approved');
    assert.ok(thumb.deliveryId, 'no PM QA for Design: straight to the delivery queue');
  });

  test('after a triage flip: Video is approved outright, Design goes to the PM', async () => {
    await triage.triageProject(pm(), {
      projectId: ids.project,
      teams: [
        { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 2, requiresPmQa: false },
        { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 2, requiresPmQa: true },
      ],
    });
    assert.deepEqual(await teamQa(ids.project), { [ids.video]: false, [ids.design]: true });

    await upload(ahmed(), ids.video02, 'Video_02_v1.mp4');
    const video = await reviewDeliverable(leadVideo(), { deliverableId: ids.video02, decision: 'approved' });
    assert.equal(video.newStatus, 'approved');
    assert.ok(video.deliveryId);

    await upload(sara(), ids.thumb02, 'Thumb_02_v1.png');
    const thumb = await reviewDeliverable(leadDesign(), { deliverableId: ids.thumb02, decision: 'approved' });
    assert.equal(thumb.newStatus, 'awaiting_pm_qa');
    assert.equal(thumb.deliveryId, null);
  });
});
