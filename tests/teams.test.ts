/**
 * Team Overview (brief §5, §6).
 *
 * The PM sees every production team; a Team Lead sees only the teams they
 * lead; nobody else sees the page. Per team: leads, members with workload,
 * and the active projects routed to it.
 *
 * Needs DATABASE_URL pointing at a migrated database. Other suites and the
 * demo seed put their own people and projects in the same departments, so
 * the assertions pick out this suite's M14 rows and use lower bounds for
 * department-wide totals.
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
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run team overview tests';

let sql: ReturnType<typeof postgres>;
let storageRoot: string;
let teams: typeof import('../src/lib/teams/overview');

const ids: Record<string, number> = {};

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0, email: `${role}@m14test.local`, fullName: role, role,
    isActive: true, mustChangePassword: false,
    leadDepartmentIds: [], departmentIds: [], permissions: new Set<Permission>(), ...over,
  };
}
const sales = () => actor('sales', { id: ids.sales });
const pm = () => actor('project_manager', { id: ids.pm });
const leadVideo = () => actor('team_lead', { id: ids.leadVideo, leadDepartmentIds: [ids.video], departmentIds: [ids.video] });
const leadDesign = () => actor('team_lead', { id: ids.leadDesign, leadDepartmentIds: [ids.design], departmentIds: [ids.design] });
const ahmed = () => actor('executive', { id: ids.ahmed, departmentIds: [ids.video] });

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE '%@m14test.local'`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM upload_sessions WHERE created_by IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'M14 Test%')`;
  await sql`DELETE FROM clients WHERE name LIKE 'M14 Test%'`;
  await sql`DELETE FROM files WHERE uploaded_by IN (${users})`;
  await sql`DELETE FROM department_members WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE '%@m14test.local'`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2092`;
}

before(async () => {
  if (skip) return;
  storageRoot = await mkdtemp(path.join(tmpdir(), 'aktivacity-m14-'));
  process.env.STORAGE_ROOT = storageRoot;
  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });

  teams = await import('../src/lib/teams/overview');
  const uploads = await import('../src/lib/files/uploads');
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
      VALUES (${`${key}@m14test.local`}, 'x', ${`M14 ${key}`}, ${role}) RETURNING id`;
    ids[key] = Number(row.id);
  };
  for (const [k, r] of [
    ['sales', 'sales'], ['pm', 'project_manager'], ['leadVideo', 'team_lead'], ['leadDesign', 'team_lead'],
    ['ahmed', 'executive'], ['sara', 'executive'],
  ] as const) await mkUser(k, r);
  const member = (key: string, slug: string, isLead = false) =>
    sql`INSERT INTO department_members (user_id, department_id, is_lead) VALUES (${ids[key]}, ${ids[slug]}, ${isLead})`;
  await member('leadVideo', 'video', true);
  await member('leadDesign', 'design', true);
  await member('ahmed', 'video');
  await member('sara', 'design');

  const [client] = await sql<{ id: number }[]>`
    INSERT INTO clients (name, owner_user_id, created_by) VALUES ('M14 Test Client', ${ids.sales}, ${ids.sales}) RETURNING id`;
  ids.client = Number(client.id);
  const upload = async (who: Actor, deliverableId: number, filename: string) => {
    const bytes = randomBytes(64);
    const { session } = await uploads.createUploadSession(who, { target: 'deliverable', deliverableId, filename, size: bytes.length });
    await uploads.appendChunk(who, session.id, 0, new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); },
    }));
    return uploads.completeUpload(who, session.id);
  };
  const teamOf = async (projectId: number, slug: string) =>
    Number((await sql`SELECT id FROM project_departments WHERE project_id = ${projectId} AND department_id = ${ids[slug]}`)[0].id);

  // A: Video ×3 for Ahmed (one in lead QA, one overdue, one due next month),
  //    Design ×1 for Sara. Routed to both teams.
  const a = await fileProject(sales(), {
    clientId: ids.client, period: '2092-01', title: 'M14 A', deadline: '2092-02-01', priceAmount: '5000.00',
    departments: [{ departmentId: ids.video, plannedDeliverables: 3 }, { departmentId: ids.design, plannedDeliverables: 1 }],
  });
  ids.projectA = a.projectId;
  await triageProject(pm(), {
    projectId: ids.projectA,
    teams: [
      { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 3 },
      { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 1 },
    ],
  });
  ids.teamAVideo = await teamOf(ids.projectA, 'video');
  const va = await createAssignment(leadVideo(), {
    projectDepartmentId: ids.teamAVideo, assigneeId: ids.ahmed, title: 'Cut',
    deliverableCount: 3, startDate: '2092-01-05', endDate: '2092-01-25',
  });
  await upload(ahmed(), va.deliverableIds[0], 'cut.mp4');
  await sql`UPDATE deliverables SET due_date = current_date - 2 WHERE id = ${va.deliverableIds[1]}`;
  await sql`UPDATE deliverables SET due_date = current_date + 30 WHERE id = ${va.deliverableIds[2]}`;
  await createAssignment(leadDesign(), {
    projectDepartmentId: await teamOf(ids.projectA, 'design'), assigneeId: ids.sara, title: 'Thumb', deliverableCount: 1,
  });

  // B: Video requested but still in intake — not yet any team's work.
  const b = await fileProject(sales(), {
    clientId: ids.client, period: '2092-01', title: 'M14 B',
    departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
  });
  ids.projectB = b.projectId;

  // C: Design, routed and completed — no longer active.
  const c = await fileProject(sales(), {
    clientId: ids.client, period: '2092-01', title: 'M14 C',
    departments: [{ departmentId: ids.design, plannedDeliverables: 1 }],
  });
  ids.projectC = c.projectId;
  await triageProject(pm(), {
    projectId: ids.projectC, teams: [{ departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 1 }],
  });
  await sql`UPDATE projects SET status = 'completed', completed_at = now() WHERE id = ${ids.projectC}`;
});

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('who sees the team overview', { skip }, () => {
  test('the PM and leads yes; Sales and executives no', async () => {
    assert.equal(teams.canViewTeams(pm()), true);
    assert.equal(teams.canViewTeams(leadVideo()), true);
    assert.equal(teams.canViewTeams(sales()), false);
    assert.equal(teams.canViewTeams(ahmed()), false);
    assert.equal(teams.canViewTeams(actor('team_lead', { id: ids.leadVideo, leadDepartmentIds: [ids.video], isActive: false })), false);
    assert.equal(await teams.loadTeamOverview(sales()), null);
    assert.equal(await teams.loadTeamOverview(ahmed()), null);
  });
});

describe('the PM’s overview', { skip }, () => {
  test('every active production team, in order, and nothing that is not one', async () => {
    const t = (await teams.loadTeamOverview(pm()))!;
    const expected = await sql`SELECT name FROM departments WHERE is_production AND is_active ORDER BY sort_order`;
    assert.deepEqual(t.map((x) => x.name), expected.map((r) => r.name));
    assert.ok(!t.some((x) => x.name === 'Sales'));
  });

  test('Video: its lead, Ahmed’s workload, and project A with this team’s slots and dates', async () => {
    const t = (await teams.loadTeamOverview(pm()))!;
    const video = t.find((x) => x.departmentId === ids.video)!;
    assert.ok(video.leads.some((l) => l.userId === ids.leadVideo));
    const ahmedRow = video.members.find((m) => m.userId === ids.ahmed)!;
    assert.deepEqual([ahmedRow.openSlots, ahmedRow.inQa, ahmedRow.dueSoon, ahmedRow.activeAssignments], [3, 1, 1, 1]);
    assert.ok(video.members.find((m) => m.userId === ids.leadVideo)!.isLead);
    assert.ok(!video.members.some((m) => m.userId === ids.sara), 'Sara is Design');

    const a = video.projects.find((p) => p.projectId === ids.projectA)!;
    assert.equal(a.projectDepartmentId, ids.teamAVideo);
    assert.equal(a.teamLead, 'M14 leadVideo');
    assert.equal(a.clientName, 'M14 Test Client');
    assert.deepEqual([a.approved, a.total, a.openSlots, a.inQa, a.overdueSlots], [0, 3, 3, 1, 1]);
    assert.deepEqual([a.startDate, a.endDate, a.deadline], ['2092-01-05', '2092-01-25', '2092-02-01']);
    assert.ok(!video.projects.some((p) => p.projectId === ids.projectB), 'B is still in intake');

    assert.ok(video.activeProjects >= 1);
    assert.ok(video.openSlots >= 3);
    assert.ok(video.inQa >= 1);
    assert.ok(video.overdueSlots >= 1);
    assert.equal(video.activeProjects, video.projects.length);
  });

  test('Design: A only — C is completed', async () => {
    const t = (await teams.loadTeamOverview(pm()))!;
    const design = t.find((x) => x.departmentId === ids.design)!;
    const a = design.projects.find((p) => p.projectId === ids.projectA)!;
    assert.deepEqual([a.total, a.openSlots, a.inQa, a.overdueSlots], [1, 1, 0, 0]);
    assert.equal(a.startDate, null);
    assert.ok(!design.projects.some((p) => p.projectId === ids.projectC));
  });

  test('carries no pricing', async () => {
    const t = (await teams.loadTeamOverview(pm()))!;
    assert.doesNotMatch(JSON.stringify(t), /price|5000/i);
  });
});

describe('a Team Lead’s overview', { skip }, () => {
  test('the Video lead sees only Video', async () => {
    const t = (await teams.loadTeamOverview(leadVideo()))!;
    assert.deepEqual(t.map((x) => x.departmentId), [ids.video]);
    assert.ok(t[0].projects.some((p) => p.projectId === ids.projectA));
    assert.ok(t[0].members.some((m) => m.userId === ids.ahmed));
  });

  test('the Design lead sees only Design, and not Ahmed', async () => {
    const t = (await teams.loadTeamOverview(leadDesign()))!;
    assert.deepEqual(t.map((x) => x.departmentId), [ids.design]);
    assert.ok(!t[0].members.some((m) => m.userId === ids.ahmed));
    assert.ok(t[0].members.some((m) => m.userId === ids.sara));
  });
});
