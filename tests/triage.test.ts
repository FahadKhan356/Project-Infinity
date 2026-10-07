/**
 * Project Manager triage (brief §4, §5, §10).
 *
 * The acceptance criterion for this milestone is the last suite: a project
 * routed to Video and Design shows up for both Team Leads, and neither can
 * see the other's rows.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import postgres from 'postgres';
import type { Actor, Permission, Role } from '../src/lib/authz/types';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run triage tests';

let sql: ReturnType<typeof postgres>;
let triageProject: typeof import('../src/lib/projects/triage').triageProject;
let TriageError: typeof import('../src/lib/projects/triage').TriageError;
let intakeQueue: typeof import('../src/lib/projects/triage').intakeQueue;
let fileProject: typeof import('../src/lib/projects/file-project').fileProject;
let createAssignment: typeof import('../src/lib/planning/assign').createAssignment;

const ids: Record<string, number> = {};

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0, email: `${role}@m4test.local`, fullName: role, role,
    isActive: true, mustChangePassword: false,
    leadDepartmentIds: [], departmentIds: [], permissions: new Set<Permission>(), ...over,
  };
}

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE '%@m4test.local'`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'M4 Test%')`;
  await sql`DELETE FROM clients WHERE name LIKE 'M4 Test%'`;
  await sql`DELETE FROM users WHERE email LIKE '%@m4test.local'`;
}

/** Which project/department rows a lead can see on the planning page. */
async function planningRowsFor(userId: number) {
  const rows = await sql<{ code: string; department: string }[]>`
    SELECT p.project_code AS code, d.name AS department
    FROM project_departments pd
    JOIN projects p    ON p.id = pd.project_id
    JOIN departments d ON d.id = pd.department_id
    WHERE p.status NOT IN ('completed','cancelled')
      AND p.project_code LIKE 'AKT-2097-%'
      AND pd.team_lead_id IS NOT NULL
      AND pd.department_id IN (
        SELECT dm.department_id FROM department_members dm
        WHERE dm.user_id = ${userId} AND dm.is_lead)
    ORDER BY p.project_code, d.name`;
  return rows.map((r) => `${r.code}/${r.department}`);
}

before(async () => {
  if (skip) return;
  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });
  ({ triageProject, TriageError, intakeQueue } = await import('../src/lib/projects/triage'));
  ({ fileProject } = await import('../src/lib/projects/file-project'));
  ({ createAssignment } = await import('../src/lib/planning/assign'));
  await purge();
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2097`;

  for (const slug of ['video', 'design', 'seo']) {
    ids[slug] = Number((await sql`SELECT id FROM departments WHERE slug = ${slug}`)[0].id);
  }

  const mkUser = async (key: string, role: string) => {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES (${`${key}@m4test.local`}, 'x', ${key}, ${role}) RETURNING id`;
    ids[key] = Number(row.id);
  };
  await mkUser('sales', 'sales');
  await mkUser('pm', 'project_manager');
  await mkUser('leadVideo', 'team_lead');
  await mkUser('leadDesign', 'team_lead');
  await mkUser('leadSeo', 'team_lead');

  const lead = async (key: string, slug: string) => {
    await sql`INSERT INTO department_members (user_id, department_id, is_lead)
              VALUES (${ids[key]}, ${ids[slug]}, true)`;
  };
  await lead('leadVideo', 'video');
  await lead('leadDesign', 'design');
  await lead('leadSeo', 'seo');

  const [client] = await sql<{ id: number }[]>`
    INSERT INTO clients (name, owner_user_id, created_by)
    VALUES ('M4 Test Client', ${ids.sales}, ${ids.sales}) RETURNING id`;
  ids.client = Number(client.id);

  const salesActor = actor('sales', { id: ids.sales });
  const filed = await fileProject(salesActor, {
    clientId: ids.client, period: '2097-09', title: 'Campaign — video and design',
    departments: [
      { departmentId: ids.video, plannedDeliverables: 10 },
      { departmentId: ids.design, plannedDeliverables: 20 },
    ],
  });
  ids.project = filed.projectId;
  ids.projectCode = filed.projectCode as unknown as number;

  const solo = await fileProject(salesActor, {
    clientId: ids.client, period: '2097-09', title: 'SEO only',
    departments: [{ departmentId: ids.seo, plannedDeliverables: 4 }],
  });
  ids.soloProject = solo.projectId;
});

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2097`;
  await sql.end();
});

describe('who may triage', { skip }, () => {
  test('Sales cannot route their own project', async () => {
    await assert.rejects(
      triageProject(actor('sales', { id: ids.sales }), {
        projectId: ids.project,
        teams: [{ departmentId: ids.video, teamLeadId: ids.leadVideo }],
      }),
      TriageError,
    );
  });

  test('an Executive cannot route anything', async () => {
    await assert.rejects(
      triageProject(actor('executive', { id: ids.leadVideo }), {
        projectId: ids.project,
        teams: [{ departmentId: ids.video, teamLeadId: ids.leadVideo }],
      }),
      /not permitted/,
    );
  });
});

describe('routing a project', { skip }, () => {
  test('a partly routed project stays in the intake queue', async () => {
    const result = await triageProject(actor('project_manager', { id: ids.pm }), {
      projectId: ids.project,
      priority: 'high',
      deadline: '2097-09-30',
      teams: [
        { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 10 },
        { departmentId: ids.design, teamLeadId: null, plannedDeliverables: 20 },
      ],
    });
    assert.equal(result.status, 'awaiting_assignment');
    assert.equal(result.assignedTeams, 1);
    assert.equal(result.totalTeams, 2);

    const [row] = await sql`SELECT status, project_manager_id, priority FROM projects WHERE id = ${ids.project}`;
    assert.equal(row.status, 'awaiting_assignment');
    assert.equal(Number(row.project_manager_id), ids.pm, 'the PM who triaged owns it');
    assert.equal(row.priority, 'high');
  });

  test('routing every team moves it to planned', async () => {
    const result = await triageProject(actor('project_manager', { id: ids.pm }), {
      projectId: ids.project,
      priority: 'high',
      teams: [
        { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 10 },
        { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 20 },
      ],
    });
    assert.equal(result.status, 'planned');

    const [row] = await sql`SELECT status, assigned_at FROM projects WHERE id = ${ids.project}`;
    assert.equal(row.status, 'planned');
    assert.ok(row.assigned_at, 'assignment time is recorded');
  });

  test('a lead cannot be given a team they do not lead', async () => {
    await assert.rejects(
      triageProject(actor('project_manager', { id: ids.pm }), {
        projectId: ids.project,
        teams: [
          { departmentId: ids.video, teamLeadId: ids.leadDesign },
          { departmentId: ids.design, teamLeadId: ids.leadDesign },
        ],
      }),
      /does not lead the team/,
      'Video work must not be routed to the Design lead',
    );
  });

  test('a project must keep at least one team', async () => {
    await assert.rejects(
      triageProject(actor('project_manager', { id: ids.pm }), { projectId: ids.project, teams: [] }),
      /at least one team/,
    );
  });

  test('the PM can add a team the project was not filed with', async () => {
    await triageProject(actor('project_manager', { id: ids.pm }), {
      projectId: ids.project,
      teams: [
        { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 10 },
        { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 20 },
        { departmentId: ids.seo, teamLeadId: ids.leadSeo, plannedDeliverables: 2 },
      ],
    });
    const rows = await sql`
      SELECT count(*)::int AS n FROM project_departments WHERE project_id = ${ids.project}`;
    assert.equal(rows[0].n, 3);
  });

  test('removing a team with work on it is refused', async () => {
    const [assignment] = await sql<{ id: number }[]>`
      INSERT INTO assignments (project_department_id, project_id, assignee_id, assigned_by, title)
      SELECT pd.id, ${ids.project}, ${ids.leadSeo}, ${ids.pm}, 'work'
      FROM project_departments pd
      WHERE pd.project_id = ${ids.project} AND pd.department_id = ${ids.seo}
      RETURNING id`;

    await assert.rejects(
      triageProject(actor('project_manager', { id: ids.pm }), {
        projectId: ids.project,
        teams: [
          { departmentId: ids.video, teamLeadId: ids.leadVideo },
          { departmentId: ids.design, teamLeadId: ids.leadDesign },
        ],
      }),
      /already has work/,
    );

    await sql`DELETE FROM assignments WHERE id = ${assignment.id}`;
  });

  test('a team with no work can be removed', async () => {
    await triageProject(actor('project_manager', { id: ids.pm }), {
      projectId: ids.project,
      teams: [
        { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 10 },
        { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 20 },
      ],
    });
    const rows = await sql`
      SELECT count(*)::int AS n FROM project_departments WHERE project_id = ${ids.project}`;
    assert.equal(rows[0].n, 2);
  });
});

describe('the milestone criterion: two teams, two queues', { skip }, () => {
  test('an unrouted team does not appear on anyone’s planning board', async () => {
    // A department on the project but without a lead is unfinished routing.
    // It belongs in the PM's intake queue, not on a planning board.
    await triageProject(actor('project_manager', { id: ids.pm }), {
      projectId: ids.project,
      teams: [
        { departmentId: ids.video, teamLeadId: null, plannedDeliverables: 10 },
        { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 20 },
      ],
    });
    const video = await planningRowsFor(ids.leadVideo);
    assert.ok(!video.some((r) => r.endsWith('/Video')), `unexpected rows: ${video.join(', ')}`);

    // Put it back for the criterion below.
    await triageProject(actor('project_manager', { id: ids.pm }), {
      projectId: ids.project,
      teams: [
        { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 10 },
        { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 20 },
      ],
    });
  });

  test('both Team Leads see the project, each only their own team', async () => {
    await triageProject(actor('project_manager', { id: ids.pm }), {
      projectId: ids.soloProject,
      teams: [{ departmentId: ids.seo, teamLeadId: ids.leadSeo, plannedDeliverables: 4 }],
    });

    const video = await planningRowsFor(ids.leadVideo);
    const design = await planningRowsFor(ids.leadDesign);
    const seo = await planningRowsFor(ids.leadSeo);

    assert.equal(video.length, 1, `video lead rows: ${video.join(', ')}`);
    assert.equal(design.length, 1, `design lead rows: ${design.join(', ')}`);

    assert.ok(video[0].endsWith('/Video'), video[0]);
    assert.ok(design[0].endsWith('/Design'), design[0]);

    // Same project, different rows — the shared project, separate queues.
    assert.equal(video[0].split('/')[0], design[0].split('/')[0]);

    assert.ok(!video.some((r) => r.includes('Design')), 'the Video lead must not see Design rows');
    assert.ok(!design.some((r) => r.includes('Video')), 'the Design lead must not see Video rows');

    // And a lead with an unrelated project sees only that one.
    assert.deepEqual(seo.map((r) => r.split('/')[1]), ['SEO']);
    assert.ok(!seo.some((r) => r.includes('Video') || r.includes('Design')));
  });
});

describe('the triage form parser', { skip: false }, () => {
  test('reads a lead per team and treats blank as unassigned', async () => {
    const mod = await import('../src/lib/projects/triage');
    const form = new FormData();
    form.append('projectId', '12');
    form.append('department', '3');
    form.append('lead_3', '99');
    form.append('planned_3', '10');
    form.append('department', '4');
    form.append('lead_4', '');
    form.append('planned_4', '0');
    form.append('priority', 'urgent');
    form.append('deadline', '2026-09-30');
    // PM QA is answered per team (brief §13): a box for team 3, none for 4.
    form.append('pmqa_3', 'on');

    const parsed = mod.parseTriageForm(form);
    assert.equal(parsed.projectId, 12);
    assert.equal(parsed.priority, 'urgent');
    assert.equal(parsed.deadline, '2026-09-30');
    assert.equal(parsed.requiresPmQa, undefined, 'the form carries no project-wide answer');
    assert.deepEqual(parsed.teams, [
      { departmentId: 3, teamLeadId: 99, plannedDeliverables: 10, requiresPmQa: true },
      { departmentId: 4, teamLeadId: null, plannedDeliverables: 0, requiresPmQa: false },
    ]);
  });
});

describe('what Sales entered survives triage', { skip }, () => {
  test('routing without a deadline, notes or QA policy keeps the ones filed at intake', async () => {
    const filed = await fileProject(actor('sales', { id: ids.sales }), {
      clientId: ids.client, period: '2097-10', title: 'Filed with details',
      deadline: '2097-10-15', internalNotes: 'Rush job — client launch.', requiresPmQa: false,
      departments: [{ departmentId: ids.seo, plannedDeliverables: 2 }],
    });

    await triageProject(actor('project_manager', { id: ids.pm }), {
      projectId: filed.projectId,
      teams: [{ departmentId: ids.seo, teamLeadId: ids.leadSeo, plannedDeliverables: 2 }],
    });

    const [row] = await sql<{ deadline: string | null; internal_notes: string | null; requires_pm_qa: boolean }[]>`
      SELECT to_char(deadline, 'YYYY-MM-DD') AS deadline, internal_notes, requires_pm_qa
      FROM projects WHERE id = ${filed.projectId}`;
    assert.equal(row.deadline, '2097-10-15', 'the PM did not touch the deadline, so it stays');
    assert.equal(row.internal_notes, 'Rush job — client launch.');
    assert.equal(row.requires_pm_qa, false, 'Sales chose no PM QA; silence from the PM is not a reversal');
  });
});

describe('the per-team QA policy survives triage (brief §13)', { skip }, () => {
  test('a team routed without a QA decision inherits the project’s, and keeps it on re-triage', async () => {
    const filed = await fileProject(actor('sales', { id: ids.sales }), {
      clientId: ids.client, period: '2097-11', title: 'No PM QA', requiresPmQa: false,
      departments: [{ departmentId: ids.seo, plannedDeliverables: 1 }],
    });
    const route = () => triageProject(actor('project_manager', { id: ids.pm }), {
      projectId: filed.projectId,
      teams: [{ departmentId: ids.seo, teamLeadId: ids.leadSeo, plannedDeliverables: 1 }],
    });
    await route();
    await route();
    const [row] = await sql`SELECT requires_pm_qa FROM project_departments WHERE project_id = ${filed.projectId}`;
    assert.equal(row.requires_pm_qa, false);
  });
});

describe('the intake queue (brief §4, §5)', { skip }, () => {
  test('holds unrouted projects, and one under way while a team still has no lead', async () => {
    const pm = actor('project_manager', { id: ids.pm });
    const filed = await fileProject(actor('sales', { id: ids.sales }), {
      clientId: ids.client, period: '2097-12', title: 'Under way, half routed',
      departments: [
        { departmentId: ids.video, plannedDeliverables: 1 },
        { departmentId: ids.design, plannedDeliverables: 1 },
      ],
    });
    const queued = async () => (await intakeQueue(pm)).find((p) => p.id === filed.projectId);
    assert.equal((await queued())?.status, 'new');

    const halfRouted = [
      { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 },
      { departmentId: ids.design, teamLeadId: null, plannedDeliverables: 1 },
    ];
    await triageProject(pm, { projectId: filed.projectId, teams: halfRouted });
    assert.equal((await queued())?.unassigned, 1);

    // Work has started on Video: the status follows the work from here
    // (qa/project-status), so only the missing lead keeps it in the queue.
    await sql`UPDATE projects SET status = 'in_progress' WHERE id = ${filed.projectId}`;
    const row = await queued();
    assert.equal(row?.status, 'in_progress');
    assert.equal(row?.teams, 'Video, Design');

    await triageProject(pm, {
      projectId: filed.projectId,
      teams: [
        { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 },
        { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 1 },
      ],
    });
    assert.equal(await queued(), undefined, 'every team has a lead');

    await triageProject(pm, { projectId: filed.projectId, teams: halfRouted });
    assert.ok(await queued(), 'a lead taken away puts it back');
    await sql`UPDATE projects SET status = 'cancelled' WHERE id = ${filed.projectId}`;
    assert.equal(await queued(), undefined, 'a cancelled project is nobody’s to route');
  });

  test('and one whose other teams have finished while a routed team has planned nothing', async () => {
    const pm = actor('project_manager', { id: ids.pm });
    const leadVideo = actor('team_lead', { id: ids.leadVideo, leadDepartmentIds: [ids.video], departmentIds: [ids.video] });
    const leadDesign = actor('team_lead', { id: ids.leadDesign, leadDepartmentIds: [ids.design], departmentIds: [ids.design] });
    const filed = await fileProject(actor('sales', { id: ids.sales }), {
      clientId: ids.client, period: '2097-12', title: 'Held up by Design',
      departments: [
        { departmentId: ids.video, plannedDeliverables: 1 },
        { departmentId: ids.design, plannedDeliverables: 1 },
      ],
    });
    await triageProject(pm, {
      projectId: filed.projectId,
      teams: [
        { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 },
        { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 1 },
      ],
    });
    const queued = async () => (await intakeQueue(pm)).find((p) => p.id === filed.projectId);
    assert.equal(await queued(), undefined, 'fully routed: nobody’s to route');

    // Video plans and makes its slot while Design's lead plans nothing. The
    // slot's progress is set directly; the derivation it stands in for is
    // covered in status.test.ts.
    const teamOf = async (departmentId: number) => Number((await sql`
      SELECT id FROM project_departments WHERE project_id = ${filed.projectId} AND department_id = ${departmentId}`)[0].id);
    const { deliverableIds: [slot] } = await createAssignment(leadVideo, {
      projectDepartmentId: await teamOf(ids.video), assigneeId: ids.leadVideo, title: 'Cut', deliverableCount: 1,
    });
    await sql`UPDATE projects SET status = 'in_progress' WHERE id = ${filed.projectId}`;
    assert.equal(await queued(), undefined, 'Video is still making it: Design’s lead has time');

    await sql`UPDATE deliverables SET status = 'approved' WHERE id = ${slot}`;
    const row = await queued();
    assert.equal(row?.unplanned, 1, 'the rest is signed off; Design holds it up');
    assert.equal(row?.unassigned, 0);

    await createAssignment(leadDesign, {
      projectDepartmentId: await teamOf(ids.design), assigneeId: ids.leadDesign, title: 'Thumb', deliverableCount: 1,
    });
    assert.equal(await queued(), undefined, 'planned: the project can finish');
  });

  test('is the Project Manager’s: Sales and Team Leads get nothing', async () => {
    assert.deepEqual(await intakeQueue(actor('sales', { id: ids.sales })), []);
    assert.deepEqual(await intakeQueue(actor('team_lead', { id: ids.leadVideo, leadDepartmentIds: [ids.video] })), []);
  });
});
