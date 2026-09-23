/**
 * Team Lead planning and assignment (brief §6, §7, §11).
 *
 * The milestone criterion is the first test: one action creates an assignment
 * with twenty deliverable slots, and progress reads 0/20.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import postgres from 'postgres';
import type { Actor, Permission, Role } from '../src/lib/authz/types';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run planning tests';

let sql: ReturnType<typeof postgres>;
let createAssignment: typeof import('../src/lib/planning/assign').createAssignment;
let PlanningError: typeof import('../src/lib/planning/assign').PlanningError;
let teamWorkload: typeof import('../src/lib/planning/workload').teamWorkload;

const ids: Record<string, number> = {};

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0, email: `${role}@m5test.local`, fullName: role, role,
    isActive: true, mustChangePassword: false,
    leadDepartmentIds: [], departmentIds: [], permissions: new Set<Permission>(), ...over,
  };
}

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE '%@m5test.local'`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'M5 Test%')`;
  await sql`DELETE FROM clients WHERE name LIKE 'M5 Test%'`;
  await sql`DELETE FROM department_members WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE '%@m5test.local'`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2096`;
}

async function progressOf(assignmentId: number) {
  const [row] = await sql<{ total: number; approved: number; started: number }[]>`
    SELECT total, approved, started FROM v_assignment_progress WHERE assignment_id = ${assignmentId}`;
  return { total: Number(row.total), approved: Number(row.approved), started: Number(row.started) };
}

before(async () => {
  if (skip) return;
  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });
  ({ createAssignment, PlanningError } = await import('../src/lib/planning/assign'));
  ({ teamWorkload } = await import('../src/lib/planning/workload'));
  const { fileProject } = await import('../src/lib/projects/file-project');
  const { triageProject } = await import('../src/lib/projects/triage');
  await purge();

  for (const slug of ['video', 'design']) {
    ids[slug] = Number((await sql`SELECT id FROM departments WHERE slug = ${slug}`)[0].id);
  }
  const mkUser = async (key: string, role: string) => {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES (${`${key}@m5test.local`}, 'x', ${key}, ${role}) RETURNING id`;
    ids[key] = Number(row.id);
  };
  await mkUser('sales', 'sales');
  await mkUser('pm', 'project_manager');
  await mkUser('leadDesign', 'team_lead');
  await mkUser('leadVideo', 'team_lead');
  await mkUser('sara', 'executive');
  await mkUser('noor', 'executive');
  await mkUser('ahmed', 'executive');

  const member = async (key: string, slug: string, isLead = false) =>
    sql`INSERT INTO department_members (user_id, department_id, is_lead)
        VALUES (${ids[key]}, ${ids[slug]}, ${isLead})`;
  await member('leadDesign', 'design', true);
  await member('leadVideo', 'video', true);
  await member('sara', 'design');
  await member('noor', 'design');
  await member('ahmed', 'video');

  const [client] = await sql<{ id: number }[]>`
    INSERT INTO clients (name, owner_user_id, created_by)
    VALUES ('M5 Test Client', ${ids.sales}, ${ids.sales}) RETURNING id`;
  ids.client = Number(client.id);

  const filed = await fileProject(actor('sales', { id: ids.sales }), {
    clientId: ids.client, period: '2096-09', title: 'Monthly content',
    departments: [
      { departmentId: ids.design, plannedDeliverables: 20 },
      { departmentId: ids.video, plannedDeliverables: 10 },
    ],
  });
  ids.project = filed.projectId;

  await triageProject(actor('project_manager', { id: ids.pm }), {
    projectId: ids.project,
    teams: [
      { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 20 },
      { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 10 },
    ],
  });

  const teams = await sql<{ id: number; department_id: number }[]>`
    SELECT id, department_id FROM project_departments WHERE project_id = ${ids.project}`;
  for (const t of teams) {
    if (Number(t.department_id) === ids.design) ids.designTeam = Number(t.id);
    if (Number(t.department_id) === ids.video) ids.videoTeam = Number(t.id);
  }
});

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
});

describe('the milestone criterion: one action, twenty slots', { skip }, () => {
  test('creates the assignment and all its slots at 0/20', async () => {
    const lead = actor('team_lead', { id: ids.leadDesign, leadDepartmentIds: [ids.design] });

    const result = await createAssignment(lead, {
      projectDepartmentId: ids.designTeam,
      assigneeId: ids.sara,
      title: '20 social media designs',
      instructions: 'Follow the brand guide.',
      startDate: '2096-09-01',
      endDate: '2096-09-20',
      deliverableCount: 20,
      deliverableBaseName: 'Design',
      deliverableDescription: '1080x1350, brand palette',
    });
    ids.saraAssignment = result.assignmentId;

    assert.equal(result.deliverableIds.length, 20);
    assert.equal(result.firstSequenceNo, 1);
    assert.equal(result.lastSequenceNo, 20);

    assert.deepEqual(await progressOf(result.assignmentId), { total: 20, approved: 0, started: 0 });

    // to_char, because a bare date column arrives as a JS Date whose string
    // form depends on the local timezone.
    const slots = await sql<{ name: string; status: string; description: string; due_date: string }[]>`
      SELECT name, status, description, to_char(due_date, 'YYYY-MM-DD') AS due_date
      FROM deliverables
      WHERE assignment_id = ${result.assignmentId} ORDER BY sequence_no`;
    assert.equal(slots.length, 20);
    assert.equal(slots[0].name, 'Design 01');
    assert.equal(slots[19].name, 'Design 20');
    assert.ok(slots.every((s) => s.status === 'pending'));
    assert.ok(slots.every((s) => s.description === '1080x1350, brand palette'));
    assert.ok(slots.every((s) => s.due_date === '2096-09-20'),
      `slots inherit the assignment end date when no due date is given (got ${slots[0].due_date})`);
  });

  test('a second assignment continues the numbering rather than colliding', async () => {
    const lead = actor('team_lead', { id: ids.leadDesign, leadDepartmentIds: [ids.design] });
    const result = await createAssignment(lead, {
      projectDepartmentId: ids.designTeam,
      assigneeId: ids.noor,
      title: 'Five extra designs',
      deliverableCount: 5,
      deliverableBaseName: 'Design',
    });
    assert.equal(result.firstSequenceNo, 21);
    assert.equal(result.lastSequenceNo, 25);

    const rows = await sql`
      SELECT count(*)::int AS n, count(DISTINCT sequence_no)::int AS distinct_seq
      FROM deliverables WHERE project_department_id = ${ids.designTeam}`;
    assert.equal(rows[0].n, 25);
    assert.equal(rows[0].distinct_seq, 25, 'sequence numbers stay unique within a team');
  });

  test('numbering is per team, so Video starts at 1 again', async () => {
    const lead = actor('team_lead', { id: ids.leadVideo, leadDepartmentIds: [ids.video] });
    const result = await createAssignment(lead, {
      projectDepartmentId: ids.videoTeam,
      assigneeId: ids.ahmed,
      title: 'Ten videos',
      deliverableCount: 10,
      deliverableBaseName: 'Video',
    });
    assert.equal(result.firstSequenceNo, 1);
    assert.equal(result.lastSequenceNo, 10);
  });
});

describe('who may assign', { skip }, () => {
  test('a lead cannot plan a team they do not lead', async () => {
    const designLead = actor('team_lead', { id: ids.leadDesign, leadDepartmentIds: [ids.design] });
    await assert.rejects(
      createAssignment(designLead, {
        projectDepartmentId: ids.videoTeam,
        assigneeId: ids.ahmed,
        title: 'Not mine',
        deliverableCount: 1,
      }),
      /not yours to plan/,
    );
  });

  test('the Project Manager can plan any team (§6)', async () => {
    const pm = actor('project_manager', { id: ids.pm });
    const result = await createAssignment(pm, {
      projectDepartmentId: ids.videoTeam,
      assigneeId: ids.ahmed,
      title: 'PM-planned work',
      deliverableCount: 1,
      deliverableBaseName: 'Video',
    });
    assert.equal(result.deliverableIds.length, 1);
  });

  test('an Executive cannot assign work at all', async () => {
    await assert.rejects(
      createAssignment(actor('executive', { id: ids.sara }), {
        projectDepartmentId: ids.designTeam,
        assigneeId: ids.sara,
        title: 'Self-assigned',
        deliverableCount: 1,
      }),
      /not permitted/,
    );
  });

  test('work cannot be given to someone outside the team', async () => {
    const lead = actor('team_lead', { id: ids.leadDesign, leadDepartmentIds: [ids.design] });
    await assert.rejects(
      createAssignment(lead, {
        projectDepartmentId: ids.designTeam,
        assigneeId: ids.ahmed, // video only
        title: 'Wrong team',
        deliverableCount: 1,
      }),
      /not a member of this team/,
    );
  });
});

describe('guardrails', { skip }, () => {
  const lead = () => actor('team_lead', { id: ids.leadDesign, leadDepartmentIds: [ids.design] });

  test('an absurd deliverable count is refused', async () => {
    await assert.rejects(
      createAssignment(lead(), {
        projectDepartmentId: ids.designTeam, assigneeId: ids.sara,
        title: 'Typo', deliverableCount: 5000,
      }),
      /Split it into several assignments/,
    );
  });

  test('an end date before the start date is refused', async () => {
    await assert.rejects(
      createAssignment(lead(), {
        projectDepartmentId: ids.designTeam, assigneeId: ids.sara,
        title: 'Backwards', deliverableCount: 1,
        startDate: '2096-09-20', endDate: '2096-09-01',
      }),
      /cannot fall before/,
    );
  });

  test('zero deliverables is allowed for open-ended work', async () => {
    const result = await createAssignment(lead(), {
      projectDepartmentId: ids.designTeam, assigneeId: ids.sara,
      title: 'Ongoing support', deliverableCount: 0,
    });
    assert.deepEqual(result.deliverableIds, []);
    assert.equal(result.firstSequenceNo, null);
  });

  test('nothing is created when the assignment is rejected', async () => {
    const before = await sql`SELECT count(*)::int AS n FROM deliverables WHERE project_department_id = ${ids.designTeam}`;
    await assert.rejects(
      createAssignment(lead(), {
        projectDepartmentId: ids.designTeam, assigneeId: ids.ahmed,
        title: 'Rejected', deliverableCount: 10,
      }),
      PlanningError,
    );
    const after = await sql`SELECT count(*)::int AS n FROM deliverables WHERE project_department_id = ${ids.designTeam}`;
    assert.equal(after[0].n, before[0].n, 'a refused assignment must leave no orphan slots');
  });
});

describe('workload (brief §6, §21)', { skip }, () => {
  test('counts open slots per member and excludes approved work', async () => {
    const before = await teamWorkload(ids.design);
    const sara = before.find((m) => m.userId === ids.sara)!;
    assert.ok(sara.openSlots >= 20, `expected Sara to carry her 20 slots, got ${sara.openSlots}`);

    // Approve five of Sara's slots; they should leave her open count.
    await sql`
      UPDATE deliverables SET status = 'approved'
      WHERE id IN (
        SELECT id FROM deliverables WHERE assignment_id = ${ids.saraAssignment}
        ORDER BY sequence_no LIMIT 5)`;

    const after = await teamWorkload(ids.design);
    const saraAfter = after.find((m) => m.userId === ids.sara)!;
    assert.equal(saraAfter.openSlots, sara.openSlots - 5);

    assert.deepEqual(await progressOf(ids.saraAssignment), { total: 20, approved: 5, started: 5 });
  });

  test('the lead appears on their own team board', async () => {
    const rows = await teamWorkload(ids.design);
    const lead = rows.find((m) => m.userId === ids.leadDesign);
    assert.ok(lead, 'the lead is a member of the team they lead');
    assert.equal(lead!.isLead, true);
  });

  test('members of another team are not listed', async () => {
    const rows = await teamWorkload(ids.design);
    assert.ok(!rows.some((m) => m.userId === ids.ahmed), 'Ahmed is Video, not Design');
  });
});
