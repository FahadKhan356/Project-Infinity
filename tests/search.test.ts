/**
 * Global search and filters (brief §22) — Phase 1b.
 *
 * Every field the brief lists is searchable; every result is inside the
 * searcher's scope. The example in the brief is the acceptance test: an
 * Executive cannot search and discover a project they are not on.
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
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run search tests';

let sql: ReturnType<typeof postgres>;
let storageRoot: string;
let search: typeof import('../src/lib/search/search');

const ids: Record<string, number> = {};
const codes: Record<string, string> = {};

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0, email: `${role}@m10test.local`, fullName: role, role,
    isActive: true, mustChangePassword: false,
    leadDepartmentIds: [], departmentIds: [], permissions: new Set<Permission>(), ...over,
  };
}
const sales = () => actor('sales', { id: ids.sales });
const otherSales = () => actor('sales', { id: ids.otherSales });
const pm = () => actor('project_manager', { id: ids.pm });
const leadVideo = () => actor('team_lead', { id: ids.leadVideo, leadDepartmentIds: [ids.video], departmentIds: [ids.video] });
const leadDesign = () => actor('team_lead', { id: ids.leadDesign, leadDepartmentIds: [ids.design], departmentIds: [ids.design] });
const ahmed = () => actor('executive', { id: ids.ahmed, departmentIds: [ids.video] });

const titles = (hits: { title: string }[]) => hits.map((h) => h.title).sort();

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE '%@m10test.local'`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM upload_sessions WHERE created_by IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'M10 Test%')`;
  await sql`DELETE FROM clients WHERE name LIKE 'M10 Test%'`;
  await sql`DELETE FROM files WHERE uploaded_by IN (${users})`;
  await sql`DELETE FROM department_members WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE '%@m10test.local'`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2090`;
}

before(async () => {
  if (skip) return;
  try { await setUp(); } catch (error) {
    console.error('\n[search.test] fixture setup failed:', error);
    throw error;
  }
});

async function setUp() {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'aktivacity-m10-'));
  process.env.STORAGE_ROOT = storageRoot;
  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });

  search = await import('../src/lib/search/search');
  const uploads = await import('../src/lib/files/uploads');
  const { fileProject } = await import('../src/lib/projects/file-project');
  const { triageProject } = await import('../src/lib/projects/triage');
  const { createAssignment } = await import('../src/lib/planning/assign');
  const { reviewDeliverable } = await import('../src/lib/qa/review');
  const { updateDelivery } = await import('../src/lib/delivery/deliveries');
  const { createRevision } = await import('../src/lib/revisions/revisions');
  await purge();

  for (const slug of ['video', 'design']) {
    ids[slug] = Number((await sql`SELECT id FROM departments WHERE slug = ${slug}`)[0].id);
  }
  const mkUser = async (key: string, role: string, name: string) => {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES (${`${key}@m10test.local`}, 'x', ${name}, ${role}) RETURNING id`;
    ids[key] = Number(row.id);
  };
  await mkUser('sales', 'sales', 'Salma Sales');
  await mkUser('otherSales', 'sales', 'Other Rep');
  await mkUser('pm', 'project_manager', 'Priya PM');
  await mkUser('leadVideo', 'team_lead', 'Lena Videolead');
  await mkUser('leadDesign', 'team_lead', 'Dara Designlead');
  await mkUser('ahmed', 'executive', 'Ahmed Editor');
  await mkUser('omar', 'executive', 'Omar Editor');
  await mkUser('sara', 'executive', 'Sara Designer');
  const member = (key: string, slug: string, isLead = false) =>
    sql`INSERT INTO department_members (user_id, department_id, is_lead) VALUES (${ids[key]}, ${ids[slug]}, ${isLead})`;
  await member('leadVideo', 'video', true);
  await member('leadDesign', 'design', true);
  await member('ahmed', 'video');
  await member('omar', 'video');
  await member('sara', 'design');

  const [client] = await sql<{ id: number }[]>`
    INSERT INTO clients (name, company_name, owner_user_id, created_by)
    VALUES ('M10 Test Acme', 'Acme Holdings', ${ids.sales}, ${ids.sales}) RETURNING id`;
  ids.client = Number(client.id);
  const [other] = await sql<{ id: number }[]>`
    INSERT INTO clients (name, owner_user_id, created_by)
    VALUES ('M10 Test Zenith', ${ids.otherSales}, ${ids.otherSales}) RETURNING id`;
  ids.otherClient = Number(other.id);

  // A: Video (Ahmed) + Design (Sara), delivered, with a revision about the thumbnail.
  const a = await fileProject(sales(), {
    clientId: ids.client, period: '2090-09', title: 'Autumn launch film', deadline: '2090-09-25',
    requiresPmQa: false,
    departments: [{ departmentId: ids.video, plannedDeliverables: 1 }, { departmentId: ids.design, plannedDeliverables: 1 }],
  });
  ids.projectA = a.projectId;
  codes.projectA = a.projectCode;
  await triageProject(pm(), {
    projectId: ids.projectA,
    teams: [
      { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 },
      { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 1 },
    ],
  });
  const teams = await sql<{ id: number; department_id: number }[]>`
    SELECT id, department_id FROM project_departments WHERE project_id = ${ids.projectA}`;
  const teamOf = (slug: string) => Number(teams.find((t) => Number(t.department_id) === ids[slug])!.id);
  const v = await createAssignment(leadVideo(), {
    projectDepartmentId: teamOf('video'), assigneeId: ids.ahmed, title: 'Cut', deliverableCount: 1, deliverableBaseName: 'Video',
  });
  const d = await createAssignment(leadDesign(), {
    projectDepartmentId: teamOf('design'), assigneeId: ids.sara, title: 'Thumb', deliverableCount: 1, deliverableBaseName: 'Thumbnail',
  });
  const upload = async (who: Actor, deliverableId: number, filename: string) => {
    const bytes = randomBytes(64);
    const { session } = await uploads.createUploadSession(who, { target: 'deliverable', deliverableId, filename, size: bytes.length });
    await uploads.appendChunk(who, session.id, 0, new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); },
    }));
    return uploads.completeUpload(who, session.id);
  };
  await upload(ahmed(), v.deliverableIds[0], 'Autumn_master_v1.mp4');
  await upload(actor('executive', { id: ids.sara }), d.deliverableIds[0], 'Thumb.png');
  const r1 = await reviewDeliverable(leadVideo(), { deliverableId: v.deliverableIds[0], decision: 'approved' });
  const r2 = await reviewDeliverable(leadDesign(), { deliverableId: d.deliverableIds[0], decision: 'approved' });
  await updateDelivery(sales(), { deliveryId: r1.deliveryId!, status: 'delivered' });
  await updateDelivery(sales(), { deliveryId: r2.deliveryId!, status: 'delivered' });
  await createRevision(sales(), {
    projectId: ids.projectA, title: 'Logo placement', clientFeedback: 'Move the logo to the top left.',
    deliverableIds: [d.deliverableIds[0]],
  });

  // B: Video only (Omar), planned, October.
  const b = await fileProject(sales(), {
    clientId: ids.client, period: '2090-10', title: 'Winter teaser', deadline: '2090-10-31',
    departments: [{ departmentId: ids.video, plannedDeliverables: 2 }],
  });
  ids.projectB = b.projectId;
  codes.projectB = b.projectCode;
  await triageProject(pm(), {
    projectId: ids.projectB, teams: [{ departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 2 }],
  });
  const [bTeam] = await sql<{ id: number }[]>`SELECT id FROM project_departments WHERE project_id = ${ids.projectB}`;
  await createAssignment(leadVideo(), {
    projectDepartmentId: Number(bTeam.id), assigneeId: ids.omar, title: 'Teaser', deliverableCount: 2,
  });

  // X: another rep's client, Design only, untouched.
  const x = await fileProject(otherSales(), {
    clientId: ids.otherClient, period: '2090-09', title: 'Zenith brochure',
    departments: [{ departmentId: ids.design, plannedDeliverables: 3 }],
  });
  ids.projectX = x.projectId;
}

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('what free text finds (brief §22)', { skip }, () => {
  test('by project name, code, client and company', async () => {
    assert.deepEqual(titles(await search.searchProjects(sales(), { q: 'autumn' })), ['Autumn launch film']);
    const byCode = await search.searchProjects(sales(), { q: codes.projectB.toLowerCase() });
    assert.deepEqual(titles(byCode), ['Winter teaser']);
    assert.deepEqual(byCode[0].matchedOn, ['code']);
    assert.deepEqual(titles(await search.searchProjects(sales(), { q: 'acme' })), ['Autumn launch film', 'Winter teaser']);
    assert.deepEqual(titles(await search.searchProjects(sales(), { q: 'Holdings' })), ['Autumn launch film', 'Winter teaser']);
  });

  test('by team lead, executive, deliverable and file name', async () => {
    // The PM sees every client, so these are pinned to the fixture's client.
    const c = ids.client;
    assert.deepEqual(titles(await search.searchProjects(pm(), { q: 'Videolead', clientId: c })), ['Autumn launch film', 'Winter teaser']);
    const byExec = await search.searchProjects(pm(), { q: 'Omar Editor', clientId: c });
    assert.deepEqual(titles(byExec), ['Winter teaser']);
    assert.deepEqual(byExec[0].matchedOn, ['executive']);
    assert.deepEqual(titles(await search.searchProjects(pm(), { q: 'Thumbnail 01', clientId: c })), ['Autumn launch film']);
    const byFile = await search.searchProjects(pm(), { q: 'autumn_master', clientId: c });
    assert.deepEqual(titles(byFile), ['Autumn launch film']);
    assert.ok(byFile[0].matchedOn.includes('file'));
  });

  test('by revision title or the client’s words', async () => {
    const hits = await search.searchProjects(sales(), { q: 'top left' });
    assert.deepEqual(titles(hits), ['Autumn launch film']);
    assert.deepEqual(hits[0].matchedOn, ['revision']);
    assert.equal(hits[0].openRevisions, 1);
  });

  test('a % or _ in the text is literal, not a wildcard', async () => {
    assert.deepEqual(await search.searchProjects(pm(), { q: '%' }), []);
    assert.deepEqual(titles(await search.searchProjects(pm(), { q: 'autumn_master' })), ['Autumn launch film']);
  });

  test('an empty search lists everything visible', async () => {
    const hits = await search.searchProjects(pm(), {});
    const mine = hits.filter((h) => h.clientName.startsWith('M10 Test'));
    assert.deepEqual(titles(mine), ['Autumn launch film', 'Winter teaser', 'Zenith brochure']);
    assert.ok(mine.every((h) => h.matchedOn.length === 0));
  });
});

describe('permissions apply to search results (brief §22)', { skip }, () => {
  test('an Executive cannot discover a project they are not on, even by a colleague’s name', async () => {
    assert.deepEqual(await search.searchProjects(ahmed(), { q: 'Omar' }), []);
    assert.deepEqual(await search.searchProjects(ahmed(), { q: 'Winter' }), []);
    assert.deepEqual(titles(await search.searchProjects(ahmed(), { q: 'acme' })), ['Autumn launch film']);
  });

  test('a Sales rep finds only their clients’ projects', async () => {
    assert.deepEqual(await search.searchProjects(sales(), { q: 'Zenith' }), []);
    assert.deepEqual(titles(await search.searchProjects(otherSales(), {})), ['Zenith brochure']);
  });

  test('a Team Lead finds only projects with work for their team', async () => {
    assert.deepEqual(titles(await search.searchProjects(leadDesign(), { q: 'acme' })), ['Autumn launch film']);
    assert.deepEqual(titles(await search.searchProjects(leadVideo(), { q: 'acme' })), ['Autumn launch film', 'Winter teaser']);
  });

  test('revision text is found only by those who can see the revision (§16)', async () => {
    // The revision is about the thumbnail: the Design lead sees it, the
    // Video lead — on the same project — does not, and cannot find the
    // project through it.
    assert.deepEqual(titles(await search.searchProjects(leadDesign(), { q: 'Logo placement' })), ['Autumn launch film']);
    assert.deepEqual(await search.searchProjects(leadVideo(), { q: 'Logo placement' }), []);
  });

  test('a deactivated account finds nothing', async () => {
    assert.deepEqual(await search.searchProjects({ ...pm(), isActive: false }, {}), []);
  });

  test('results carry no pricing', async () => {
    const [hit] = await search.searchProjects(sales(), { q: 'autumn' });
    assert.ok(!('priceAmount' in hit) && !('price_amount' in hit));
  });
});

describe('filters (brief §22)', { skip }, () => {
  const mine = async (who: Actor, filters: import('../src/lib/search/search').SearchFilters) =>
    titles((await search.searchProjects(who, { ...filters, clientId: ids.client })));

  test('status, team, team lead, executive', async () => {
    assert.deepEqual(await mine(pm(), { status: ['planned'] }), ['Winter teaser']);
    assert.deepEqual(await mine(pm(), { status: ['revision_required', 'planned'] }), ['Autumn launch film', 'Winter teaser']);
    assert.deepEqual(await mine(pm(), { departmentId: ids.design }), ['Autumn launch film']);
    assert.deepEqual(await mine(pm(), { teamLeadId: ids.leadDesign }), ['Autumn launch film']);
    assert.deepEqual(await mine(pm(), { executiveId: ids.omar }), ['Winter teaser']);
    assert.deepEqual(await mine(pm(), { executiveId: ids.ahmed, status: ['planned'] }), []);
  });

  test('delivery status and open revisions', async () => {
    assert.deepEqual(await mine(sales(), { deliveryStatus: 'delivered' }), ['Autumn launch film']);
    assert.deepEqual(await mine(sales(), { deliveryStatus: 'revision_required' }), ['Autumn launch film']);
    assert.deepEqual(await mine(sales(), { deliveryStatus: 'completed' }), []);
    assert.deepEqual(await mine(sales(), { openRevisions: true }), ['Autumn launch film']);
    const [hit] = await search.searchProjects(sales(), { q: 'autumn' });
    assert.equal(hit.latestDeliveryStatus, 'revision_required');
  });

  test('month and deadline range', async () => {
    assert.deepEqual(await mine(sales(), { period: '2090-10' }), ['Winter teaser']);
    assert.deepEqual(await mine(sales(), { period: '2090-13' }), ['Autumn launch film', 'Winter teaser'], 'a bad month is ignored');
    assert.deepEqual(await mine(sales(), { deadlineFrom: '2090-10-01' }), ['Winter teaser']);
    assert.deepEqual(await mine(sales(), { deadlineTo: '2090-09-30' }), ['Autumn launch film']);
    assert.deepEqual(await mine(sales(), { deadlineFrom: '2090-09-01', deadlineTo: '2090-10-31' }), ['Autumn launch film', 'Winter teaser']);
  });

  test('the filter bar offers people only to those who see across teams', async () => {
    const forPm = await search.searchOptions(pm());
    assert.equal(forPm.canFilterByPeople, true);
    assert.ok(forPm.teamLeads.some((u) => u.id === ids.leadVideo));
    assert.ok(forPm.executives.some((u) => u.id === ids.omar));
    assert.ok(!forPm.executives.some((u) => u.id === ids.leadVideo));

    const forAhmed = await search.searchOptions(ahmed());
    assert.equal(forAhmed.canFilterByPeople, false);
    assert.deepEqual(forAhmed.teamLeads, []);
    assert.deepEqual(forAhmed.clients.map((c) => c.id), [ids.client], 'only the client he works for');
  });
});

describe('query string parsing', { skip: false }, () => {
  test('reads every filter and drops what it does not recognise', async () => {
    const { parseSearchParams, hasAnyFilter } = await import('../src/lib/search/search');
    const filters = parseSearchParams({
      q: '  acme ', status: ['planned', 'bogus', 'qa'], team: '3', lead: 'x', executive: '0',
      client: '9', delivery: 'delivered', revisions: 'open', period: '2026-09', from: '2026-09-01', to: '',
    });
    assert.deepEqual(filters, {
      q: 'acme', status: ['planned', 'qa'], departmentId: 3, teamLeadId: null, executiveId: null,
      clientId: 9, deliveryStatus: 'delivered', openRevisions: true, period: '2026-09',
      deadlineFrom: '2026-09-01', deadlineTo: null,
    });
    assert.equal(hasAnyFilter(filters), true);
    assert.equal(hasAnyFilter(parseSearchParams({})), false);
    assert.equal(hasAnyFilter(parseSearchParams({ delivery: 'nope', status: 'bogus' })), false);
  });
});
