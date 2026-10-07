/**
 * The sales pipeline (brief §29): deals before they are confirmed, on the
 * same permanent client record, won by filing their project.
 *
 * Needs DATABASE_URL pointing at a migrated database.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import postgres from 'postgres';
import type { Actor, Permission, Role } from '../src/lib/authz/types';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run pipeline tests';

let sql: ReturnType<typeof postgres>;
let pipeline: typeof import('../src/lib/pipeline/opportunities');
let fileProject: typeof import('../src/lib/projects/file-project').fileProject;

const ids: Record<string, number> = {};
const DOMAIN = '@pipetest.local';

function actor(role: Role, id: number): Actor {
  return {
    id, email: `${role}${DOMAIN}`, fullName: role, role, isActive: true, mustChangePassword: false,
    leadDepartmentIds: [], departmentIds: [], permissions: new Set<Permission>(),
  };
}
const sales = () => actor('sales', ids.sales);
const rival = () => actor('sales', ids.rival);
const pm = () => actor('project_manager', ids.pm);
const coo = () => actor('coo', ids.coo);

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE ${'%' + DOMAIN}`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM opportunities WHERE owner_user_id IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'Pipe Test%')`;
  await sql`DELETE FROM clients WHERE name LIKE 'Pipe Test%'`;
  await sql`DELETE FROM notifications WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE ${'%' + DOMAIN}`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2096`;
}

const file = (who: Actor, clientId: number, opportunityId: number | null) => fileProject(who, {
  clientId, period: '2096-02', title: 'Retainer', opportunityId,
  departments: [{ departmentId: ids.video, plannedDeliverables: 4 }],
});

before(async () => {
  if (skip) return;
  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });
  pipeline = await import('../src/lib/pipeline/opportunities');
  ({ fileProject } = await import('../src/lib/projects/file-project'));
  await purge();
  ids.video = Number((await sql`SELECT id FROM departments WHERE slug = 'video'`)[0].id);
  for (const [key, role] of [['sales', 'sales'], ['rival', 'sales'], ['pm', 'project_manager'], ['coo', 'coo']] as const) {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES (${key + DOMAIN}, 'x', ${key}, ${role}) RETURNING id`;
    ids[key] = Number(row.id);
  }
  for (const [key, name, owner, status] of [
    ['prospect', 'Pipe Test Prospect', ids.sales, 'prospect'],
    ['other', 'Pipe Test Other', ids.sales, 'active'],
    ['rivals', 'Pipe Test Rivals', ids.rival, 'active'],
  ] as const) {
    const [c] = await sql<{ id: number }[]>`
      INSERT INTO clients (name, owner_user_id, created_by, status) VALUES (${name}, ${owner}, ${owner}, ${status}) RETURNING id`;
    ids[key] = Number(c.id);
  }
});

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
});

describe('the sales pipeline (brief §29)', { skip }, () => {
  test('a rep tracks a deal on their own client; others cannot see or touch it', async () => {
    const { id } = await pipeline.createOpportunity(sales(), {
      clientId: ids.prospect, title: 'Social retainer', estimatedValue: 12000, expectedClose: '2096-02-15',
    });
    assert.ok((await pipeline.listOpportunities(sales())).some((o) => o.id === id));
    assert.ok((await pipeline.listOpportunities(coo())).some((o) => o.id === id), 'management sees every deal');
    assert.equal((await pipeline.listOpportunities(rival())).some((o) => o.id === id), false);
    assert.deepEqual(await pipeline.listOpportunities(pm()), []);
    await assert.rejects(pipeline.moveOpportunity(rival(), { id, stage: 'proposal' }), /No such opportunity/);
    await assert.rejects(pipeline.createOpportunity(pm(), { clientId: ids.prospect, title: 'X deal' }), /not permitted/);
    await assert.rejects(pipeline.createOpportunity(sales(), { clientId: ids.rivals, title: 'Poach' }), /Choose a client/);
  });

  test('stages move freely while open; won is by filing and lost needs a reason', async () => {
    const { id } = await pipeline.createOpportunity(sales(), { clientId: ids.other, title: 'SEO audit', estimatedValue: 4000 });
    await pipeline.moveOpportunity(sales(), { id, stage: 'negotiation' });
    await pipeline.moveOpportunity(sales(), { id, stage: 'proposal' });
    await assert.rejects(pipeline.moveOpportunity(sales(), { id, stage: 'won' }), /filing its project/);
    await assert.rejects(pipeline.moveOpportunity(sales(), { id, stage: 'lost' }), /reason/);
    await assert.rejects(pipeline.loseOpportunity(sales(), { id, reason: '  ' }), /Say why/);
    await pipeline.loseOpportunity(sales(), { id, reason: 'Went with an agency in Riyadh' });
    await assert.rejects(pipeline.moveOpportunity(sales(), { id, stage: 'lead' }), /already lost/);
    await assert.rejects(file(sales(), ids.other, id), /already closed/);
  });

  test('filing the project wins the deal, links them, and activates the prospect', async () => {
    const { id } = await pipeline.createOpportunity(sales(), { clientId: ids.prospect, title: 'Launch film', estimatedValue: 8000 });
    const project = await file(sales(), ids.prospect, id);
    const [o] = await sql`SELECT stage, won_project_id, closed_at FROM opportunities WHERE id = ${id}`;
    assert.equal(o.stage, 'won');
    assert.equal(Number(o.won_project_id), project.projectId);
    assert.ok(o.closed_at);
    const [c] = await sql`SELECT status FROM clients WHERE id = ${ids.prospect}`;
    assert.equal(c.status, 'active');
    const won = (await pipeline.getOpportunity(sales(), id))!;
    assert.equal(won.wonProjectCode, project.projectCode);
  });

  test('a deal for another client is refused, and nothing is filed', async () => {
    const { id } = await pipeline.createOpportunity(sales(), { clientId: ids.other, title: 'Web refresh' });
    const before = Number((await sql`SELECT count(*) FROM projects WHERE client_id = ${ids.prospect}`)[0].count);
    await assert.rejects(file(sales(), ids.prospect, id), /different client/);
    const after = Number((await sql`SELECT count(*) FROM projects WHERE client_id = ${ids.prospect}`)[0].count);
    assert.equal(after, before, 'the project rolled back with the refusal');
    const [o] = await sql`SELECT stage FROM opportunities WHERE id = ${id}`;
    assert.equal(o.stage, 'lead');
  });

  test('stage totals weight each deal by its stage', () => {
    const base = { clientId: 1, clientName: '', clientStatus: 'active', owner: '', title: '', currency: 'AED',
      expectedClose: null, notes: null, lostReason: null, wonProjectId: null, wonProjectCode: null, closedAt: null, overdue: false };
    const totals = pipeline.stageTotals([
      { ...base, id: 1, stage: 'lead', estimatedValue: 1000 },
      { ...base, id: 2, stage: 'proposal', estimatedValue: 4000 },
      { ...base, id: 3, stage: 'proposal', estimatedValue: null },
    ]);
    assert.deepEqual(totals.map((t) => [t.stage, t.count, t.value, t.weighted]), [
      ['lead', 1, 1000, 100], ['qualified', 0, 0, 0], ['proposal', 2, 4000, 2000], ['negotiation', 0, 0, 0],
    ]);
  });
});
