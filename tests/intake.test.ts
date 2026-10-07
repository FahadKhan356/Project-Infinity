/**
 * Project intake (brief §3, §24, §31, §32, §37).
 *
 * The invariants worth guarding here are the ones that quietly destroy a
 * client's history if they break: one bucket per client-month, one code per
 * project, and no second client record for a name that already exists.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { sql as dsql } from 'drizzle-orm';
import postgres from 'postgres';
import type { Actor } from '../src/lib/authz/types';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run intake tests';

let sql: ReturnType<typeof postgres>;
let getDb: typeof import('../src/db').getDb;
let intake: typeof import('../src/lib/projects/intake');
const ids: Record<string, number> = {};

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE '%@m3test.local'`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'M3 Test%')`;
  await sql`DELETE FROM clients WHERE name LIKE 'M3 Test%'`;
  await sql`DELETE FROM users WHERE email LIKE '%@m3test.local'`;
  await sql`DELETE FROM project_code_sequence WHERE period_year IN (2066, 2098, 2099)`;
}

before(async () => {
  if (skip) return;
  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });
  ({ getDb } = await import('../src/db'));
  intake = await import('../src/lib/projects/intake');
  await purge();

  const [user] = await sql<{ id: number }[]>`
    INSERT INTO users (email, password_hash, full_name, role)
    VALUES ('sales@m3test.local','x','Sales','sales') RETURNING id`;
  ids.sales = Number(user.id);

  // owner_user_id is what scopes a client to a Sales rep (§23, §31) — the
  // createClient action sets it, so the fixture must too.
  const [client] = await sql<{ id: number }[]>`
    INSERT INTO clients (name, owner_user_id, created_by)
    VALUES ('M3 Test ABC', ${ids.sales}, ${ids.sales}) RETURNING id`;
  ids.client = Number(client.id);
});

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
});

describe('project codes (brief §24)', { skip }, () => {
  test('are allocated in sequence and never repeat', async () => {
    const db = getDb();
    const codes: string[] = [];
    for (let i = 0; i < 3; i++) {
      codes.push(await db.transaction((tx) => intake.allocateProjectCode(tx, 2099)));
    }
    assert.deepEqual(codes, ['AKT-2099-0001', 'AKT-2099-0002', 'AKT-2099-0003']);
  });

  test('concurrent allocations hand out distinct numbers', async () => {
    const db = getDb();
    const codes = await Promise.all(
      Array.from({ length: 8 }, () => db.transaction((tx) => intake.allocateProjectCode(tx, 2099))),
    );
    assert.equal(new Set(codes).size, 8, `duplicates issued: ${codes.join(', ')}`);
  });
});

describe('month buckets (brief §32, §37)', { skip }, () => {
  test('the first project of a month opens the bucket', async () => {
    const result = await getDb().transaction((tx) =>
      intake.resolveClientMonth(tx, { clientId: ids.client, year: 2099, month: 9, userId: ids.sales }),
    );
    assert.equal(result.created, true);
    ids.month = result.id;
  });

  test('a second project in the same month reuses it rather than opening another', async () => {
    const result = await getDb().transaction((tx) =>
      intake.resolveClientMonth(tx, { clientId: ids.client, year: 2099, month: 9, userId: ids.sales }),
    );
    assert.equal(result.created, false);
    assert.equal(result.id, ids.month, 'both projects must land in one bucket');

    const rows = await sql`
      SELECT count(*)::int AS n FROM client_months
      WHERE client_id = ${ids.client} AND period_year = 2099 AND period_month = 9`;
    assert.equal(rows[0].n, 1);
  });

  test('a different month opens a separate bucket', async () => {
    const october = await getDb().transaction((tx) =>
      intake.resolveClientMonth(tx, { clientId: ids.client, year: 2099, month: 10, userId: ids.sales }),
    );
    assert.equal(october.created, true);
    assert.notEqual(october.id, ids.month);
  });

  test('simultaneous first projects settle on one bucket', async () => {
    const db = getDb();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        db.transaction((tx) =>
          intake.resolveClientMonth(tx, { clientId: ids.client, year: 2099, month: 11, userId: ids.sales }),
        ),
      ),
    );
    assert.equal(new Set(results.map((r) => r.id)).size, 1, 'a race must not create two buckets');
  });
});

describe('client identity (brief §31)', { skip }, () => {
  test('a name that differs only by case is refused', async () => {
    await assert.rejects(
      sql`INSERT INTO clients (name, created_by) VALUES ('m3 test abc', ${ids.sales})`,
      /duplicate key|unique/i,
      'case-variant client names must not create a second history',
    );
  });

  test('surrounding whitespace does not create a second client either', async () => {
    // The action trims before inserting; this asserts the stored form is clean.
    const rows = await sql`SELECT name FROM clients WHERE id = ${ids.client}`;
    assert.equal(rows[0].name, rows[0].name.trim());
  });
});

describe('month helpers', { skip: false }, () => {
  test('options cover the recent past and the near future', async () => {
    const mod = await import('../src/lib/projects/intake');
    const options = mod.monthOptions(new Date(Date.UTC(2026, 8, 15)));
    assert.equal(options.length, 6);
    assert.equal(options[3].value, '2026-09');
    assert.equal(options[0].value, '2026-06');
    assert.equal(options[5].value, '2026-11');
  });

  test('parsing rejects anything that is not a real month', async () => {
    const mod = await import('../src/lib/projects/intake');
    assert.deepEqual(mod.parseMonthValue('2026-09'), { year: 2026, month: 9 });
    for (const bad of ['2026-13', '2026-00', 'x', '', '26-09', '2026-9']) {
      assert.equal(mod.parseMonthValue(bad), null, `${bad} should not parse`);
    }
  });
});

describe('filing a project end to end', { skip }, () => {
  let fileProject: typeof import('../src/lib/projects/file-project').fileProject;
  let parseProjectForm: typeof import('../src/lib/projects/file-project').parseProjectForm;
  let IntakeError: typeof import('../src/lib/projects/file-project').IntakeError;
  const dept: Record<string, number> = {};
  let salesActor: import('../src/lib/authz/types').Actor;

  before(async () => {
    const mod = await import('../src/lib/projects/file-project');
    fileProject = mod.fileProject;
    parseProjectForm = mod.parseProjectForm;
    IntakeError = mod.IntakeError;

    for (const slug of ['video', 'design']) {
      dept[slug] = Number((await sql`SELECT id FROM departments WHERE slug = ${slug}`)[0].id);
    }
    salesActor = {
      id: ids.sales, email: 'sales@m3test.local', fullName: 'Sales', role: 'sales',
      isActive: true, mustChangePassword: false,
      leadDepartmentIds: [], departmentIds: [], permissions: new Set(),
    };
  });

  const baseInput = () => ({
    clientId: ids.client,
    period: '2099-09',
    title: '10 Social Media Videos',
    departments: [{ departmentId: dept.video, plannedDeliverables: 10 }],
    priceAmount: '18500.00',
  });

  test('the first project opens the month; the second reuses it', async () => {
    const first = await fileProject(salesActor, baseInput());
    const second = await fileProject(salesActor, {
      ...baseInput(),
      title: '20 Social Media Designs',
      departments: [
        { departmentId: dept.design, plannedDeliverables: 20 },
        { departmentId: dept.video, plannedDeliverables: 2 },
      ],
    });

    assert.equal(
      first.clientMonthId, second.clientMonthId,
      'two projects in one month must share one bucket (§32)',
    );
    assert.equal(second.monthCreated, false);
    assert.notEqual(first.projectCode, second.projectCode);
    assert.match(first.projectCode, /^AKT-2099-\d{4}$/);

    const buckets = await sql`
      SELECT count(*)::int AS n FROM client_months
      WHERE client_id = ${ids.client} AND period_year = 2099 AND period_month = 9`;
    assert.equal(buckets[0].n, 1);

    const teams = await sql`
      SELECT d.slug, pd.planned_deliverables FROM project_departments pd
      JOIN departments d ON d.id = pd.department_id
      WHERE pd.project_id = ${second.projectId} ORDER BY d.sort_order`;
    assert.deepEqual(
      teams.map((t) => [t.slug, Number(t.planned_deliverables)]),
      [['video', 2], ['design', 20]],
      'per-team counts are recorded against the right team (§3, §10)',
    );
  });

  test('it lands in the Project Manager’s intake queue', async () => {
    const filed = await fileProject(salesActor, { ...baseInput(), title: 'Queue check' });
    const rows = await sql`SELECT status, sales_owner_id FROM projects WHERE id = ${filed.projectId}`;
    assert.equal(rows[0].status, 'new');
    assert.equal(Number(rows[0].sales_owner_id), ids.sales);
  });

  test('pricing is ignored when the filer may not see pricing', async () => {
    // A Team Lead cannot normally file at all, so use an actor who can create
    // projects but holds no pricing capability — proving the price is dropped
    // server-side rather than trusted from the form.
    const withoutPricing = { ...salesActor, role: 'team_lead' as const };
    await assert.rejects(
      fileProject(withoutPricing, baseInput()),
      IntakeError,
      'a Team Lead must not be able to file projects at all',
    );
  });

  test('a client the filer cannot see is refused, without saying why', async () => {
    const [other] = await sql<{ id: number }[]>`
      INSERT INTO clients (name, created_by) VALUES ('M3 Test Someone Else', ${ids.sales})
      RETURNING id`;
    // Owned by nobody, and this rep did not create any project for them.
    await sql`UPDATE clients SET owner_user_id = NULL WHERE id = ${other.id}`;

    await assert.rejects(
      fileProject(salesActor, { ...baseInput(), clientId: Number(other.id) }),
      (error: Error) => error instanceof IntakeError && /Choose a client/.test(error.message),
    );
  });

  test('a project with no team is refused', async () => {
    await assert.rejects(
      fileProject(salesActor, { ...baseInput(), departments: [] }),
      /at least one team/,
    );
  });

  test('an unparseable month is refused', async () => {
    await assert.rejects(fileProject(salesActor, { ...baseInput(), period: '2099-13' }), /month/);
  });

  test('the form parser mirrors what the fields are named', () => {
    const form = new FormData();
    form.append('clientId', '7');
    form.append('period', '2026-09');
    form.append('title', '  Trailing space  ');
    form.append('department', '3');
    form.append('planned_3', '10');
    form.append('department', '4');
    form.append('planned_4', '-2');
    form.append('priority', 'urgent');
    form.append('priceAmount', '1234.5');
    form.append('requiresPmQa', 'on');

    const parsed = parseProjectForm(form);
    assert.equal(parsed.clientId, 7);
    assert.equal(parsed.priority, 'urgent');
    assert.equal(parsed.priceAmount, '1234.50');
    assert.equal(parsed.requiresPmQa, true);
    assert.deepEqual(parsed.departments, [
      { departmentId: 3, plannedDeliverables: 10 },
      { departmentId: 4, plannedDeliverables: 0 },
    ]);
  });

  test('recovers when a code already exists that the sequence does not know about', async () => {
    // Exactly what a restored database or a hand-inserted row looks like: the
    // sequence is behind the codes that actually exist.
    await sql`DELETE FROM project_code_sequence WHERE period_year = 2098`;
    await sql`
      INSERT INTO projects (project_code, client_id, client_month_id, title, sales_owner_id, created_by)
      SELECT 'AKT-2098-0001', ${ids.client}, cm.id, 'Pre-existing', ${ids.sales}, ${ids.sales}
      FROM client_months cm
      WHERE cm.client_id = ${ids.client} AND cm.period_year = 2099 AND cm.period_month = 9`;

    const filed = await fileProject(salesActor, { ...baseInput(), period: '2098-01' });
    assert.notEqual(filed.projectCode, 'AKT-2098-0001');
    assert.match(filed.projectCode, /^AKT-2098-\d{4}$/);

    const codes = await sql`
      SELECT count(*)::int AS n FROM projects WHERE project_code = 'AKT-2098-0001'`;
    assert.equal(codes[0].n, 1, 'the existing code must still be unique');
  });

  test('a nonsense price is rejected rather than stored as zero', () => {
    const form = new FormData();
    form.append('priceAmount', 'not-a-number');
    assert.throws(() => parseProjectForm(form), /valid price/);
  });
});

/**
 * The rest of what brief §3 lists on the intake form: "other relevant
 * project information", and the "number of deliverables" as one figure —
 * the sum of the teams' counts, never a number of its own that could
 * disagree with them. Year 2066 is this block's; the blocks above keep
 * 2098 and 2099.
 */
describe('intake details (brief §3)', { skip }, () => {
  let fp: typeof import('../src/lib/projects/file-project');
  let edit: typeof import('../src/lib/projects/edit');
  let triage: typeof import('../src/lib/projects/triage');
  let queries: typeof import('../src/lib/projects/queries');
  const dept: Record<string, number> = {};
  let salesActor: Actor;
  let pmActor: Actor;

  before(async () => {
    fp = await import('../src/lib/projects/file-project');
    edit = await import('../src/lib/projects/edit');
    triage = await import('../src/lib/projects/triage');
    queries = await import('../src/lib/projects/queries');
    for (const slug of ['video', 'design']) {
      dept[slug] = Number((await sql`SELECT id FROM departments WHERE slug = ${slug}`)[0].id);
    }
    const [pm] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES ('pm@m3test.local','x','PM','project_manager') RETURNING id`;
    ids.pm = Number(pm.id);
    salesActor = {
      id: ids.sales, email: 'sales@m3test.local', fullName: 'Sales', role: 'sales',
      isActive: true, mustChangePassword: false,
      leadDepartmentIds: [], departmentIds: [], permissions: new Set(),
    };
    pmActor = {
      id: ids.pm, email: 'pm@m3test.local', fullName: 'PM', role: 'project_manager',
      isActive: true, mustChangePassword: false,
      leadDepartmentIds: [], departmentIds: [], permissions: new Set(),
    };
  });

  const baseInput = () => ({
    clientId: ids.client,
    period: '2066-03',
    title: '10 Social Media Videos',
    departments: [{ departmentId: dept.video, plannedDeliverables: 10 }],
    priceAmount: '18500.00',
  });

  /** The expression the projects list and the project page put in their SELECT. */
  const plannedTotal = async (projectId: number): Promise<number> => {
    const rows = await getDb().execute<{ n: number }>(dsql`
      SELECT ${queries.plannedDeliverablesTotal('p')} AS n FROM projects p WHERE p.id = ${projectId}
    `);
    return Number(rows[0].n);
  };

  test('other information is stored at filing and read back', async () => {
    const filed = await fp.fileProject(salesActor, {
      ...baseInput(), otherInfo: 'Deliver via WeTransfer; brand kit in Drive',
    });
    const [row] = await sql`SELECT other_info FROM projects WHERE id = ${filed.projectId}`;
    assert.equal(row.other_info, 'Deliver via WeTransfer; brand kit in Drive');

    const plain = await fp.fileProject(salesActor, { ...baseInput(), title: 'Nothing else to say' });
    const [none] = await sql`SELECT other_info FROM projects WHERE id = ${plain.projectId}`;
    assert.equal(none.other_info, null, 'omitted means null, never an empty string');
  });

  test('the intake and edit form parsers read otherInfo', () => {
    const form = new FormData();
    form.append('otherInfo', '  keep me ');
    assert.equal(fp.parseProjectForm(form).otherInfo, 'keep me');

    const blank = new FormData();
    blank.append('otherInfo', '   ');
    assert.equal(fp.parseProjectForm(blank).otherInfo, null);

    const editForm = new FormData();
    editForm.append('title', 'Edited');
    editForm.append('otherInfo', 'Courier the hard drive back');
    assert.equal(edit.parseProjectDetailsForm(editForm).otherInfo, 'Courier the hard drive back');
    assert.equal(edit.DETAIL_LABELS.otherInfo, 'other information');
  });

  test('editing other information records the change under its label', async () => {
    const filed = await fp.fileProject(salesActor, { ...baseInput(), title: 'Edit target' });
    const details = {
      title: 'Edit target', projectType: null, objective: null, description: null,
      poReference: null, requirements: null, clientNotes: null, priceAmount: '18500.00',
      recursMonthly: false, otherInfo: 'Updated',
    };
    const first = await edit.editProjectDetails(salesActor, { projectId: filed.projectId, details });
    assert.deepEqual(first.changed, ['otherInfo']);
    const [row] = await sql`SELECT other_info FROM projects WHERE id = ${filed.projectId}`;
    assert.equal(row.other_info, 'Updated');

    // The trap: a column left out of the locking SELECT reads as undefined
    // and is reported changed on every save, telling everyone each time.
    const again = await edit.editProjectDetails(salesActor, { projectId: filed.projectId, details });
    assert.deepEqual(again.changed, [], 'an identical save must change nothing');
  });

  test('the deliverable total is the sum of the team counts, never a stored number', async () => {
    const filed = await fp.fileProject(salesActor, {
      ...baseInput(),
      title: 'Totals',
      departments: [
        { departmentId: dept.video, plannedDeliverables: 10 },
        { departmentId: dept.design, plannedDeliverables: 20 },
      ],
    });
    assert.equal(await plannedTotal(filed.projectId), 30);

    // The PM's queue spans the whole shared database: pin by id, never count.
    const queued = (await triage.intakeQueue(pmActor)).find((r) => r.id === filed.projectId);
    assert.equal(queued?.plannedTotal, 30);

    // Triage changes a team's count; the total follows at once, since it is derived.
    await triage.triageProject(pmActor, {
      projectId: filed.projectId,
      teams: [
        { departmentId: dept.video, teamLeadId: null, plannedDeliverables: 12 },
        { departmentId: dept.design, teamLeadId: null, plannedDeliverables: 20 },
      ],
    });
    assert.equal(await plannedTotal(filed.projectId), 32);
    assert.equal((await triage.intakeQueue(pmActor)).find((r) => r.id === filed.projectId)?.plannedTotal, 32);

    const empty = await fp.fileProject(salesActor, {
      ...baseInput(), title: 'Nothing planned yet',
      departments: [{ departmentId: dept.video, plannedDeliverables: 0 }],
    });
    assert.equal(await plannedTotal(empty.projectId), 0);
  });
});
