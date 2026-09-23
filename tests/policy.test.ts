/**
 * Row-visibility matrix against a real PostgreSQL.
 *
 * This is the regression net for brief §23 and §22. For every role it asserts
 * BOTH directions — the rows that must be visible and the rows that must not —
 * because a scope rule that is too wide fails silently in a way no feature
 * test would catch.
 *
 * Runs only when DATABASE_URL points at a migrated database. All work happens
 * inside one transaction that is rolled back, so it leaves nothing behind.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { clientScope, projectScope } from '../src/lib/authz/scope';
import type { Actor, Permission, Role } from '../src/lib/authz/types';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL
  ? false
  : 'set DATABASE_URL to a migrated database to run the policy matrix';

const dialect = new PgDialect();
let db: ReturnType<typeof postgres>;

const ids: Record<string, number> = {};

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0,
    email: `${role}@test.local`,
    fullName: role,
    role,
    isActive: true,
    mustChangePassword: false,
    leadDepartmentIds: [],
    departmentIds: [],
    permissions: new Set<Permission>(),
    ...over,
  };
}

/**
 * Project codes visible to this actor, sorted — the assertion surface.
 *
 * Restricted to this fixture's own rows so the matrix holds against a database
 * that already contains data. Within that universe both directions are still
 * proven exactly: what the actor sees, and what they do not.
 */
async function visibleProjects(a: Actor): Promise<string[]> {
  const q = dialect.sqlToQuery(
    sql`SELECT project_code FROM projects
        WHERE ${projectScope(a)} AND project_code LIKE 'TEST-%'
        ORDER BY project_code`,
  );
  const rows = await db.unsafe<{ project_code: string }[]>(q.sql, q.params as never[]);
  return rows.map((r) => r.project_code);
}

async function visibleClients(a: Actor): Promise<string[]> {
  const q = dialect.sqlToQuery(
    sql`SELECT name FROM clients
        WHERE ${clientScope(a)} AND name LIKE 'Policy Test %'
        ORDER BY name`,
  );
  const rows = await db.unsafe<{ name: string }[]>(q.sql, q.params as never[]);
  return rows.map((r) => r.name);
}

before(async () => {
  if (skip) return;
  db = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });
  await db.unsafe('BEGIN');

  const one = async (text: string) => (await db.unsafe(text))[0] as Record<string, number>;

  const dept = async (slug: string) =>
    Number((await db.unsafe(`SELECT id FROM departments WHERE slug = '${slug}'`))[0].id);
  ids.video = await dept('video');
  ids.design = await dept('design');
  ids.seo = await dept('seo');

  const mkUser = async (key: string, role: string) => {
    const row = await one(`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES ('${key}@test.local', 'x', '${key}', '${role}') RETURNING id`);
    ids[key] = Number(row.id);
  };

  await mkUser('ceo', 'ceo');
  await mkUser('pm', 'project_manager');
  await mkUser('salesA', 'sales');
  await mkUser('salesB', 'sales');
  await mkUser('leadVideo', 'team_lead');
  await mkUser('leadDesign', 'team_lead');
  await mkUser('execAhmed', 'executive');
  await mkUser('execSara', 'executive');
  await mkUser('execOmar', 'executive');

  const mkClient = async (key: string, name: string, owner: number) => {
    const row = await one(`
      INSERT INTO clients (name, owner_user_id, created_by)
      VALUES ('${name}', ${owner}, ${owner}) RETURNING id`);
    ids[key] = Number(row.id);
  };
  await mkClient('abc', 'Policy Test ABC', ids.salesA);
  await mkClient('xyz', 'Policy Test XYZ', ids.salesB);

  const mkMonth = async (key: string, clientId: number, owner: number) => {
    const row = await one(`
      INSERT INTO client_months (client_id, period_year, period_month, created_by)
      VALUES (${clientId}, 2026, 9, ${owner}) RETURNING id`);
    ids[key] = Number(row.id);
  };
  await mkMonth('monthAbc', ids.abc, ids.salesA);
  await mkMonth('monthXyz', ids.xyz, ids.salesB);

  const mkProject = async (
    key: string, code: string, clientId: number, monthId: number, owner: number,
  ) => {
    const row = await one(`
      INSERT INTO projects (project_code, client_id, client_month_id, title, sales_owner_id, created_by)
      VALUES ('${code}', ${clientId}, ${monthId}, '${key}', ${owner}, ${owner}) RETURNING id`);
    ids[key] = Number(row.id);
  };
  // P1: ABC, needs Video AND Design — the multi-department case from §10.
  await mkProject('p1', 'TEST-0001', ids.abc, ids.monthAbc, ids.salesA);
  // P2: XYZ, Video only, a different sales rep.
  await mkProject('p2', 'TEST-0002', ids.xyz, ids.monthXyz, ids.salesB);
  // P3: ABC, SEO only.
  await mkProject('p3', 'TEST-0003', ids.abc, ids.monthAbc, ids.salesA);

  const mkPd = async (key: string, projectId: number, deptId: number, lead: number) => {
    const row = await one(`
      INSERT INTO project_departments (project_id, department_id, team_lead_id)
      VALUES (${projectId}, ${deptId}, ${lead}) RETURNING id`);
    ids[key] = Number(row.id);
  };
  await mkPd('p1video', ids.p1, ids.video, ids.leadVideo);
  await mkPd('p1design', ids.p1, ids.design, ids.leadDesign);
  await mkPd('p2video', ids.p2, ids.video, ids.leadVideo);
  await mkPd('p3seo', ids.p3, ids.seo, ids.leadVideo);

  const mkAssignment = async (pdKey: string, projectKey: string, assignee: number) => {
    await db.unsafe(`
      INSERT INTO assignments (project_department_id, project_id, assignee_id, assigned_by, title)
      VALUES (${ids[pdKey]}, ${ids[projectKey]}, ${assignee}, ${ids.pm}, 'work')`);
  };
  await mkAssignment('p1video', 'p1', ids.execAhmed);
  await mkAssignment('p1design', 'p1', ids.execSara);
  await mkAssignment('p3seo', 'p3', ids.execOmar);
  // P2 is deliberately left unassigned: a Team Lead must still see it.
});

after(async () => {
  if (skip || !db) return;
  await db.unsafe('ROLLBACK');
  await db.end();
});

describe('project visibility (brief §23)', { skip }, () => {
  test('CEO sees every project', async () => {
    assert.deepEqual(await visibleProjects(actor('ceo', { id: ids.ceo })), [
      'TEST-0001', 'TEST-0002', 'TEST-0003',
    ]);
  });

  test('Project Manager sees every project, across all departments (§6)', async () => {
    assert.deepEqual(await visibleProjects(actor('project_manager', { id: ids.pm })), [
      'TEST-0001', 'TEST-0002', 'TEST-0003',
    ]);
  });

  test('Sales sees their own clients’ projects and not a colleague’s', async () => {
    assert.deepEqual(await visibleProjects(actor('sales', { id: ids.salesA })), [
      'TEST-0001', 'TEST-0003',
    ]);
    assert.deepEqual(await visibleProjects(actor('sales', { id: ids.salesB })), ['TEST-0002']);
  });

  test('a Team Lead sees projects with work in the departments they lead', async () => {
    const video = actor('team_lead', { id: ids.leadVideo, leadDepartmentIds: [ids.video] });
    // P2 has no assignments yet — a lead must still see it in order to plan it.
    assert.deepEqual(await visibleProjects(video), ['TEST-0001', 'TEST-0002']);

    const design = actor('team_lead', { id: ids.leadDesign, leadDepartmentIds: [ids.design] });
    assert.deepEqual(await visibleProjects(design), ['TEST-0001']);
  });

  test('a Team Lead leading two departments sees the union', async () => {
    const both = actor('team_lead', {
      id: ids.leadVideo,
      leadDepartmentIds: [ids.video, ids.design],
    });
    assert.deepEqual(await visibleProjects(both), ['TEST-0001', 'TEST-0002']);
  });

  test('a Team Lead with no team sees nothing', async () => {
    assert.deepEqual(await visibleProjects(actor('team_lead', { id: ids.leadVideo })), []);
  });

  test('an Executive sees only projects they are assigned to', async () => {
    assert.deepEqual(await visibleProjects(actor('executive', { id: ids.execAhmed })), ['TEST-0001']);
    assert.deepEqual(await visibleProjects(actor('executive', { id: ids.execOmar })), ['TEST-0003']);
  });

  test('the shared workspace is project-wide, not department-wide (§10)', async () => {
    // Ahmed works Video on P1; Sara works Design on the same project. Both see
    // P1 — that is what makes the shared workspace possible — and neither
    // gains any project they are not assigned to.
    const ahmed = await visibleProjects(actor('executive', { id: ids.execAhmed }));
    const sara = await visibleProjects(actor('executive', { id: ids.execSara }));
    assert.deepEqual(ahmed, ['TEST-0001']);
    assert.deepEqual(sara, ['TEST-0001']);
  });

  test('a deactivated user sees nothing, whatever their role', async () => {
    assert.deepEqual(await visibleProjects(actor('ceo', { id: ids.ceo, isActive: false })), []);
    assert.deepEqual(
      await visibleProjects(actor('project_manager', { id: ids.pm, isActive: false })),
      [],
    );
  });
});

describe('scope fragments work under a table alias', { skip }, () => {
  // Page queries alias their tables (FROM projects p), and an alias shadows
  // the table name. A fragment that hard-codes "projects." fails with
  // "missing FROM-clause entry" only in the aliased queries, so the unaliased
  // tests above cannot catch it.
  test('projectScope correlates against the alias it is given', async () => {
    const sales = actor('sales', { id: ids.salesA });
    const q = dialect.sqlToQuery(sql`
      SELECT p.project_code FROM projects p
      JOIN clients c ON c.id = p.client_id
      WHERE ${projectScope(sales, 'p')} AND p.project_code LIKE 'TEST-%'
      ORDER BY p.project_code`);
    const rows = await db.unsafe<{ project_code: string }[]>(q.sql, q.params as never[]);
    assert.deepEqual(rows.map((r) => r.project_code), ['TEST-0001', 'TEST-0003']);
  });

  test('clientScope correlates against the alias it is given', async () => {
    const sales = actor('sales', { id: ids.salesB });
    const q = dialect.sqlToQuery(sql`
      SELECT c.name FROM clients c
      WHERE ${clientScope(sales, 'c')} AND c.name LIKE 'Policy Test %'
      ORDER BY c.name`);
    const rows = await db.unsafe<{ name: string }[]>(q.sql, q.params as never[]);
    assert.deepEqual(rows.map((r) => r.name), ['Policy Test XYZ']);
  });

  test('an unsafe alias is refused outright', () => {
    assert.throws(() => projectScope(actor('sales', { id: 1 }), 'p; DROP TABLE users'), /Unsafe SQL alias/);
  });
});

describe('client visibility (brief §31, §33)', { skip }, () => {
  test('Sales sees their own clients only', async () => {
    assert.deepEqual(await visibleClients(actor('sales', { id: ids.salesA })), ['Policy Test ABC']);
    assert.deepEqual(await visibleClients(actor('sales', { id: ids.salesB })), ['Policy Test XYZ']);
  });

  test('the view_all_clients grant widens Sales to every client', async () => {
    const widened = actor('sales', {
      id: ids.salesA,
      permissions: new Set<Permission>(['view_all_clients']),
    });
    assert.deepEqual(await visibleClients(widened), ['Policy Test ABC', 'Policy Test XYZ']);
  });

  test('a Team Lead reaches a client through their department’s work', async () => {
    const video = actor('team_lead', { id: ids.leadVideo, leadDepartmentIds: [ids.video] });
    assert.deepEqual(await visibleClients(video), ['Policy Test ABC', 'Policy Test XYZ']);

    const design = actor('team_lead', { id: ids.leadDesign, leadDepartmentIds: [ids.design] });
    assert.deepEqual(await visibleClients(design), ['Policy Test ABC']);
  });

  test('an Executive reaches only clients they have worked for', async () => {
    assert.deepEqual(await visibleClients(actor('executive', { id: ids.execAhmed })), [
      'Policy Test ABC',
    ]);
    assert.deepEqual(await visibleClients(actor('executive', { id: ids.execOmar })), [
      'Policy Test ABC',
    ]);
  });

  test('a deactivated user reaches no client', async () => {
    assert.deepEqual(await visibleClients(actor('ceo', { id: ids.ceo, isActive: false })), []);
  });
});
