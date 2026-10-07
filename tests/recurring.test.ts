/**
 * Recurring projects (brief §29): orders marked "repeats every month" are
 * copied into each new month by a job, as their Sales owner, exactly once.
 *
 * Uses the months of 2095 so no other suite's work is in range.
 *
 * Needs DATABASE_URL pointing at a migrated database.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import postgres from 'postgres';
import type { Actor, Permission, Role } from '../src/lib/authz/types';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run recurring tests';

let sql: ReturnType<typeof postgres>;
let runRecurring: typeof import('../src/lib/projects/recurring').runRecurring;
let fileProject: typeof import('../src/lib/projects/file-project').fileProject;
let changeProjectStatus: typeof import('../src/lib/projects/status').changeProjectStatus;
let triageProject: typeof import('../src/lib/projects/triage').triageProject;
let projectActivity: typeof import('../src/lib/activity/feed').projectActivity;

const ids: Record<string, number> = {};
const DOMAIN = '@recurtest.local';
const at = (month: number) => new Date(Date.UTC(2095, month - 1, 1, 3));
/** Held to this suite's clients, so another suite's recurring orders and these never reach each other. */
const own = () => ({ clientIds: [ids.client, ids.paused, ids.orphan] });

function actor(role: Role, id: number): Actor {
  return {
    id, email: `${role}${DOMAIN}`, fullName: role, role, isActive: true, mustChangePassword: false,
    leadDepartmentIds: [], departmentIds: [], permissions: new Set<Permission>(),
  };
}
const sales = () => actor('sales', ids.sales);
const leaver = () => actor('sales', ids.leaver);
const pm = () => actor('project_manager', ids.pm);

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE ${'%' + DOMAIN}`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  // Children first: copies point at their sources.
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'Recur Test%') AND copied_from_project_id IS NOT NULL`;
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'Recur Test%')`;
  await sql`DELETE FROM clients WHERE name LIKE 'Recur Test%'`;
  await sql`DELETE FROM notifications WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE ${'%' + DOMAIN}`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2095`;
}

async function order(who: Actor, clientId: number, title: string, recurs: boolean) {
  const p = await fileProject(who, {
    clientId, period: '2095-01', title, recursMonthly: recurs, deadline: '2095-01-31', priceAmount: '900.00',
    requirements: '10 reels', departments: [{ departmentId: ids.video, plannedDeliverables: 10 }],
  });
  return p.projectId;
}

const copiesOf = (projectId: number) => sql<{
  id: number; project_code: string; status: string; recurs_monthly: boolean; deadline: string;
  price_amount: string; requirements: string; period_month: number; planned: number; sales_owner_id: number;
}[]>`
  SELECT p.id, p.project_code, p.status, p.recurs_monthly, p.deadline::text AS deadline,
         p.price_amount::text AS price_amount, p.requirements, cm.period_month, p.sales_owner_id,
         (SELECT planned_deliverables FROM project_departments WHERE project_id = p.id) AS planned
  FROM projects p JOIN client_months cm ON cm.id = p.client_month_id
  WHERE p.copied_from_project_id = ${projectId}`;

before(async () => {
  if (skip) return;
  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });
  ({ runRecurring } = await import('../src/lib/projects/recurring'));
  ({ fileProject } = await import('../src/lib/projects/file-project'));
  ({ changeProjectStatus } = await import('../src/lib/projects/status'));
  ({ triageProject } = await import('../src/lib/projects/triage'));
  ({ projectActivity } = await import('../src/lib/activity/feed'));
  await purge();
  for (const slug of ['video', 'design']) {
    ids[slug] = Number((await sql`SELECT id FROM departments WHERE slug = ${slug}`)[0].id);
  }
  for (const [key, role] of [['sales', 'sales'], ['leaver', 'sales'], ['pm', 'project_manager']] as const) {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES (${key + DOMAIN}, 'x', ${key}, ${role}) RETURNING id`;
    ids[key] = Number(row.id);
  }
  for (const [key, name, owner, status] of [
    ['client', 'Recur Test Client', ids.sales, 'active'],
    ['paused', 'Recur Test Paused', ids.sales, 'paused'],
    ['orphan', 'Recur Test Orphan', ids.leaver, 'active'],
    ['mixed', 'Recur Test Mixed QA', ids.sales, 'active'],
  ] as const) {
    const [c] = await sql<{ id: number }[]>`
      INSERT INTO clients (name, owner_user_id, created_by, status)
      VALUES (${name}, ${owner}, ${owner}, ${status}) RETURNING id`;
    ids[key] = Number(c.id);
  }
  ids.repeating = await order(sales(), ids.client, 'Monthly reels', true);
  ids.oneOff = await order(sales(), ids.client, 'Launch film', false);
  ids.cancelled = await order(sales(), ids.client, 'Dropped retainer', true);
  await changeProjectStatus(pm(), { projectId: ids.cancelled, change: 'cancel', reason: 'Ended' });
  ids.pausedOrder = await order(sales(), ids.paused, 'Paused reels', true);
  ids.orphanOrder = await order(leaver(), ids.orphan, 'Orphan reels', true);
  await sql`UPDATE users SET is_active = false WHERE id = ${ids.leaver}`;

  // A retainer on a client of its own (outside `own()`), whose PM decided at
  // triage that Video's reels go to them before delivery and Design's stills
  // do not (§13) — while the intake default, as Sales filed it, says neither.
  const mixed = await fileProject(sales(), {
    clientId: ids.mixed, period: '2095-01', title: 'Reels and stills', recursMonthly: true, requiresPmQa: false,
    departments: [
      { departmentId: ids.video, plannedDeliverables: 8 },
      { departmentId: ids.design, plannedDeliverables: 4 },
    ],
  });
  ids.mixedOrder = mixed.projectId;
  await triageProject(pm(), {
    projectId: ids.mixedOrder,
    teams: [
      { departmentId: ids.video, teamLeadId: null, plannedDeliverables: 8, requiresPmQa: true },
      { departmentId: ids.design, teamLeadId: null, plannedDeliverables: 4, requiresPmQa: false },
    ],
  });
});

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
});

describe('recurring projects (brief §29)', { skip }, () => {
  test('the new month gets one copy of each live recurring order, and nothing else', async () => {
    const outcome = await runRecurring(at(2), own());
    const mine = outcome.created.filter((c) => c.clientName.startsWith('Recur Test'));
    assert.deepEqual(mine.map((c) => c.clientName), ['Recur Test Client']);

    const [copy] = await copiesOf(ids.repeating);
    assert.equal(copy.period_month, 2);
    assert.equal(copy.status, 'new', 'it lands in the Project Manager’s intake');
    assert.equal(copy.recurs_monthly, true, 'the chain continues');
    assert.equal(copy.deadline, '2095-02-28', 'the deadline moves with the month, clamped');
    assert.equal(Number(copy.price_amount), 900);
    assert.equal(copy.requirements, '10 reels');
    assert.equal(copy.planned, 10);
    assert.equal(Number(copy.sales_owner_id), ids.sales);
    assert.match(copy.project_code, /^AKT-2095-\d{4}$/);

    for (const id of [ids.oneOff, ids.cancelled, ids.pausedOrder, ids.orphanOrder]) {
      assert.equal((await copiesOf(id)).length, 0);
    }
    const reasons = Object.fromEntries(outcome.skipped.filter((s) => s.clientName.startsWith('Recur Test'))
      .map((s) => [s.clientName, s.reason]));
    assert.match(reasons['Recur Test Paused'], /paused/);
    assert.match(reasons['Recur Test Orphan'], /no longer active/);
  });

  test('the people concerned are told, and the feed says it was automatic', async () => {
    const [copy] = await copiesOf(ids.repeating);
    const owner = await sql`SELECT 1 FROM notifications WHERE user_id = ${ids.sales} AND type = 'project.recurring_created' AND entity_id = ${copy.id}`;
    assert.equal(owner.length, 1);
    const intake = await sql`SELECT 1 FROM notifications WHERE user_id = ${ids.pm} AND entity_id = ${copy.id}`;
    assert.ok(intake.length >= 1, 'the PM hears about a new order as for any other');
    const skipped = await sql`SELECT 1 FROM notifications WHERE user_id = ${ids.pm} AND type = 'project.recurring_skipped' AND entity_id = ${ids.orphanOrder}`;
    assert.equal(skipped.length, 1);
    const paused = await sql`SELECT 1 FROM notifications WHERE type = 'project.recurring_skipped' AND entity_id = ${ids.pausedOrder}`;
    assert.equal(paused.length, 0, 'a paused client is skipped quietly');
    const feed = await projectActivity(Number(copy.id));
    assert.ok(feed.some((l) => /recurring order was filed automatically/.test(l.text)), feed.map((l) => l.text).join('\n'));
  });

  test('running again the same month does nothing', async () => {
    await runRecurring(at(2), own());
    assert.equal((await copiesOf(ids.repeating)).length, 1);
  });

  test('held to other clients, the run leaves the chain alone', async () => {
    const outcome = await runRecurring(at(3), { clientIds: [ids.paused] });
    assert.equal(outcome.created.some((c) => c.clientName.startsWith('Recur Test')), false);
    const [feb] = await copiesOf(ids.repeating);
    assert.equal((await copiesOf(Number(feb.id))).length, 0, 'no March link');
    assert.deepEqual(await runRecurring(at(3), { clientIds: [] }), { created: [], skipped: [] }, 'held to no client: nothing at all');
  });

  test('a missed month is caught up from the newest link, not the original', async () => {
    const [feb] = await copiesOf(ids.repeating);
    await runRecurring(at(4), own());
    const [apr] = await copiesOf(Number(feb.id));
    assert.equal(apr.period_month, 4);
    assert.equal(apr.deadline, '2095-04-28', 'shifted two months from 28 February');
    assert.equal((await copiesOf(ids.repeating)).length, 1);
  });

  test('clearing the flag ends the chain; a closed month is reported, not filled', async () => {
    const [feb] = await copiesOf(ids.repeating);
    const [apr] = await copiesOf(Number(feb.id));
    await sql`UPDATE projects SET recurs_monthly = false WHERE id = ${apr.id}`;
    await runRecurring(at(5), own());
    assert.equal((await copiesOf(Number(apr.id))).length, 0);

    await sql`UPDATE projects SET recurs_monthly = true WHERE id = ${apr.id}`;
    const [m] = await sql<{ id: number }[]>`
      INSERT INTO client_months (client_id, period_year, period_month, status, closed_at, closed_by, created_by)
      VALUES (${ids.client}, 2095, 6, 'closed', now(), ${ids.pm}, ${ids.pm}) RETURNING id`;
    const outcome = await runRecurring(at(6), own());
    assert.equal((await copiesOf(Number(apr.id))).length, 0);
    assert.ok(outcome.skipped.some((s) => s.sourceCode === (apr.project_code) && /closed/i.test(s.reason)));
    await sql`DELETE FROM client_months WHERE id = ${m.id}`;
  });

  test('each team’s QA route travels with the recurring copy, not the project default', async () => {
    const outcome = await runRecurring(at(2), { clientIds: [ids.mixed] });
    const [source] = await sql<{ project_code: string }[]>`SELECT project_code FROM projects WHERE id = ${ids.mixedOrder}`;
    assert.deepEqual(outcome.created.map((c) => c.sourceCode), [source.project_code]);

    const [copy] = await sql<{ id: number; requires_pm_qa: boolean }[]>`
      SELECT id, requires_pm_qa FROM projects WHERE copied_from_project_id = ${ids.mixedOrder}`;
    assert.equal(copy.requires_pm_qa, false, 'the intake default is copied as it was filed');
    const teams = await sql<{ slug: string; planned_deliverables: number; requires_pm_qa: boolean }[]>`
      SELECT d.slug, pd.planned_deliverables, pd.requires_pm_qa FROM project_departments pd
      JOIN departments d ON d.id = pd.department_id WHERE pd.project_id = ${copy.id} ORDER BY d.sort_order`;
    assert.deepEqual(
      teams.map((t) => [t.slug, Number(t.planned_deliverables), t.requires_pm_qa === true]),
      [['video', 8, true], ['design', 4, false]],
      'Video still goes to the PM and Design still does not (§13)',
    );
  });
});
