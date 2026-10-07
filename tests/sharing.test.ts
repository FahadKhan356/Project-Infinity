/**
 * Sharing a project with a Sales rep (brief §23: Sales see "projects they
 * create/are authorized to view").
 *
 * The scope rule itself is proven in policy.test.ts; this suite covers who
 * may share, with whom, what the rep is told and when it is refused — and
 * that a share only ever lets the rep read: every change to the project or
 * its client is still refused, and none of it counts as their own book.
 *
 * Needs DATABASE_URL pointing at a migrated database. Projects are inserted
 * directly with codes W1S-2084-…, outside every other suite's pattern, so no
 * code sequence is touched and no other suite's exact lists see them.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import postgres from 'postgres';
import type { Actor, Permission, Role } from '../src/lib/authz/types';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run sharing tests';

let sql: ReturnType<typeof postgres>;
let viewers: typeof import('../src/lib/projects/viewers');
/** May `a` read the project, counting shares? */
let readable: (a: Actor, projectId: number) => Promise<boolean>;
/** May `a` act on it — the scope every change and every own-book count uses? */
let actsOn: (a: Actor, projectId: number) => Promise<boolean>;

const ids: Record<string, number> = {};

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0, email: `${role}@w1share.local`, fullName: role, role,
    isActive: true, mustChangePassword: false,
    leadDepartmentIds: [], departmentIds: [], permissions: new Set<Permission>(), ...over,
  };
}

const pm = () => actor('project_manager', { id: ids.pm, fullName: 'Pat PM' });
const ceo = () => actor('ceo', { id: ids.ceo });
const repA = () => actor('sales', { id: ids.repA });
const repB = () => actor('sales', { id: ids.repB });

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE '%@w1share.local'`;
  const clients = sql`SELECT id FROM clients WHERE name LIKE 'W1 Share Test%'`;
  await sql`DELETE FROM notifications WHERE user_id IN (${users})`;
  // Only reached if a refused write below slipped through.
  await sql`DELETE FROM invoices WHERE client_id IN (${clients})`;
  await sql`DELETE FROM opportunities WHERE client_id IN (${clients})`;
  await sql`DELETE FROM users WHERE role = 'client' AND client_id IN (${clients})`;
  await sql`DELETE FROM projects WHERE client_id IN (${clients})`;
  await sql`DELETE FROM clients WHERE name LIKE 'W1 Share Test%'`;
  await sql`DELETE FROM users WHERE email LIKE '%@w1share.local'`;
}

async function notices(userId: number, type: string) {
  return sql<{ title: string; body: string | null; link_path: string | null }[]>`
    SELECT title, body, link_path FROM notifications
    WHERE user_id = ${userId} AND type = ${type} AND entity_id = ${ids.project} ORDER BY id`;
}

before(async () => {
  if (skip) return;
  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });
  viewers = await import('../src/lib/projects/viewers');
  const { getDb } = await import('../src/db');
  const { isProjectVisible } = await import('../src/lib/authz/queries');
  readable = (a, projectId) => isProjectVisible(getDb(), a, projectId, { shared: true });
  actsOn = (a, projectId) => isProjectVisible(getDb(), a, projectId);
  await purge();
  ids.video = Number((await sql`SELECT id FROM departments WHERE slug = 'video'`)[0].id);

  const mkUser = async (key: string, role: string, active = true) => {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role, is_active)
      VALUES (${`${key}@w1share.local`}, 'x', ${key}, ${role}, ${active}) RETURNING id`;
    ids[key] = Number(row.id);
  };
  await mkUser('ceo', 'ceo');
  await mkUser('pm', 'project_manager');
  await mkUser('repA', 'sales');
  await mkUser('repB', 'sales');
  await mkUser('repGone', 'sales', false);
  await mkUser('exec', 'executive');

  const [client] = await sql<{ id: number }[]>`
    INSERT INTO clients (name, owner_user_id, created_by)
    VALUES ('W1 Share Test Client', ${ids.repA}, ${ids.repA}) RETURNING id`;
  ids.client = Number(client.id);
  const [month] = await sql<{ id: number }[]>`
    INSERT INTO client_months (client_id, period_year, period_month, created_by)
    VALUES (${ids.client}, 2084, 9, ${ids.repA}) RETURNING id`;
  ids.month = Number(month.id);
  const [project] = await sql<{ id: number }[]>`
    INSERT INTO projects (project_code, client_id, client_month_id, title, sales_owner_id, created_by, price_amount)
    VALUES ('W1S-2084-0001', ${ids.client}, ${ids.month}, 'Brand film', ${ids.repA}, ${ids.repA}, 5000)
    RETURNING id`;
  ids.project = Number(project.id);
});

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
});

describe('sharing a project with a Sales rep (brief §23)', { skip }, () => {
  test('a colleague’s project is out of a rep’s sight until it is shared', async () => {
    assert.equal(await readable(repA(), ids.project), true, 'the owner sees it');
    assert.equal(await actsOn(repA(), ids.project), true);
    assert.equal(await readable(repB(), ids.project), false);
  });

  test('the PM shares it; the rep may read it and is told, the PM is not', async () => {
    const result = await viewers.shareProject(pm(), { projectId: ids.project, userId: ids.repB });
    assert.deepEqual(result, { projectId: ids.project, userId: ids.repB, userName: 'repB', changed: true });
    assert.equal(await readable(repB(), ids.project), true);
    assert.equal(await actsOn(repB(), ids.project), false, 'still not theirs to act on');

    const told = await notices(ids.repB, 'project.shared');
    assert.equal(told.length, 1);
    assert.equal(told[0].title, 'Project shared with you: W1S-2084-0001 · Brand film');
    assert.equal(told[0].body, 'W1 Share Test Client. Pat PM shared it with you to view.');
    assert.equal(told[0].link_path, `/projects/${ids.project}`);
    assert.equal((await notices(ids.pm, 'project.shared')).length, 0);
  });

  test('sharing again changes nothing and tells nobody twice', async () => {
    const result = await viewers.shareProject(ceo(), { projectId: ids.project, userId: ids.repB });
    assert.equal(result.changed, false);
    assert.equal((await notices(ids.repB, 'project.shared')).length, 1);
  });

  test('the panel lists the share and offers only reps who cannot see it yet', async () => {
    const list = await viewers.projectViewers(pm(), ids.project);
    assert.deepEqual(list.map((v) => [v.fullName, v.grantedBy, v.isActive]), [['repB', 'pm', true]]);

    const offered = (await viewers.shareCandidates(pm(), ids.project)).map((c) => c.id);
    assert.ok(!offered.includes(ids.repA), 'the owner sees it already');
    assert.ok(!offered.includes(ids.repB), 'already shared');
    assert.ok(!offered.includes(ids.repGone), 'deactivated');
    assert.ok(!offered.includes(ids.exec), 'not Sales');

    assert.deepEqual(await viewers.projectViewers(repA(), ids.project), [], 'Sales does not manage shares');
    assert.deepEqual(await viewers.shareCandidates(repA(), ids.project), []);
  });

  test('Sales cannot share, not even a rep trusted with every client', async () => {
    const trusted = actor('sales', { id: ids.repA, permissions: new Set<Permission>(['view_all_clients']) });
    await assert.rejects(
      viewers.shareProject(trusted, { projectId: ids.project, userId: ids.repB }),
      /not permitted to share/,
    );
    await assert.rejects(
      viewers.unshareProject(repA(), { projectId: ids.project, userId: ids.repB }),
      /not permitted to share/,
    );
  });

  test('only an active Sales rep can be given a project', async () => {
    await assert.rejects(
      viewers.shareProject(pm(), { projectId: ids.project, userId: ids.exec }),
      /active Sales representative/,
    );
    await assert.rejects(
      viewers.shareProject(pm(), { projectId: ids.project, userId: ids.repGone }),
      /active Sales representative/,
    );
  });

  test('the share is for reading: every change to the project or its client is refused', async () => {
    const rep = repB();
    const refused = async (what: string, attempt: Promise<unknown>, reason: RegExp) =>
      assert.rejects(attempt, reason, what);

    const { editProjectDetails } = await import('../src/lib/projects/edit');
    await refused('edit the details, price included', editProjectDetails(rep, {
      projectId: ids.project,
      details: {
        title: 'Renamed', projectType: null, objective: null, description: null, poReference: null,
        requirements: null, clientNotes: null, priceAmount: '1', recursMonthly: false, otherInfo: null,
      },
    }), /No such project/);
    const { changeProjectStatus } = await import('../src/lib/projects/status');
    await refused('cancel it', changeProjectStatus(rep, { projectId: ids.project, change: 'cancel', reason: 'x' }),
      /No such project/);
    const { addComment } = await import('../src/lib/workspace/comments');
    await refused('comment on it', addComment(rep, { projectId: ids.project, body: 'Hello' }), /No such project/);
    const { createRevision } = await import('../src/lib/revisions/revisions');
    await refused('open a revision', createRevision(rep, {
      projectId: ids.project, title: 'Recut', clientFeedback: 'Shorter', deliverableIds: [1],
    }), /No such project/);
    const { canAttachToProject } = await import('../src/lib/files/access');
    assert.deepEqual(await canAttachToProject(rep, ids.project), { allowed: false, reason: 'No such project.' });

    const { updateClientProfile } = await import('../src/lib/clients/profile');
    await refused('edit the client', updateClientProfile(rep, {
      clientId: ids.client,
      profile: {
        name: 'W1 Share Test Client', companyName: null, status: 'active', clientType: 'one_off',
        startedOn: null, notes: 'mine now',
      },
    }), /Unknown client/);
    const { createPortalLogin } = await import('../src/lib/portal/access');
    await refused('hand out a portal login', createPortalLogin(rep, {
      clientId: ids.client, fullName: 'Outsider', email: 'outsider@w1share.local',
    }), /Unknown client/);
    const { fileProject } = await import('../src/lib/projects/file-project');
    await refused('file work for the client', fileProject(rep, {
      clientId: ids.client, period: '2084-10', title: 'Another film',
      departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
    }), /Choose a client/);
    const { copyMonthPlan } = await import('../src/lib/months/copy');
    await refused('copy the month', copyMonthPlan(rep, { clientId: ids.client, fromMonthId: ids.month }),
      /No such client/);
    const { closeMonth } = await import('../src/lib/months/lifecycle');
    await refused('close the month', closeMonth(rep, { clientMonthId: ids.month }), /No such month/);
    const { draftBlank } = await import('../src/lib/invoices/invoices');
    await refused('bill the client', draftBlank(rep, { clientId: ids.client }), /Choose a client/);
    const { createOpportunity } = await import('../src/lib/pipeline/opportunities');
    await refused('open a deal', createOpportunity(rep, { clientId: ids.client, title: 'More films' }),
      /Choose a client/);

    const [project] = await sql`SELECT title, status, price_amount FROM projects WHERE id = ${ids.project}`;
    assert.deepEqual({ ...project }, { title: 'Brand film', status: 'new', price_amount: '5000.00' });
    const [month] = await sql`SELECT status FROM client_months WHERE id = ${ids.month}`;
    assert.equal(month.status, 'open');
  });

  test('none of it is counted as the rep’s own book', async () => {
    const { loadDashboard } = await import('../src/lib/dashboard/dashboard');
    const board = await loadDashboard(repB());
    assert.equal(board.counts.total, 0);
    assert.equal(board.value?.active, '0');
    assert.equal((await loadDashboard(repA())).value?.active, '5000.00', 'the owner’s is unchanged');
  });

  test('taking it back hides the project again and tells the rep, without a link', async () => {
    const result = await viewers.unshareProject(ceo(), { projectId: ids.project, userId: ids.repB });
    assert.equal(result.changed, true);
    assert.equal(await readable(repB(), ids.project), false);

    const told = await notices(ids.repB, 'project.unshared');
    assert.equal(told.length, 1);
    assert.equal(told[0].title, 'Project no longer shared with you: W1S-2084-0001 · Brand film');
    assert.equal(told[0].link_path, null);

    await assert.rejects(
      viewers.unshareProject(ceo(), { projectId: ids.project, userId: ids.repB }),
      /not shared with that person/,
    );
  });

  test('a closed month does not freeze sharing: it is access, not the month’s work', async () => {
    await sql`UPDATE client_months SET status = 'closed' WHERE id = ${ids.month}`;
    try {
      const shared = await viewers.shareProject(pm(), { projectId: ids.project, userId: ids.repB });
      assert.equal(shared.changed, true, 'last month’s archive can be shared to read');
      assert.equal(await readable(repB(), ids.project), true);
      const taken = await viewers.unshareProject(pm(), { projectId: ids.project, userId: ids.repB });
      assert.equal(taken.changed, true, 'a mistaken share is revoked without reopening the month');
      assert.equal(await readable(repB(), ids.project), false);
    } finally {
      await sql`UPDATE client_months SET status = 'open' WHERE id = ${ids.month}`;
    }
  });
});
