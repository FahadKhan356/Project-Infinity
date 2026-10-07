/**
 * Monthly reporting (brief §39) and the month folder (§33).
 *
 * One month of work for two clients, read back by Sales, the PM, a Team
 * Lead and two Executives: each gets the numbers over the projects they
 * could open, pricing only where it may be seen, and the CSV only with the
 * export grant.
 *
 * Needs DATABASE_URL pointing at a migrated database. Suites share one
 * database, so every fixture here is marked M13 and filed in 2091 — except
 * the month-archive fixture (§33, project F), filed under the same client in
 * January 2069 so the March figures never move.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import postgres from 'postgres';
import type { Actor, Permission, Role } from '../src/lib/authz/types';
import { csvCell, csvFilename, toCsv } from '../src/lib/reports/csv';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run report tests';

let sql: ReturnType<typeof postgres>;
let storageRoot: string;
let reports: typeof import('../src/lib/reports/monthly');
let exportReport: typeof import('../src/lib/reports/export').exportReport;
let access: typeof import('../src/lib/files/access');

const ids: Record<string, number> = {};
const codes: Record<string, string> = {};
const MARCH = { year: 2091, month: 3 };

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0, email: `${role}@m13test.local`, fullName: role, role,
    isActive: true, mustChangePassword: false,
    leadDepartmentIds: [], departmentIds: [], permissions: new Set<Permission>(), ...over,
  };
}
const sales = () => actor('sales', { id: ids.sales });
const otherSales = () => actor('sales', { id: ids.otherSales });
const pm = () => actor('project_manager', { id: ids.pm });
const leadVideo = () => actor('team_lead', { id: ids.leadVideo, leadDepartmentIds: [ids.video], departmentIds: [ids.video] });
// Leads carry no report access by role; this one has been granted exports.
const leadDesign = () => actor('team_lead', {
  id: ids.leadDesign, leadDepartmentIds: [ids.design], departmentIds: [ids.design],
  permissions: new Set<Permission>(['export_reports']),
});
const ahmed = () => actor('executive', { id: ids.ahmed, departmentIds: [ids.video] });
const sara = () => actor('executive', { id: ids.sara, departmentIds: [ids.design] });
// The one role that may still open a deleted file (files.delete).
const admin = () => actor('admin', { id: ids.admin });

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE '%@m13test.local'`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM notifications WHERE user_id IN (${users})`;
  await sql`DELETE FROM upload_sessions WHERE created_by IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'M13 Test%')`;
  await sql`DELETE FROM clients WHERE name LIKE 'M13 Test%'`;
  await sql`DELETE FROM files WHERE uploaded_by IN (${users})`;
  await sql`DELETE FROM department_members WHERE user_id IN (${users})`;
  await sql`DELETE FROM user_permissions WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE '%@m13test.local'`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2091`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2069`;
}

before(async () => {
  if (skip) return;
  storageRoot = await mkdtemp(path.join(tmpdir(), 'aktivacity-m13-'));
  process.env.STORAGE_ROOT = storageRoot;
  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });

  reports = await import('../src/lib/reports/monthly');
  ({ exportReport } = await import('../src/lib/reports/export'));
  access = await import('../src/lib/files/access');
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
  const mkUser = async (key: string, role: string) => {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES (${`${key}@m13test.local`}, 'x', ${key}, ${role}) RETURNING id`;
    ids[key] = Number(row.id);
  };
  for (const [k, r] of [
    ['sales', 'sales'], ['otherSales', 'sales'], ['pm', 'project_manager'],
    ['leadVideo', 'team_lead'], ['leadDesign', 'team_lead'], ['ahmed', 'executive'], ['sara', 'executive'],
    ['admin', 'admin'],
  ] as const) await mkUser(k, r);
  const member = (key: string, slug: string, isLead = false) =>
    sql`INSERT INTO department_members (user_id, department_id, is_lead) VALUES (${ids[key]}, ${ids[slug]}, ${isLead})`;
  await member('leadVideo', 'video', true);
  await member('leadDesign', 'design', true);
  await member('ahmed', 'video');
  await member('sara', 'design');

  const mkClient = async (key: string, name: string, owner: string) => {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO clients (name, owner_user_id, created_by) VALUES (${name}, ${ids[owner]}, ${ids[owner]}) RETURNING id`;
    ids[key] = Number(row.id);
  };
  await mkClient('alpha', 'M13 Test Alpha', 'sales');
  await mkClient('beta', 'M13 Test Beta', 'otherSales');

  const upload = async (who: Actor, deliverableId: number, filename: string) => {
    const bytes = randomBytes(64);
    const { session } = await uploads.createUploadSession(who, { target: 'deliverable', deliverableId, filename, size: bytes.length });
    await uploads.appendChunk(who, session.id, 0, new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); },
    }));
    return uploads.completeUpload(who, session.id);
  };
  const route = (projectId: number, teams: { slug: string; lead: string; n: number }[]) =>
    triageProject(pm(), {
      projectId,
      teams: teams.map((t) => ({ departmentId: ids[t.slug], teamLeadId: ids[t.lead], plannedDeliverables: t.n })),
    });
  const teamOf = async (projectId: number, slug: string) =>
    Number((await sql`SELECT id FROM project_departments WHERE project_id = ${projectId} AND department_id = ${ids[slug]}`)[0].id);
  const file = async (key: string, who: Actor, input: Parameters<typeof fileProject>[1]) => {
    const r = await fileProject(who, input);
    ids[key] = r.projectId;
    codes[key] = (await sql`SELECT project_code FROM projects WHERE id = ${r.projectId}`)[0].project_code;
  };

  // A (Alpha, March): Video ×2 for Ahmed — one delivered then reopened by a
  // revision, one waiting in lead QA — and Design ×1 for Sara, in lead QA.
  await file('projectA', sales(), {
    clientId: ids.alpha, period: '2091-03', title: 'A film', priceAmount: '10000.00', requiresPmQa: false,
    departments: [{ departmentId: ids.video, plannedDeliverables: 2 }, { departmentId: ids.design, plannedDeliverables: 1 }],
  });
  await route(ids.projectA, [{ slug: 'video', lead: 'leadVideo', n: 2 }, { slug: 'design', lead: 'leadDesign', n: 1 }]);
  const va = await createAssignment(leadVideo(), {
    projectDepartmentId: await teamOf(ids.projectA, 'video'), assigneeId: ids.ahmed, title: 'Cut',
    deliverableCount: 2, deliverableBaseName: 'Video',
  });
  const da = await createAssignment(leadDesign(), {
    projectDepartmentId: await teamOf(ids.projectA, 'design'), assigneeId: ids.sara, title: 'Thumb', deliverableCount: 1,
  });
  await upload(ahmed(), va.deliverableIds[0], 'v1.mp4');
  const ok = await reviewDeliverable(leadVideo(), { deliverableId: va.deliverableIds[0], decision: 'approved' });
  await updateDelivery(sales(), { deliveryId: ok.deliveryId!, status: 'delivered' });
  await upload(ahmed(), va.deliverableIds[1], 'v2.mp4');
  await upload(sara(), da.deliverableIds[0], 'thumb.png');
  await createRevision(sales(), {
    projectId: ids.projectA, title: 'Logo', clientFeedback: 'Move it.', deliverableIds: [va.deliverableIds[0]],
  });

  // B (Alpha, March): Design ×2 for Sara — one delivered, one not started.
  await file('projectB', sales(), {
    clientId: ids.alpha, period: '2091-03', title: 'B designs', priceAmount: '2500.00', requiresPmQa: false,
    departments: [{ departmentId: ids.design, plannedDeliverables: 2 }],
  });
  await route(ids.projectB, [{ slug: 'design', lead: 'leadDesign', n: 2 }]);
  const db = await createAssignment(leadDesign(), {
    projectDepartmentId: await teamOf(ids.projectB, 'design'), assigneeId: ids.sara, title: 'Posts',
    deliverableCount: 2, deliverableBaseName: 'Post',
  });
  await upload(sara(), db.deliverableIds[0], 'post-final.png');
  const okB = await reviewDeliverable(leadDesign(), { deliverableId: db.deliverableIds[0], decision: 'approved' });
  await updateDelivery(sales(), { deliveryId: okB.deliveryId!, status: 'delivered' });

  // C (Alpha, March): still in intake, Video requested. Its title is the
  // kind of text a spreadsheet would execute.
  await file('projectC', sales(), {
    clientId: ids.alpha, period: '2091-03', title: 'C new', priceAmount: '4000.00',
    departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
  });
  await sql`UPDATE projects SET title = '=HYPERLINK("http://x","C")' WHERE id = ${ids.projectC}`;

  // D (Alpha, April): a different month, never in March's figures.
  await file('projectD', sales(), {
    clientId: ids.alpha, period: '2091-04', title: 'D later', priceAmount: '999.00',
    departments: [{ departmentId: ids.design, plannedDeliverables: 1 }],
  });

  // E (Beta, March, the other rep's): Video ×1 for Ahmed, not started.
  await file('projectE', otherSales(), {
    clientId: ids.beta, period: '2091-03', title: 'E other', priceAmount: '7000.00',
    departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
  });
  await route(ids.projectE, [{ slug: 'video', lead: 'leadVideo', n: 1 }]);
  await createAssignment(leadVideo(), {
    projectDepartmentId: await teamOf(ids.projectE, 'video'), assigneeId: ids.ahmed, title: 'E cut', deliverableCount: 1,
  });

  // F (Alpha, January 2069 — this suite's own year, away from March): Video
  // ×2 for Ahmed. Reel 01 went through two versions — v1 rejected by the
  // lead, v2 approved — and Reel 02 has nothing on it. The archive (§33)
  // must list both versions with their verdicts, not only the current one.
  await file('projectF', sales(), {
    clientId: ids.alpha, period: '2069-01', title: 'F reels', priceAmount: '3000.00', requiresPmQa: false,
    departments: [{ departmentId: ids.video, plannedDeliverables: 2 }],
  });
  await route(ids.projectF, [{ slug: 'video', lead: 'leadVideo', n: 2 }]);
  const fa = await createAssignment(leadVideo(), {
    projectDepartmentId: await teamOf(ids.projectF, 'video'), assigneeId: ids.ahmed, title: 'Reels',
    deliverableCount: 2, deliverableBaseName: 'Reel',
  });
  [ids.reel01, ids.reel02] = fa.deliverableIds;
  await upload(ahmed(), ids.reel01, 'reel-v1.mp4');
  await reviewDeliverable(leadVideo(), { deliverableId: ids.reel01, decision: 'rejected', comments: 'Wrong aspect ratio' });
  await upload(ahmed(), ids.reel01, 'reel-v2.mp4');
  await reviewDeliverable(leadVideo(), { deliverableId: ids.reel01, decision: 'approved' });
  ids.reelV1File = Number((await sql`
    SELECT f.id FROM files f JOIN deliverable_versions dv ON dv.file_id = f.id
    WHERE dv.deliverable_id = ${ids.reel01} AND dv.version_no = 1`)[0].id);
});

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
  await rm(storageRoot, { recursive: true, force: true });
});

const row = (r: Awaited<ReturnType<typeof reports.loadPortfolioReport>>, clientId: number) =>
  r.rows.find((x) => x.clientId === clientId);
const counts = (x: { projects: number; deliverables: number; completed: number; ready: number;
  inQa: number; inRevision: number; pending: number } | undefined) =>
  x && [x.projects, x.deliverables, x.completed, x.ready, x.inQa, x.inRevision, x.pending];

describe('CSV escaping', () => {
  test('quotes commas, quotes and newlines; neutralises formulas', () => {
    assert.equal(csvCell('plain'), 'plain');
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('two\nlines'), '"two\nlines"');
    assert.equal(csvCell('cr\rhere'), '"cr\rhere"');
    assert.equal(csvCell('=1+1'), "'=1+1");
    assert.equal(csvCell('+971 50'), "'+971 50");
    assert.equal(csvCell('-2'), "'-2");
    assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(csvCell('\tTAB'), "'\tTAB");
    assert.equal(csvCell('=HYPERLINK("x","y")'), `"'=HYPERLINK(""x"",""y"")"`);
    assert.equal(csvCell('a=b'), 'a=b', 'only a leading sign is a formula');
    assert.equal(csvCell(-2), '-2', 'numbers are ours and stay numeric');
    assert.equal(csvCell(42), '42');
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(undefined), '');
  });

  test('documents use CRLF and a BOM; filenames are safe', () => {
    assert.equal(toCsv([['a', 1], ['b,c', null]]), '﻿a,1\r\n"b,c",\r\n');
    assert.equal(csvFilename(['ABC Company "Ltd"', '2026-09']), 'abc-company-ltd-2026-09.csv');
    assert.equal(csvFilename(['../../etc', '']), 'etc.csv');
  });
});

describe('periods', () => {
  test('parse, fall back to the current month, and shift across years', async () => {
    const r = await import('../src/lib/reports/monthly');
    assert.deepEqual(r.parsePeriod('2091-03'), { year: 2091, month: 3 });
    assert.deepEqual(r.parsePeriod('2091-13', new Date(Date.UTC(2026, 8, 24))), { year: 2026, month: 9 });
    assert.deepEqual(r.parsePeriod(undefined, new Date(Date.UTC(2026, 8, 24))), { year: 2026, month: 9 });
    assert.deepEqual(r.shiftPeriod({ year: 2091, month: 1 }, -1), { year: 2090, month: 12 });
    assert.equal(r.periodValue({ year: 2091, month: 3 }), '2091-03');
  });
});

describe('who may open reports', { skip }, () => {
  test('PM, Sales and export grants yes; a plain lead or executive no', () => {
    assert.equal(reports.canViewReports(pm()), true);
    assert.equal(reports.canViewReports(sales()), true);
    assert.equal(reports.canViewReports(leadDesign()), true, 'granted export_reports');
    assert.equal(reports.canViewReports(leadVideo()), false);
    assert.equal(reports.canViewReports(ahmed()), false);
  });
});

describe('the monthly portfolio report', { skip }, () => {
  test('Sales: their client only, with every bucket, departments and order value', async () => {
    const r = await reports.loadPortfolioReport(sales(), MARCH);
    assert.equal(r.showPricing, true);
    assert.deepEqual(r.rows.map((x) => x.clientName), ['M13 Test Alpha'], 'not the other rep’s client');
    const alpha = row(r, ids.alpha)!;
    // A, B, C; D is April. 5 slots = 1 completed + 2 in QA + 1 in revision + 1 pending.
    assert.deepEqual(counts(alpha), [3, 5, 1, 0, 2, 1, 1]);
    assert.deepEqual(alpha.departments, ['Design', 'Video']);
    assert.deepEqual(alpha.value, { amount: '16500.00', currency: 'AED' });
    assert.deepEqual(counts(r.totals), counts(alpha));
    assert.deepEqual(r.totals.value, alpha.value);
    assert.deepEqual(r.departments.map((d) => [d.name, d.projects, d.deliverables]), [['Video', 2, 2], ['Design', 2, 3]]);
  });

  test('the other rep sees only Beta', async () => {
    const r = await reports.loadPortfolioReport(otherSales(), MARCH);
    assert.deepEqual(r.rows.map((x) => x.clientName), ['M13 Test Beta']);
    assert.deepEqual(counts(r.rows[0]), [1, 1, 0, 0, 0, 0, 1]);
    assert.equal(r.rows[0].value!.amount, '7000.00');
  });

  test('the PM sees both clients, with pricing', async () => {
    const r = await reports.loadPortfolioReport(pm(), MARCH);
    assert.deepEqual(counts(row(r, ids.alpha)), [3, 5, 1, 0, 2, 1, 1]);
    assert.deepEqual(counts(row(r, ids.beta)), [1, 1, 0, 0, 0, 0, 1]);
    assert.equal(row(r, ids.beta)!.value!.amount, '7000.00');
    assert.ok(r.totals.projects >= 4);
    assert.ok(Number(r.totals.value!.amount) >= 23500);
  });

  test('another month is another report', async () => {
    const r = await reports.loadPortfolioReport(sales(), { year: 2091, month: 4 });
    assert.deepEqual(counts(row(r, ids.alpha)), [1, 0, 0, 0, 0, 0, 0]);
    assert.equal(row(r, ids.alpha)!.value!.amount, '999.00');
  });

  test('an Executive: only the projects they work on, whole, and no pricing', async () => {
    const a = await reports.loadPortfolioReport(ahmed(), MARCH);
    assert.equal(a.showPricing, false);
    assert.deepEqual(counts(row(a, ids.alpha)), [1, 3, 0, 0, 2, 1, 0], 'A only — shared workspace, so Sara’s slot too');
    assert.deepEqual(counts(row(a, ids.beta)), [1, 1, 0, 0, 0, 0, 1]);
    assert.equal(row(a, ids.alpha)!.value, null);
    assert.equal(a.totals.value, null);

    const s = await reports.loadPortfolioReport(sara(), MARCH);
    assert.deepEqual(counts(row(s, ids.alpha)), [2, 5, 1, 0, 2, 1, 1], 'A and B');
    assert.equal(row(s, ids.beta), undefined);
  });

  test('a Team Lead: only their team’s slots and departments', async () => {
    const d = await reports.loadPortfolioReport(leadDesign(), MARCH);
    assert.equal(d.showPricing, false);
    assert.deepEqual(counts(row(d, ids.alpha)), [2, 3, 1, 0, 1, 0, 1], 'A’s thumbnail and B’s two posts');
    assert.deepEqual(row(d, ids.alpha)!.departments, ['Design']);
    assert.equal(row(d, ids.beta), undefined);
    assert.deepEqual(d.departments.map((x) => x.name), ['Design']);

    const v = await reports.loadPortfolioReport(leadVideo(), MARCH);
    // C asks for Video but is still in intake (no lead routed), so it is not the lead's yet (§4, §5).
    assert.deepEqual(counts(row(v, ids.alpha)), [1, 2, 0, 0, 1, 1, 0], 'A’s videos; C is unrouted, so not the lead’s yet');
    assert.deepEqual(counts(row(v, ids.beta)), [1, 1, 0, 0, 0, 0, 1]);
    assert.deepEqual(v.departments.map((x) => x.name), ['Video']);
  });
});

describe('the monthly client report', { skip }, () => {
  test('Sales: headline, projects, final files, revisions and people', async () => {
    const r = (await reports.loadClientReport(sales(), ids.alpha, MARCH))!;
    assert.equal(r.client.name, 'M13 Test Alpha');
    assert.equal(r.month?.status, 'open');
    assert.deepEqual(counts(r.headline), [3, 5, 1, 0, 2, 1, 1]);
    assert.deepEqual(r.headline.departments, ['Design', 'Video']);
    assert.equal(r.headline.value!.amount, '16500.00');

    assert.deepEqual(r.projects.map((p) => p.projectCode), [codes.projectA, codes.projectB, codes.projectC].sort());
    const a = r.projects.find((p) => p.id === ids.projectA)!;
    assert.equal(a.teams, 'Video, Design');
    assert.equal(a.status, 'revision_required');
    assert.deepEqual([a.approved, a.total], [0, 3], 'the reopened video no longer counts as approved');
    assert.equal(a.value!.amount, '10000.00');
    const b = r.projects.find((p) => p.id === ids.projectB)!;
    assert.deepEqual([b.approved, b.total], [1, 2]);
    assert.match(b.deliveredOn ?? '', /^\d{4}-\d{2}-\d{2}$/);

    assert.deepEqual(r.files.map((f) => [f.projectCode, f.originalFilename, f.status, f.versionNo]),
      [[codes.projectB, 'post-final.png', 'delivered', 1]]);
    assert.match(r.files[0].downloadUrl, /^\/api\/files\/[0-9a-f-]{36}$/);
    assert.ok(r.files[0].deliveredOn);

    assert.deepEqual(r.revisions.map((x) => [x.projectCode, x.revisionNo, x.title, x.deliverables]),
      [[codes.projectA, 1, 'Logo', 1]]);

    assert.deepEqual(r.people.map((p) => [p.fullName, p.department, p.isLead, p.slots]), [
      ['leadVideo', 'Video', true, 0],
      ['ahmed', 'Video', false, 2],
      ['leadDesign', 'Design', true, 0],
      ['sara', 'Design', false, 3],
    ]);
  });

  test('the month’s comments are on it, under the same scope as revisions (§33)', async () => {
    const [rev] = await sql<{ id: number }[]>`
      SELECT id FROM revisions WHERE project_id = ${ids.projectA} AND revision_no = 1`;
    await sql`INSERT INTO comments (author_id, body, project_id) VALUES (${ids.sara}, 'M13 first cut is up', ${ids.projectA})`;
    await sql`INSERT INTO comments (author_id, body, revision_id) VALUES (${ids.ahmed}, 'M13 logo moved', ${rev.id})`;
    try {
      const r = (await reports.loadClientReport(sales(), ids.alpha, MARCH))!;
      assert.deepEqual(r.comments.map((c) => [c.author, c.body, c.projectCode, c.about]), [
        ['sara', 'M13 first cut is up', codes.projectA, 'project'],
        ['ahmed', 'M13 logo moved', codes.projectA, 'Revision #01'],
      ]);
      const design = (await reports.loadClientReport(leadDesign(), ids.alpha, MARCH))!;
      assert.deepEqual(design.comments.map((c) => c.body), ['M13 first cut is up'], 'the Video revision stays out of view');
    } finally {
      await sql`DELETE FROM comments WHERE body LIKE 'M13 %'`;
    }
  });

  test('another rep cannot open it at all', async () => {
    assert.equal(await reports.loadClientReport(otherSales(), ids.alpha, MARCH), null);
  });

  test('an Executive: their project only, no pricing', async () => {
    const r = (await reports.loadClientReport(ahmed(), ids.alpha, MARCH))!;
    assert.deepEqual(r.projects.map((p) => p.id), [ids.projectA]);
    assert.equal(r.projects[0].value, null);
    assert.equal(r.headline.value, null);
    assert.deepEqual(r.files, []);
    assert.equal(r.revisions.length, 1, 'he is on project A (§16)');
  });

  test('the Design lead: Design only, and not the Video revision', async () => {
    const r = (await reports.loadClientReport(leadDesign(), ids.alpha, MARCH))!;
    assert.deepEqual(r.projects.map((p) => p.id).sort(), [ids.projectA, ids.projectB].sort());
    assert.equal(r.projects.find((p) => p.id === ids.projectA)!.teams, 'Design');
    assert.deepEqual(r.files.map((f) => f.originalFilename), ['post-final.png']);
    assert.deepEqual(r.revisions, []);
    assert.deepEqual([...new Set(r.people.map((p) => p.department))], ['Design']);
    assert.equal(r.projects[0].value, null);
  });

  test('a month with nothing filed reads as empty, not missing', async () => {
    const r = (await reports.loadClientReport(sales(), ids.alpha, { year: 2091, month: 5 }))!;
    assert.equal(r.month, null);
    assert.deepEqual(counts(r.headline), [0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(r.projects, []);
    assert.deepEqual(r.deliverables, []);
  });
});

describe('the month archive lists every slot and every version (§33)', { skip }, () => {
  const JAN = { year: 2069, month: 1 };
  const versionKey = (v: { versionNo: number; originalFilename: string; uploadedBy: string; qaStatus: string; reviews: unknown[] }) =>
    [v.versionNo, v.originalFilename, v.uploadedBy, v.qaStatus, v.reviews.length];

  test('Sales: every slot, with a rejected v1 and an approved v2, while Final files keeps only the current version', async () => {
    const r = (await reports.loadClientReport(sales(), ids.alpha, JAN))!;
    assert.deepEqual(r.projects.map((p) => p.projectCode), [codes.projectF]);

    assert.deepEqual(r.deliverables.map((d) => d.id), [ids.reel01, ids.reel02], 'both slots, in sequence, whatever their state');
    for (const d of r.deliverables) {
      assert.equal(d.projectId, ids.projectF);
      assert.equal(d.projectCode, codes.projectF);
      assert.equal(d.department, 'Video');
      assert.equal(d.assignee, 'ahmed');
      assert.match(d.name, /Reel/);
    }
    assert.deepEqual(r.deliverables.map((d) => d.status), ['approved', 'pending']);
    assert.deepEqual(r.deliverables.map((d) => d.versions.length), [2, 0], 'a slot with nothing on it is still a slot');

    const reel01 = r.deliverables[0];
    assert.deepEqual(reel01.versions.map(versionKey), [
      [1, 'reel-v1.mp4', 'ahmed', 'rejected', 1],
      [2, 'reel-v2.mp4', 'ahmed', 'approved', 1],
    ], 'oldest first, each with the verdict it got');
    const [v1, v2] = reel01.versions;
    assert.deepEqual(
      [v1.reviews[0].stage, v1.reviews[0].decision, v1.reviews[0].reviewer, v1.reviews[0].comments],
      ['team_lead', 'rejected', 'leadVideo', 'Wrong aspect ratio'],
    );
    assert.deepEqual([v2.reviews[0].stage, v2.reviews[0].decision, v2.reviews[0].comments], ['team_lead', 'approved', null]);
    for (const v of reel01.versions) {
      assert.match(v.uploadedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.match(v.reviews[0].reviewedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.match(v.downloadUrl ?? '', /^\/api\/files\/[0-9a-f-]{36}$/);
      assert.equal(v.isDeleted, false);
      assert.equal(v.revisionNo, null);
      assert.equal(typeof v.sizeBytes, 'number');
    }

    // The Final files block is untouched: still the current version of
    // approved or delivered slots only.
    assert.deepEqual(r.files.map((f) => [f.projectCode, f.originalFilename, f.status, f.versionNo]),
      [[codes.projectF, 'reel-v2.mp4', 'approved', 2]]);
  });

  test('a deleted earlier version keeps its row but offers the link only where decideFileAccess allows', async () => {
    await sql`UPDATE files SET deleted_at = now(), deleted_by = ${ids.admin} WHERE id = ${ids.reelV1File}`;
    try {
      const rep = (await reports.loadClientReport(sales(), ids.alpha, JAN))!;
      const reel01 = rep.deliverables.find((d) => d.id === ids.reel01)!;
      assert.equal(reel01.versions.length, 2, 'the version is history, deleted file or not');
      assert.equal(reel01.versions[0].isDeleted, true);
      assert.equal(reel01.versions[0].downloadUrl, null, 'no link the download route would refuse');
      assert.equal(reel01.versions[0].qaStatus, 'rejected', 'its verdict stays on record');
      assert.equal(typeof reel01.versions[1].downloadUrl, 'string');

      const adm = (await reports.loadClientReport(admin(), ids.alpha, JAN))!;
      const admReel = adm.deliverables.find((d) => d.id === ids.reel01)!;
      assert.equal(admReel.versions[0].isDeleted, true);
      assert.equal(typeof admReel.versions[0].downloadUrl, 'string', 'files.delete may still open it');

      // Parity with the download route's own rule.
      const key = admReel.versions[0].downloadUrl!.replace('/api/files/', '');
      const ctx = await access.loadFileContext(key);
      assert.ok(ctx);
      assert.deepEqual(await access.decideFileAccess(sales(), ctx), { allowed: false, reason: 'deleted' });
      assert.deepEqual(await access.decideFileAccess(admin(), ctx), { allowed: true });
    } finally {
      await sql`UPDATE files SET deleted_at = NULL, deleted_by = NULL WHERE id = ${ids.reelV1File}`;
    }
  });

  test('scoping is the project’s: the Video lead and Ahmed see both slots, the Design lead sees no project', async () => {
    const lead = (await reports.loadClientReport(leadVideo(), ids.alpha, JAN))!;
    assert.deepEqual(lead.deliverables.map((d) => d.id), [ids.reel01, ids.reel02]);
    assert.deepEqual(lead.deliverables[0].versions.map((v) => v.versionNo), [1, 2]);

    const exec = (await reports.loadClientReport(ahmed(), ids.alpha, JAN))!;
    assert.deepEqual(exec.projects.map((p) => p.id), [ids.projectF]);
    assert.equal(exec.projects[0].value, null);
    assert.deepEqual(exec.deliverables.map((d) => d.id), [ids.reel01, ids.reel02]);
    assert.deepEqual(exec.deliverables[0].versions.map((v) => v.versionNo), [1, 2]);

    // F has no Design team, so its lead cannot open the project at all.
    const design = (await reports.loadClientReport(leadDesign(), ids.alpha, JAN))!;
    assert.deepEqual(design.projects, []);
    assert.deepEqual(design.deliverables, []);
  });
});

describe('CSV export', { skip }, () => {
  test('refused without reports.export', async () => {
    for (const who of [sales(), ahmed(), leadVideo()]) {
      const r = await exportReport(who, { period: '2091-03' });
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.status, 403);
    }
  });

  test('the PM’s portfolio CSV carries pricing and a totals row', async () => {
    const r = await exportReport(pm(), { period: '2091-03' });
    assert.ok(r.ok);
    assert.equal(r.filename, 'aktivacity-report-2091-03.csv');
    const lines = r.csv.replace(/^﻿/, '').trimEnd().split('\r\n');
    assert.match(lines[0], /,Order value,Currency$/);
    assert.ok(lines.includes('M13 Test Alpha,3,5,1,0,2,1,1,"Design, Video",16500.00,AED'));
    assert.ok(lines.includes('M13 Test Beta,1,1,0,0,0,0,1,Video,7000.00,AED'));
    assert.match(lines.at(-1)!, /^Total,/);
  });

  test('a lead with the grant exports without pricing, and only their team', async () => {
    const r = await exportReport(leadDesign(), { period: '2091-03' });
    assert.ok(r.ok);
    assert.doesNotMatch(r.csv, /Order value|16500|10000/);
    assert.ok(r.csv.includes('M13 Test Alpha,2,3,1,0,1,0,1,Design\r\n'));
    assert.doesNotMatch(r.csv, /M13 Test Beta/);
  });

  test('the client CSV escapes a title a spreadsheet would execute', async () => {
    const r = await exportReport(pm(), { period: '2091-03', client: String(ids.alpha) });
    assert.ok(r.ok);
    assert.equal(r.kind, 'client');
    assert.equal(r.filename, 'm13-test-alpha-2091-03.csv');
    assert.ok(r.csv.includes(`"'=HYPERLINK(""http://x"",""C"")"`));
    // A's first video was delivered before the revision reopened it, so A has a delivered date.
    assert.match(r.csv, new RegExp(`${codes.projectA},A film,revision_required,"Video, Design",0,3,,\\d{4}-\\d{2}-\\d{2},10000\\.00,AED\r\n`));
  });

  test('a client outside the exporter’s scope is not found', async () => {
    const outsider = actor('sales', { id: ids.otherSales, permissions: new Set<Permission>(['export_reports']) });
    const r = await exportReport(outsider, { period: '2091-03', client: String(ids.alpha) });
    assert.equal(!r.ok && r.status, 404);
    const bad = await exportReport(pm(), { period: '2091-03', client: 'abc' });
    assert.equal(!bad.ok && bad.status, 404);
  });
});
