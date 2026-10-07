/**
 * Editing the records after they are filed: a project's details (brief §3,
 * §27) and the permanent client profile with its contacts (§31).
 *
 * The same record is corrected in place rather than filed again; pricing
 * stays with the people allowed to see it, including in what the teams are
 * told about a change (§23).
 *
 * Needs DATABASE_URL pointing at a migrated database.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import postgres from 'postgres';
import type { Actor, Permission, Role } from '../src/lib/authz/types';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run editing tests';

let sql: ReturnType<typeof postgres>;
let edit: typeof import('../src/lib/projects/edit');
let profile: typeof import('../src/lib/clients/profile');
let feed: typeof import('../src/lib/activity/feed');
let fileProject: typeof import('../src/lib/projects/file-project').fileProject;
let triageProject: typeof import('../src/lib/projects/triage').triageProject;
let createAssignment: typeof import('../src/lib/planning/assign').createAssignment;
let changeProjectStatus: typeof import('../src/lib/projects/status').changeProjectStatus;

const ids: Record<string, number> = {};
const DOMAIN = '@edittest.local';

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0, email: `${role}${DOMAIN}`, fullName: role, role,
    isActive: true, mustChangePassword: false,
    leadDepartmentIds: [], departmentIds: [], permissions: new Set<Permission>(), ...over,
  };
}
const sales = () => actor('sales', { id: ids.sales });
const otherSales = () => actor('sales', { id: ids.otherSales });
const pm = () => actor('project_manager', { id: ids.pm });
const ceo = () => actor('ceo', { id: ids.ceo });
const admin = () => actor('admin', { id: ids.admin });
const leadVideo = () => actor('team_lead', { id: ids.leadVideo, leadDepartmentIds: [ids.video], departmentIds: [ids.video] });
const ahmed = () => actor('executive', { id: ids.ahmed, departmentIds: [ids.video] });

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE ${'%' + DOMAIN}`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'Edit Test%')`;
  await sql`DELETE FROM clients WHERE name LIKE 'Edit Test%'`;
  await sql`DELETE FROM notifications WHERE user_id IN (${users})`;
  await sql`DELETE FROM department_members WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE ${'%' + DOMAIN}`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2094`;
}

const details = (over: Partial<import('../src/lib/projects/edit').ProjectDetails> = {}) => ({
  title: 'Social videos', projectType: 'Social', objective: 'Grow reach', description: null,
  poReference: 'PO-1', requirements: '10 reels', clientNotes: null, priceAmount: '1000.00',
  recursMonthly: false, otherInfo: null, ...over,
});

async function newProject(title = 'Social videos') {
  const p = await fileProject(sales(), {
    clientId: ids.client, period: '2094-05', title, projectType: 'Social', objective: 'Grow reach',
    poReference: 'PO-1', requirements: '10 reels', priceAmount: '1000.00',
    departments: [{ departmentId: ids.video, plannedDeliverables: 2 }],
  });
  await triageProject(pm(), {
    projectId: p.projectId,
    teams: [{ departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 2 }],
  });
  const [pd] = await sql`SELECT id FROM project_departments WHERE project_id = ${p.projectId}`;
  await createAssignment(leadVideo(), {
    projectDepartmentId: Number(pd.id), assigneeId: ids.ahmed, title: 'Cut', deliverableCount: 2,
  });
  return p.projectId;
}

const noticesFor = async (userId: number, projectId: number) =>
  sql<{ body: string }[]>`
    SELECT body FROM notifications
    WHERE user_id = ${userId} AND type = 'project.details_edited' AND entity_id = ${projectId}
    ORDER BY id`;

before(async () => {
  if (skip) return;
  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });
  edit = await import('../src/lib/projects/edit');
  profile = await import('../src/lib/clients/profile');
  feed = await import('../src/lib/activity/feed');
  ({ fileProject } = await import('../src/lib/projects/file-project'));
  ({ triageProject } = await import('../src/lib/projects/triage'));
  ({ createAssignment } = await import('../src/lib/planning/assign'));
  ({ changeProjectStatus } = await import('../src/lib/projects/status'));
  await purge();

  ids.video = Number((await sql`SELECT id FROM departments WHERE slug = 'video'`)[0].id);
  for (const [key, role] of [
    ['sales', 'sales'], ['otherSales', 'sales'], ['pm', 'project_manager'], ['ceo', 'ceo'],
    ['admin', 'admin'], ['leadVideo', 'team_lead'], ['ahmed', 'executive'],
  ] as const) {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES (${key + DOMAIN}, 'x', ${key}, ${role}) RETURNING id`;
    ids[key] = Number(row.id);
  }
  await sql`INSERT INTO department_members (user_id, department_id, is_lead) VALUES (${ids.leadVideo}, ${ids.video}, true)`;
  await sql`INSERT INTO department_members (user_id, department_id, is_lead) VALUES (${ids.ahmed}, ${ids.video}, false)`;
  for (const [key, name, owner] of [['client', 'Edit Test Client', ids.sales], ['rival', 'Edit Test Rival', ids.otherSales]] as const) {
    const [c] = await sql<{ id: number }[]>`
      INSERT INTO clients (name, owner_user_id, created_by) VALUES (${name}, ${owner}, ${owner}) RETURNING id`;
    ids[key] = Number(c.id);
  }
});

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
});

describe('editing a project’s details (brief §3, §27)', { skip }, () => {
  test('Sales corrects the brief in place and learns which fields changed', async () => {
    const id = await newProject();
    const r = await edit.editProjectDetails(sales(), {
      projectId: id, details: details({ requirements: '12 reels', poReference: 'PO-2' }),
    });
    assert.deepEqual(r.changed, ['poReference', 'requirements']);
    const [row] = await sql`SELECT requirements, po_reference, project_code FROM projects WHERE id = ${id}`;
    assert.equal(row.requirements, '12 reels');
    assert.equal(row.po_reference, 'PO-2');
    assert.match(row.project_code, /^AKT-2094-\d{4}$/);
  });

  test('saving without changes changes nothing and tells nobody', async () => {
    const id = await newProject();
    const r = await edit.editProjectDetails(pm(), { projectId: id, details: details() });
    assert.deepEqual(r.changed, []);
    assert.equal((await noticesFor(ids.sales, id)).length, 0);
  });

  test('the team hears about the brief; nobody but pricing roles hears about the price', async () => {
    const id = await newProject();
    await edit.editProjectDetails(pm(), {
      projectId: id, details: details({ requirements: 'Vertical only', priceAmount: '1500' }),
    });
    const [salesNote] = await noticesFor(ids.sales, id);
    assert.match(salesNote.body, /price/);
    for (const who of [ids.leadVideo, ids.ahmed]) {
      const notes = await noticesFor(who, id);
      assert.equal(notes.length, 1);
      assert.match(notes[0].body, /requirements/);
      assert.doesNotMatch(notes[0].body, /price/);
    }
    assert.equal((await noticesFor(ids.pm, id)).length, 0, 'the editor is not told about their own edit');
  });

  test('a price-only change reaches Sales and the PM, not the team', async () => {
    const id = await newProject();
    await edit.editProjectDetails(sales(), { projectId: id, details: details({ priceAmount: '2000' }) });
    assert.equal((await noticesFor(ids.pm, id)).length, 1);
    assert.equal((await noticesFor(ids.leadVideo, id)).length, 0);
    assert.equal((await noticesFor(ids.ahmed, id)).length, 0);
    const [row] = await sql`SELECT price_amount FROM projects WHERE id = ${id}`;
    assert.equal(Number(row.price_amount), 2000);
  });

  test('the feed hides a price change from those who cannot see pricing', async () => {
    const id = await newProject();
    for (const fields of [['price'], ['requirements', 'price']]) {
      await sql`INSERT INTO activity_log (actor_id, action, entity_type, entity_id, project_id, metadata)
        VALUES (${ids.sales}, 'project.details_edited', 'project', ${id}, ${id}, ${sql.json({ fields })})`;
    }
    const pricing = (await feed.projectActivity(id, { showPricing: true }))
      .filter((l) => l.action === 'project.details_edited').map((l) => l.text);
    const team = (await feed.projectActivity(id))
      .filter((l) => l.action === 'project.details_edited').map((l) => l.text);
    assert.deepEqual(pricing, ['sales updated the project price', 'sales updated the project requirements, price']);
    assert.deepEqual(team, ['sales updated the project requirements']);
  });

  test('Team Leads, Executives, admin and another rep may not edit', async () => {
    const id = await newProject();
    for (const who of [leadVideo(), ahmed(), admin()]) {
      await assert.rejects(edit.editProjectDetails(who, { projectId: id, details: details({ title: 'X y' }) }),
        /not permitted/);
    }
    await assert.rejects(edit.editProjectDetails(otherSales(), { projectId: id, details: details() }),
      /No such project/);
  });

  test('a blank name is refused', async () => {
    const id = await newProject();
    await assert.rejects(edit.editProjectDetails(sales(), { projectId: id, details: details({ title: ' ' }) }),
      /project name/);
  });

  test('a cancelled project and a closed month are read-only', async () => {
    const cancelled = await newProject();
    await changeProjectStatus(pm(), { projectId: cancelled, change: 'cancel', reason: 'Client withdrew' });
    await assert.rejects(edit.editProjectDetails(sales(), { projectId: cancelled, details: details({ title: 'New' }) }),
      /cancelled/);

    const archived = await newProject();
    const [m] = await sql`SELECT client_month_id FROM projects WHERE id = ${archived}`;
    await sql`UPDATE client_months SET status = 'closed', closed_at = now(), closed_by = ${ids.pm} WHERE id = ${m.client_month_id}`;
    try {
      await assert.rejects(edit.editProjectDetails(sales(), { projectId: archived, details: details({ title: 'New' }) }),
        /closed/);
    } finally {
      await sql`UPDATE client_months SET status = 'open', closed_at = NULL, closed_by = NULL WHERE id = ${m.client_month_id}`;
    }
  });

  test('parsing the form rejects a negative price', () => {
    const f = new FormData();
    f.set('title', 'Name'); f.set('priceAmount', '-5');
    assert.throws(() => edit.parseProjectDetailsForm(f), /valid price/);
  });
});

describe('the client profile (brief §31)', { skip }, () => {
  const base = (over: Partial<import('../src/lib/clients/profile').ClientProfile> = {}) => ({
    name: 'Edit Test Client', companyName: 'Edit Test LLC', status: 'active' as const,
    clientType: 'retainer' as const, startedOn: '2024-01-15', notes: 'Prefers WhatsApp', ...over,
  });

  test('Sales edits status, type, start date and notes in place', async () => {
    const r = await profile.updateClientProfile(sales(), {
      clientId: ids.client, profile: base({ status: 'paused', clientType: 'one_off' }),
    });
    assert.deepEqual(r.changed, ['company', 'status', 'type', 'start date', 'notes']);
    const [row] = await sql`SELECT status, client_type, started_on::text AS started_on, notes FROM clients WHERE id = ${ids.client}`;
    assert.equal(row.status, 'paused');
    assert.equal(row.client_type, 'one_off');
    assert.equal(row.started_on, '2024-01-15');
    const again = await profile.updateClientProfile(sales(), {
      clientId: ids.client, profile: base({ status: 'paused', clientType: 'one_off' }),
    });
    assert.deepEqual(again.changed, []);
  });

  test('a rename onto another client’s name is refused, in any case', async () => {
    await assert.rejects(
      profile.updateClientProfile(ceo(), { clientId: ids.client, profile: base({ name: 'edit test RIVAL' }) }),
      /already called/);
  });

  test('only someone who sees every client may move it to another rep', async () => {
    await assert.rejects(
      profile.updateClientProfile(sales(), { clientId: ids.client, profile: base({ ownerUserId: ids.otherSales }) }),
      /Only management/);
    await assert.rejects(
      profile.updateClientProfile(ceo(), { clientId: ids.client, profile: base({ ownerUserId: ids.pm }) }),
      /active Sales representative/);
    const r = await profile.updateClientProfile(ceo(), {
      clientId: ids.client, profile: base({ status: 'paused', clientType: 'one_off', ownerUserId: ids.otherSales }),
    });
    assert.deepEqual(r.changed, ['sales representative']);
    await profile.updateClientProfile(ceo(), {
      clientId: ids.client, profile: base({ status: 'paused', clientType: 'one_off', ownerUserId: ids.sales }),
    });
  });

  test('a rep cannot edit another rep’s client; a Team Lead cannot edit clients', async () => {
    await assert.rejects(profile.updateClientProfile(sales(), { clientId: ids.rival, profile: base({ name: 'Edit Test Rival' }) }),
      /Unknown client/);
    await assert.rejects(profile.updateClientProfile(leadVideo(), { clientId: ids.client, profile: base() }),
      /not permitted/);
  });

  test('bad input is refused', async () => {
    await assert.rejects(profile.updateClientProfile(sales(), { clientId: ids.client, profile: base({ startedOn: '15/01/2024' }) }),
      /start date/);
    await assert.rejects(profile.updateClientProfile(sales(), {
      clientId: ids.client, profile: base({ status: 'gone' as never }) }), /status/);
  });

  test('contacts: one primary per client, edited and removed in place', async () => {
    const contact = (name: string, isPrimary: boolean) =>
      ({ name, email: null, phone: null, jobTitle: null, isPrimary });
    const a = await profile.saveContact(sales(), { clientId: ids.client, contact: contact('Aisha', true) });
    const b = await profile.saveContact(sales(), { clientId: ids.client, contact: contact('Bilal', true) });
    const primaries = async () => (await sql`
      SELECT name FROM client_contacts WHERE client_id = ${ids.client} AND is_primary ORDER BY name`).map((r) => r.name);
    assert.deepEqual(await primaries(), ['Bilal']);

    await profile.saveContact(sales(), { clientId: ids.client, contactId: a.contactId,
      contact: { ...contact('Aisha K', true), email: 'aisha@example.com' } });
    assert.deepEqual(await primaries(), ['Aisha K']);

    // A contact id from another client cannot be reached through this one.
    await assert.rejects(profile.saveContact(ceo(), { clientId: ids.rival, contactId: b.contactId,
      contact: contact('Hijack', false) }), /Unknown contact/);
    await assert.rejects(profile.removeContact(ceo(), { clientId: ids.rival, contactId: b.contactId }),
      /Unknown contact/);

    assert.deepEqual(await profile.removeContact(sales(), { clientId: ids.client, contactId: b.contactId }), { name: 'Bilal' });
    const left = await sql`SELECT name FROM client_contacts WHERE client_id = ${ids.client}`;
    assert.deepEqual(left.map((r) => r.name), ['Aisha K']);
  });
});

describe('recognising a duplicate name', { skip }, () => {
  test('a duplicate insert through Drizzle is recognised, as createClient relies on', async () => {
    const { getDb } = await import('../src/db');
    const { clients } = await import('../src/db/schema');
    const error = await getDb().insert(clients)
      .values({ name: 'edit test client', createdBy: ids.sales })
      .then(() => null, (e: unknown) => e);
    assert.ok(error, 'the case-variant duplicate was refused');
    assert.equal(profile.isUniqueViolation(error), true);
    assert.equal(profile.isUniqueViolation(new Error('other')), false);
  });
});
