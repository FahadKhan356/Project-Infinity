/**
 * The client record and its months (brief §31–§39), third pass.
 *
 *   §31  a client starts on the day it is booked, or the day a prospect is
 *        won or switched to active — never left blank by accident
 *   §35  "Current month" is the open month holding today, in UTC; a month
 *        opened early for planning does not push it out of view
 *   §36  the nightly archive closes settled months on its own clock, says
 *        so in the feed, and holds against a write that is still in flight
 *   §37  "+ Create October 2026" offers the month after the newest on
 *        record, and opening one twice changes nothing
 *   §38  a copy may add a production team the source did not have; a
 *        copied repeating order keeps repeating from the copy
 *   §39  the month line on the client page and the month report count the
 *        same way for the same person, and the report also shows the
 *        month's comments and complete activity
 *
 * Fourth pass, same sections:
 *
 *   §35  the client overview puts the current month on top with each order's
 *        progress as a percentage, keeps months opened ahead apart, and folds
 *        every earlier month, with its status, under "View previous months"
 *   §36  a month management reopened stays open until closed by hand; a
 *        cancelled order with an approved file still to deliver holds its
 *        month; closing a month closes its delivered revisions; the archive
 *        can be held to given clients, as this suite holds it to its own
 *   §37  the "+ Create month" notices, and the month's own lines (opened,
 *        closed, reopened, copied into) in its report, through the actions
 *   §38  a "?to=" that is not a month is the field's error, not a 404
 *   §39  the month line counts cancelled orders apart, as the list beneath
 *        it keeps them
 *
 * Needs DATABASE_URL pointing at a migrated database. Suites share one
 * database, so every fixture here is filed in 2075 (the overview client's
 * in 2070), named "W3 clients …" and owned by @w3clients.local users; only
 * those are purged.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
// First of the Next imports, as in Next's own server: it provides the
// AsyncLocalStorage that request scopes (cookies(), headers()) live in.
import 'next/dist/server/node-environment-baseline';
import { NextRequest } from 'next/server';
import { workAsyncStorage } from 'next/dist/server/app-render/work-async-storage.external';
import { workUnitAsyncStorage } from 'next/dist/server/app-render/work-unit-async-storage.external';
import { createRequestStoreForAPI } from 'next/dist/server/async-storage/request-store';
import { createWorkStore } from 'next/dist/server/async-storage/work-store';
import postgres from 'postgres';
import type { Actor, Permission, Role } from '../src/lib/authz/types';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run the client tests';

let sql: ReturnType<typeof postgres>;
let storageRoot: string;

let lifecycle: typeof import('../src/lib/months/lifecycle');
let copy: typeof import('../src/lib/months/copy');
let queries: typeof import('../src/lib/months/queries');
let reports: typeof import('../src/lib/reports/monthly');
let profile: typeof import('../src/lib/clients/profile');
let pipeline: typeof import('../src/lib/pipeline/opportunities');
let uploads: typeof import('../src/lib/files/uploads');
let getDb: typeof import('../src/db').getDb;
let q: typeof import('drizzle-orm').sql;
let fileProject: typeof import('../src/lib/projects/file-project').fileProject;
let triageProject: typeof import('../src/lib/projects/triage').triageProject;
let createAssignment: typeof import('../src/lib/planning/assign').createAssignment;
let reviewDeliverable: typeof import('../src/lib/qa/review').reviewDeliverable;
let updateDelivery: typeof import('../src/lib/delivery/deliveries').updateDelivery;
let createRevision: typeof import('../src/lib/revisions/revisions').createRevision;
let addComment: typeof import('../src/lib/workspace/comments').addComment;
let changeProjectStatus: typeof import('../src/lib/projects/status').changeProjectStatus;
let shareProject: typeof import('../src/lib/projects/viewers').shareProject;
let runRecurring: typeof import('../src/lib/projects/recurring').runRecurring;

const ids: Record<string, number> = {};
const codes: Record<string, string> = {};
const DOMAIN = '@w3clients.local';
const SEPT = { year: 2075, month: 9 };
const JUNE = { year: 2075, month: 6 };
/** The archive's clock for most of the suite: a week and a half into October. */
const AS_OF = new Date('2075-10-15T03:00:00Z');
const at = (month: number) => new Date(Date.UTC(2075, month - 1, 1, 3));

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
const admin = () => actor('admin', { id: ids.admin });
const leadVideo = () => actor('team_lead', { id: ids.leadVideo, leadDepartmentIds: [ids.video], departmentIds: [ids.video] });
const leadDesign = () => actor('team_lead', { id: ids.leadDesign, leadDepartmentIds: [ids.design], departmentIds: [ids.design] });
/** The Design lead with an export grant: the only way a lead opens /reports. */
const leadDesignReports = () => actor('team_lead', {
  id: ids.leadDesign, leadDepartmentIds: [ids.design], departmentIds: [ids.design],
  permissions: new Set<Permission>(['export_reports']),
});
const ahmed = () => actor('executive', { id: ids.ahmed, departmentIds: [ids.video] });
const sara = () => actor('executive', { id: ids.sara, departmentIds: [ids.design] });

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE ${'%' + DOMAIN}`;
  const mine = sql`SELECT id FROM clients WHERE name LIKE 'W3 clients %'`;
  // The archive writes with no actor, so its lines are found by client.
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users}) OR client_id IN (${mine})`;
  await sql`DELETE FROM opportunities WHERE client_id IN (${mine})`;
  await sql`DELETE FROM upload_sessions WHERE created_by IN (${users})`;
  await sql`DELETE FROM sessions WHERE user_id IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (${mine})`;
  await sql`DELETE FROM clients WHERE name LIKE 'W3 clients %'`;
  await sql`DELETE FROM files WHERE uploaded_by IN (${users})`;
  await sql`DELETE FROM notifications WHERE user_id IN (${users})`;
  await sql`DELETE FROM department_members WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE ${'%' + DOMAIN}`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2075`;
  await sql`DELETE FROM project_code_sequence WHERE period_year = 2070`;
}

const stream = (b: Buffer) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(b)); c.close(); } });
async function upload(who: Actor, deliverableId: number, filename: string) {
  const b = randomBytes(64);
  const { session } = await uploads.createUploadSession(who, { target: 'deliverable', deliverableId, filename, size: b.length });
  await uploads.appendChunk(who, session.id, 0, stream(b));
  return uploads.completeUpload(who, session.id);
}

const monthRow = async (id: number) =>
  (await sql<{ status: string; closed_by: number | null }[]>`SELECT status, closed_by FROM client_months WHERE id = ${id}`)[0];
const clientRow = async (id: number) =>
  (await sql<{ status: string; started_on: string | null; today: boolean | null }[]>`
    SELECT status::text AS status, started_on::text AS started_on, (started_on = current_date) AS today
    FROM clients WHERE id = ${id}`)[0];
const teamsOf = (projectId: number) => sql<{ slug: string; planned: number; lead: number | null }[]>`
  SELECT d.slug, pd.planned_deliverables AS planned, pd.team_lead_id AS lead
  FROM project_departments pd JOIN departments d ON d.id = pd.department_id
  WHERE pd.project_id = ${projectId} ORDER BY d.slug`;
const copiesOf = (projectId: number) => sql<{ id: number; recurs_monthly: boolean; period_month: number }[]>`
  SELECT p.id, p.recurs_monthly, cm.period_month
  FROM projects p JOIN client_months cm ON cm.id = p.client_month_id
  WHERE p.copied_from_project_id = ${projectId} AND cm.period_year = 2075 ORDER BY cm.period_month`;
const counts = (x: { projects: number; deliverables: number; completed: number; ready: number;
  inQa: number; inRevision: number; pending: number }) =>
  [x.projects, x.deliverables, x.completed, x.ready, x.inQa, x.inRevision, x.pending];
const septemberOf = async (who: Actor, clientId = ids.retainer) =>
  (await queries.monthSummaries(who, clientId)).find((m) => m.year === 2075 && m.month === 9)!;

/** Waits until some session is blocked on a row lock in a statement containing `fragment`. */
async function waitForLockWait(fragment: string, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND query ILIKE ${'%' + fragment + '%'}`;
    if (n > 0) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** A hand-off between two sides of a race: one side waits at `gate`, the other opens it. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return { open, opened };
}

/**
 * Runs `fn` the way Next runs a server action: inside a request scope whose
 * cookie is a real session for `userId`, so the actor is resolved by the
 * data access layer exactly as in production — the same scaffolding as
 * tests/w3-qa.test.ts. revalidatePath() needs an incremental cache on the
 * work store, so a stub is supplied.
 */
async function asUser<T>(userId: number, url: string, fn: () => Promise<T>): Promise<T> {
  const [session] = await sql<{ id: string }[]>`
    INSERT INTO sessions (user_id, expires_at) VALUES (${userId}, now() + interval '1 hour')
    RETURNING id::text AS id`;
  const request = new NextRequest(url, { headers: { cookie: `aktivacity_session=${session.id}` } });
  const requestStore = createRequestStoreForAPI(
    request, request.nextUrl, undefined as never, undefined, undefined as never, undefined,
  );
  const workStore = createWorkStore({
    page: '/test',
    renderOpts: { experimental: {}, supportsDynamicResponse: true, incrementalCache: {} } as never,
    buildId: 'test',
    deploymentId: 'test',
    previouslyRevalidatedTags: [],
  });
  try {
    return await workUnitAsyncStorage.run(requestStore, () => workAsyncStorage.run(workStore, fn));
  } finally {
    await sql`DELETE FROM sessions WHERE id = ${session.id}::uuid`;
  }
}

before(async () => {
  if (skip) return;
  try { await setUp(); } catch (error) {
    console.error('\n[w3-clients.test] fixture setup failed:', error);
    throw error;
  }
});

async function setUp() {
  // Next compiles pages, actions and route handlers for its server layer,
  // where `next/navigation` is the react-server build (see next's
  // build/create-compiler-aliases.js). Plain Node has no such alias, so the
  // same substitution is made here before anything that redirects loads.
  const load = createRequire(__filename);
  const serverNavigation = load.resolve('next/dist/client/components/navigation.react-server');
  load(serverNavigation);
  load.cache[load.resolve('next/navigation')] = load.cache[serverNavigation];

  // A directory of this run's own: never adopt the caller's STORAGE_ROOT,
  // which other suites share and the sweep below would remove.
  storageRoot = await mkdtemp(path.join(tmpdir(), 'aktivacity-w3c-'));
  process.env.STORAGE_ROOT = storageRoot;
  sql = postgres(DATABASE_URL!, { max: 3, onnotice: () => {} });

  lifecycle = await import('../src/lib/months/lifecycle');
  copy = await import('../src/lib/months/copy');
  queries = await import('../src/lib/months/queries');
  reports = await import('../src/lib/reports/monthly');
  profile = await import('../src/lib/clients/profile');
  pipeline = await import('../src/lib/pipeline/opportunities');
  uploads = await import('../src/lib/files/uploads');
  ({ getDb } = await import('../src/db'));
  ({ sql: q } = await import('drizzle-orm'));
  ({ fileProject } = await import('../src/lib/projects/file-project'));
  ({ triageProject } = await import('../src/lib/projects/triage'));
  ({ createAssignment } = await import('../src/lib/planning/assign'));
  ({ reviewDeliverable } = await import('../src/lib/qa/review'));
  ({ updateDelivery } = await import('../src/lib/delivery/deliveries'));
  ({ createRevision } = await import('../src/lib/revisions/revisions'));
  ({ addComment } = await import('../src/lib/workspace/comments'));
  ({ changeProjectStatus } = await import('../src/lib/projects/status'));
  ({ shareProject } = await import('../src/lib/projects/viewers'));
  ({ runRecurring } = await import('../src/lib/projects/recurring'));
  await purge();

  for (const slug of ['video', 'design', 'seo', 'social']) {
    ids[slug] = Number((await sql`SELECT id FROM departments WHERE slug = ${slug}`)[0].id);
  }
  for (const [key, role] of [
    ['sales', 'sales'], ['otherSales', 'sales'], ['pm', 'project_manager'], ['admin', 'admin'],
    ['leadVideo', 'team_lead'], ['leadDesign', 'team_lead'], ['ahmed', 'executive'], ['sara', 'executive'],
  ] as const) {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role, must_change_password)
      VALUES (${key + DOMAIN}, 'x', ${key}, ${role}, false) RETURNING id`;
    ids[key] = Number(row.id);
  }
  for (const [key, slug, lead] of [
    ['leadVideo', 'video', true], ['leadDesign', 'design', true], ['ahmed', 'video', false], ['sara', 'design', false],
  ] as const) {
    await sql`INSERT INTO department_members (user_id, department_id, is_lead) VALUES (${ids[key]}, ${ids[slug]}, ${lead})`;
  }
  for (const [key, name, owner, status, startedOn] of [
    ['retainer', 'W3 clients Retainer', ids.sales, 'active', '2074-01-01'],
    ['shared', 'W3 clients Shared', ids.otherSales, 'active', '2074-01-01'],
    ['prospect', 'W3 clients Prospect', ids.sales, 'prospect', null],
    ['prospectDated', 'W3 clients Prospect Dated', ids.sales, 'prospect', '2073-06-01'],
  ] as const) {
    const [c] = await sql<{ id: number }[]>`
      INSERT INTO clients (name, owner_user_id, created_by, status, started_on)
      VALUES (${name}, ${owner}, ${owner}, ${status}, ${startedOn}) RETURNING id`;
    ids[key] = Number(c.id);
  }

  // September: project A with one slot in each bucket, and B cancelled.
  const a = await fileProject(sales(), {
    clientId: ids.retainer, period: '2075-09', title: 'Autumn campaign', requiresPmQa: false,
    priceAmount: '12000.00', deadline: '2075-09-20',
    departments: [{ departmentId: ids.video, plannedDeliverables: 3 }, { departmentId: ids.design, plannedDeliverables: 2 }],
  });
  ids.projectA = a.projectId;
  ids.september = a.clientMonthId;
  codes.projectA = a.projectCode;
  await triageProject(pm(), {
    projectId: ids.projectA,
    teams: [
      { departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 3 },
      { departmentId: ids.design, teamLeadId: ids.leadDesign, plannedDeliverables: 2 },
    ],
  });
  for (const t of await sql<{ id: number; department_id: number }[]>`
      SELECT id, department_id FROM project_departments WHERE project_id = ${ids.projectA}`) {
    if (Number(t.department_id) === ids.video) ids.videoTeam = Number(t.id);
    if (Number(t.department_id) === ids.design) ids.designTeam = Number(t.id);
  }
  const v = await createAssignment(leadVideo(), {
    projectDepartmentId: ids.videoTeam, assigneeId: ids.ahmed, title: 'Cut', deliverableCount: 3, deliverableBaseName: 'Video',
  });
  [ids.video01, ids.video02, ids.video03] = v.deliverableIds;
  const d = await createAssignment(leadDesign(), {
    projectDepartmentId: ids.designTeam, assigneeId: ids.sara, title: 'Key visuals', deliverableCount: 2, deliverableBaseName: 'Design',
  });
  [ids.design01, ids.design02] = d.deliverableIds;
  // video01: delivered (completed). video02: approved (ready). video03: in QA.
  await upload(ahmed(), ids.video01, 'v1.mp4');
  const ok1 = await reviewDeliverable(leadVideo(), { deliverableId: ids.video01, decision: 'approved' });
  await updateDelivery(sales(), { deliveryId: ok1.deliveryId!, status: 'delivered' });
  await upload(ahmed(), ids.video02, 'v2.mp4');
  await reviewDeliverable(leadVideo(), { deliverableId: ids.video02, decision: 'approved' });
  await upload(ahmed(), ids.video03, 'v3.mp4');
  // design01: delivered, then reopened by a revision (in revision). design02: untouched (pending).
  await upload(sara(), ids.design01, 'kv1.png');
  const okD = await reviewDeliverable(leadDesign(), { deliverableId: ids.design01, decision: 'approved' });
  await updateDelivery(sales(), { deliveryId: okD.deliveryId!, status: 'delivered' });
  await createRevision(sales(), {
    projectId: ids.projectA, title: 'Logo swap', clientFeedback: 'Use the new logo.', deliverableIds: [ids.design01],
  });

  const b = await fileProject(sales(), {
    clientId: ids.retainer, period: '2075-09', title: 'Dropped SEO', priceAmount: '900.00',
    departments: [{ departmentId: ids.seo, plannedDeliverables: 3 }],
  });
  ids.projectB = b.projectId;
  await changeProjectStatus(pm(), { projectId: ids.projectB, change: 'cancel', reason: 'Client dropped SEO' });

  // June: settled — one completed, one cancelled. July: an order still new.
  // August and May: opened, empty. April: closed, empty.
  const dd = await fileProject(sales(), {
    clientId: ids.retainer, period: '2075-06', title: 'June film',
    departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
  });
  ids.projectD = dd.projectId;
  ids.june = dd.clientMonthId;
  await sql`UPDATE projects SET status = 'completed', completed_at = now() WHERE id = ${ids.projectD}`;
  // A revision on the June film that was reworked and delivered again, and never closed.
  ids.juneRevision = Number((await sql<{ id: number }[]>`
    INSERT INTO revisions (project_id, revision_no, title, client_feedback, created_by, status)
    VALUES (${ids.projectD}, 1, 'Colour pass', 'Warmer grade, please.', ${ids.sales}, 'delivered') RETURNING id`)[0].id);
  const e = await fileProject(sales(), {
    clientId: ids.retainer, period: '2075-06', title: 'June extra',
    departments: [{ departmentId: ids.design, plannedDeliverables: 1 }],
  });
  ids.projectE = e.projectId;
  await sql`UPDATE projects SET status = 'cancelled' WHERE id = ${ids.projectE}`;
  const f = await fileProject(sales(), {
    clientId: ids.retainer, period: '2075-07', title: 'July retainer',
    departments: [{ departmentId: ids.video, plannedDeliverables: 2 }],
  });
  ids.projectF = f.projectId;
  ids.july = f.clientMonthId;
  for (const [key, month, status] of [['august', 8, 'open'], ['may', 5, 'open'], ['april', 4, 'closed']] as const) {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO client_months (client_id, period_year, period_month, status, closed_at, closed_by, created_by)
      VALUES (${ids.retainer}, 2075, ${month}, ${status}, ${status === 'closed' ? sql`now()` : null},
              ${status === 'closed' ? ids.pm : null}, ${ids.sales}) RETURNING id`;
    ids[key] = Number(row.id);
  }

  // Another rep's client, with one project shared with our rep to view.
  const s = await fileProject(otherSales(), {
    clientId: ids.shared, period: '2075-09', title: 'Shared launch', priceAmount: '3000.00',
    departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
  });
  ids.projectS = s.projectId;
  codes.projectS = s.projectCode;
  await shareProject(pm(), { projectId: ids.projectS, userId: ids.sales });
}

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('the current month and the next one to open (brief §35, §37)', () => {
  const m = (year: number, month: number, status: 'open' | 'closed') => ({ id: year * 100 + month, year, month, status });
  const planned = [m(2075, 11, 'open'), m(2075, 10, 'open'), m(2075, 9, 'closed')];

  test('"Current month" is the open month holding today, not a month opened for planning', async () => {
    const { currentMonthOf } = await import('../src/lib/months/queries');
    assert.equal(currentMonthOf(planned, new Date('2075-10-15T00:00:00Z'))?.month, 10);
    assert.equal(currentMonthOf(planned, new Date('2075-12-03T00:00:00Z'))?.month, 11, 'nothing open in December: the newest open month');
    assert.equal(currentMonthOf([m(2075, 9, 'closed')], new Date('2075-10-15T00:00:00Z')), null, 'all closed');
    assert.equal(currentMonthOf([], new Date('2075-10-15T00:00:00Z')), null);
    assert.equal(currentMonthOf([m(2075, 10, 'open'), m(2075, 11, 'open')], new Date('2075-12-03T00:00:00Z'))?.month, 11,
      'newest open, whatever the order given');
  });

  test('the pick is made in UTC, like every other month in the portal', async () => {
    const { currentMonthOf } = await import('../src/lib/months/queries');
    // 23:30 UTC on 31 October is already 1 November in Dubai; the month is still October.
    assert.equal(currentMonthOf(planned, new Date('2075-10-31T23:30:00Z'))?.month, 10);
    assert.equal(currentMonthOf(planned, new Date('2075-11-01T00:30:00Z'))?.month, 11);
  });

  test('"+ Create …" offers the month after the newest on record, never one behind us', async () => {
    const { nextMonthToOpen } = await import('../src/lib/months/queries');
    const today = new Date('2075-10-15T00:00:00Z');
    assert.deepEqual(nextMonthToOpen(planned, today), { year: 2075, month: 12 }, 'November is open, so December');
    assert.deepEqual(nextMonthToOpen([m(2075, 9, 'open')], today), { year: 2075, month: 10 });
    assert.deepEqual(nextMonthToOpen([m(2075, 3, 'closed')], today), { year: 2075, month: 10 }, 'a dormant client: this month');
    assert.deepEqual(nextMonthToOpen([], today), { year: 2075, month: 10 }, 'a first month: this month');
    assert.deepEqual(nextMonthToOpen([m(2075, 12, 'open')], new Date('2075-12-31T23:00:00Z')), { year: 2076, month: 1 });
  });

  test('progress is a whole-number percentage of approved over total, and nothing while there are no slots', async () => {
    const { progressPercent } = await import('../src/lib/months/queries');
    assert.equal(progressPercent(0, 0), null, 'an order not yet routed has nothing to measure');
    assert.equal(progressPercent(6, 10), 60);
    assert.equal(progressPercent(18, 20), 90);
    assert.equal(progressPercent(2, 3), 67);
    assert.equal(progressPercent(1, 3), 33);
    assert.equal(progressPercent(3, 3), 100);
  });

  test('this month on top, months opened ahead apart, and everything earlier under "previous"', async () => {
    const { groupMonths } = await import('../src/lib/months/queries');
    const history = [m(2075, 11, 'open'), m(2075, 10, 'open'), m(2075, 9, 'closed'), m(2075, 8, 'open')];
    const idsOf = (list: { id: number }[]) => list.map((x) => x.id);

    const october = groupMonths(history, new Date('2075-10-15T00:00:00Z'));
    assert.equal(october.current?.id, 207510);
    assert.deepEqual(idsOf(october.upcoming), [207511], 'a month opened ahead for planning is never filed as previous');
    assert.deepEqual(idsOf(october.previous), [207509, 207508], 'newest first, open or closed');

    const december = groupMonths(history, new Date('2075-12-03T00:00:00Z'));
    assert.equal(december.current?.id, 207511, 'nothing open in December: the newest open month stands in');
    assert.deepEqual(idsOf(december.upcoming), []);
    assert.deepEqual(idsOf(december.previous), [207510, 207509, 207508], 'and everything else is previous');

    const settled = groupMonths([m(2075, 8, 'closed'), m(2075, 10, 'closed'), m(2075, 9, 'closed')], new Date('2075-10-15T00:00:00Z'));
    assert.equal(settled.current, null);
    assert.deepEqual(idsOf(settled.upcoming), []);
    assert.deepEqual(idsOf(settled.previous), [207510, 207509, 207508], 'no current month: all previous, newest first');

    const none = groupMonths([], new Date('2075-10-15T00:00:00Z'));
    assert.deepEqual([none.current, none.upcoming, none.previous], [null, [], []]);
  });

  test('the feed says when the archive closed a month, and who closed it otherwise', async () => {
    const { describeActivity } = await import('../src/lib/activity/describe');
    const automatic = describeActivity({
      action: 'client.month_closed', actorName: null, metadata: { year: 2091, month: 9, automatic: true },
    });
    assert.match(automatic, /automatically/);
    assert.match(automatic, /September 2091/);
    assert.doesNotMatch(automatic, /Someone/);
    assert.equal(describeActivity({ action: 'client.month_closed', actorName: 'sales', metadata: { year: 2091, month: 9 } }),
      'sales closed September 2091');
  });
});

describe('the client record starts on a date (brief §31)', { skip }, () => {
  test('a new client starts today; a prospect has not started; bad input is refused', async () => {
    const fresh = await profile.createClientRecord(sales(), {
      name: ' W3 clients Fresh ', companyName: ' Fresh LLC ', clientType: 'retainer', status: 'active', notes: null,
    });
    assert.equal(fresh.name, 'W3 clients Fresh');
    const [row] = await sql`SELECT status::text AS status, (started_on = current_date) AS today, owner_user_id, company_name
      FROM clients WHERE id = ${fresh.clientId}`;
    assert.deepEqual([row.status, row.today, Number(row.owner_user_id), row.company_name],
      ['active', true, ids.sales, 'Fresh LLC'], 'the booking rep owns it');

    const lead = await profile.createClientRecord(sales(), {
      name: 'W3 clients Lead', companyName: null, clientType: 'one_off', status: 'prospect', notes: 'Met at the expo',
      startedOn: '2075-01-01',
    });
    ids.lead = lead.clientId;
    assert.deepEqual([(await clientRow(ids.lead)).status, (await clientRow(ids.lead)).started_on], ['prospect', null],
      'a prospect has no start date yet, whatever the form said');

    const dated = await profile.createClientRecord(admin(), {
      name: 'W3 clients Dated', companyName: null, clientType: 'retainer', status: 'active', notes: null, startedOn: '2074-03-15',
    });
    const [d] = await sql`SELECT started_on::text AS started_on, owner_user_id FROM clients WHERE id = ${dated.clientId}`;
    assert.deepEqual([d.started_on, d.owner_user_id], ['2074-03-15', null], 'an administrator books it for no rep in particular');
    await assert.rejects(profile.createClientRecord(pm(), { ...dated, clientType: 'retainer', status: 'active', companyName: null, notes: null }),
      /not permitted/, 'a Project Manager does not book clients');

    const input = { name: 'W3 clients Bad', companyName: null, clientType: 'retainer' as const, status: 'active' as const, notes: null };
    await assert.rejects(profile.createClientRecord(sales(), { ...input, startedOn: '15/01/2024' }), /date/);
    await assert.rejects(profile.createClientRecord(sales(), { ...input, name: 'X' }), /name/);
    await assert.rejects(profile.createClientRecord(leadVideo(), input), /not permitted/);
    await assert.rejects(profile.createClientRecord(sales(), { ...input, name: 'w3 CLIENTS fresh' }), /already exists/);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM clients WHERE name LIKE 'W3 clients Bad%'`;
    assert.equal(n, 0, 'nothing was written by the refusals');
  });

  test('switching a prospect to active dates it today, unless the form says when', async () => {
    const base = { name: 'W3 clients Lead', companyName: null, clientType: 'one_off' as const, notes: 'Met at the expo' };
    const r = await profile.updateClientProfile(sales(), {
      clientId: ids.lead, profile: { ...base, status: 'active', startedOn: null },
    });
    assert.deepEqual(r.changed, ['status', 'start date']);
    assert.deepEqual([(await clientRow(ids.lead)).status, (await clientRow(ids.lead)).today], ['active', true]);

    const two = await profile.createClientRecord(sales(), { ...base, name: 'W3 clients Lead Two', status: 'prospect' });
    await profile.updateClientProfile(sales(), {
      clientId: two.clientId, profile: { ...base, name: 'W3 clients Lead Two', status: 'active', startedOn: '2075-02-02' },
    });
    assert.equal((await clientRow(two.clientId)).started_on, '2075-02-02');

    // An active client edited without a date keeps none: only the prospect switch fills it in.
    await profile.updateClientProfile(sales(), {
      clientId: two.clientId, profile: { ...base, name: 'W3 clients Lead Two', status: 'active', startedOn: null },
    });
    assert.equal((await clientRow(two.clientId)).started_on, null);
  });

  test('winning a deal from the pipeline activates the prospect and dates it', async () => {
    const won = await pipeline.createOpportunity(sales(), { clientId: ids.prospect, title: 'Social retainer', estimatedValue: 8000 });
    const p = await fileProject(sales(), {
      clientId: ids.prospect, period: '2075-09', title: 'Won retainer', opportunityId: won.id,
      departments: [{ departmentId: ids.video, plannedDeliverables: 2 }],
    });
    ids.projectWon = p.projectId;
    const row = await clientRow(ids.prospect);
    assert.deepEqual([row.status, row.today], ['active', true]);

    const known = await pipeline.createOpportunity(sales(), { clientId: ids.prospectDated, title: 'Web refresh' });
    await fileProject(sales(), {
      clientId: ids.prospectDated, period: '2075-09', title: 'Web refresh', opportunityId: known.id,
      departments: [{ departmentId: ids.design, plannedDeliverables: 1 }],
    });
    assert.deepEqual([(await clientRow(ids.prospectDated)).status, (await clientRow(ids.prospectDated)).started_on],
      ['active', '2073-06-01'], 'a date someone already knew is kept');
  });
});

describe('the month line and the month report count the same way (brief §35, §39)', { skip }, () => {
  test('Sales: every bucket once, cancelled orders left out, and the report agrees', async () => {
    const line = await septemberOf(sales());
    assert.deepEqual(counts(line), [1, 5, 1, 1, 1, 1, 1]);
    assert.deepEqual(line.departments, ['Design', 'Video'], 'the cancelled SEO order brings no team');
    assert.equal(line.cancelled, 1, 'the cancelled order is counted apart: the list beneath the line keeps it, marked');
    assert.equal(line.reopenedAt, null);
    const report = (await reports.loadClientReport(sales(), ids.retainer, SEPT))!;
    assert.deepEqual(counts(report.headline), counts(line));
    assert.deepEqual(report.headline.departments, line.departments);
    assert.deepEqual(report.projects.map((p) => p.id), [ids.projectA]);
  });

  test('the PM, the Executives and a lead with an export grant each see their own numbers on both pages', async () => {
    for (const [who, expected, departments, cancelled] of [
      [pm(), [1, 5, 1, 1, 1, 1, 1], ['Design', 'Video'], 1],
      [ahmed(), [1, 5, 1, 1, 1, 1, 1], ['Design', 'Video'], 0],
      [sara(), [1, 5, 1, 1, 1, 1, 1], ['Design', 'Video'], 0],
      [leadDesignReports(), [1, 2, 0, 0, 0, 1, 1], ['Design'], 0],
    ] as const) {
      const line = await septemberOf(who);
      const report = (await reports.loadClientReport(who, ids.retainer, SEPT))!;
      assert.deepEqual(counts(line), [...expected], `${who.role} line`);
      assert.equal(line.cancelled, cancelled, `${who.role} sees the cancelled SEO order only if they could open it`);
      assert.deepEqual(counts(report.headline), [...expected], `${who.role} report`);
      assert.deepEqual(line.departments, [...departments], `${who.role} teams`);
      assert.deepEqual(report.headline.departments, [...departments]);
    }
    const videoLead = await septemberOf(leadVideo());
    assert.deepEqual(counts(videoLead), [1, 3, 1, 1, 1, 0, 0], 'the Video lead: their three slots only');
    assert.deepEqual(videoLead.departments, ['Video']);
  });

  test('another rep sees nothing of the month and no report at all', async () => {
    assert.equal(counts(await septemberOf(otherSales()))[0], 0);
    assert.equal(await reports.loadClientReport(otherSales(), ids.retainer, SEPT), null);
  });

  test('a project shared with a rep is on their client page and in the month report, but not in their portfolio', async () => {
    const line = await septemberOf(sales(), ids.shared);
    assert.deepEqual(counts(line), [1, 0, 0, 0, 0, 0, 0]);
    const report = await reports.loadClientReport(sales(), ids.shared, SEPT);
    assert.ok(report, 'the Report button leads somewhere');
    assert.deepEqual(report.projects.map((p) => p.projectCode), [codes.projectS]);
    assert.equal(report.headline.projects, 1);
    const portfolio = await reports.loadPortfolioReport(sales(), SEPT);
    assert.equal(portfolio.rows.some((r) => r.clientId === ids.shared), false, 'a share is not part of the rep’s own book');
    assert.ok(portfolio.rows.some((r) => r.clientId === ids.retainer));
  });

  test('the month report carries each project’s comment count and the month’s complete activity', async () => {
    await addComment(ahmed(), { projectId: ids.projectA, body: 'First cut is up.' });
    await addComment(sara(), { deliverableId: ids.design02, body: 'Waiting on copy.' });
    const log = (actorId: number | null, action: string, projectId: number | null, metadata: Parameters<typeof sql.json>[0]) => sql`
      INSERT INTO activity_log (actor_id, action, entity_type, entity_id, project_id, client_id, metadata)
      VALUES (${actorId}, ${action}, 'project', ${projectId}, ${projectId}, ${ids.retainer}, ${sql.json(metadata)})`;
    await log(ids.sales, 'project.created', ids.projectA, { projectCode: codes.projectA });
    await log(ids.sales, 'project.details_edited', ids.projectA, { fields: ['price'] });
    await log(ids.ahmed, 'comment.posted', ids.projectA, {});
    await log(ids.ahmed, 'file.downloaded', ids.projectA, { filename: 'v1.mp4' });
    await log(ids.sales, 'project.created', ids.projectB, {});

    const r = (await reports.loadClientReport(sales(), ids.retainer, SEPT))!;
    assert.equal(r.projects.find((p) => p.id === ids.projectA)!.comments, 2, 'on the project and on a slot');
    const texts = r.activity.map((l) => l.text);
    // The QA verdicts of the fixture, what Sales received and delivered are on
    // the record from the library itself (lib/qa/review, lib/delivery), ahead
    // of the lines above and in the order the fixture did them.
    const verdicts = [
      'leadVideo approved Video 01 v1',
      'Sales received delivery of Video 01 v1',
      'sales delivered Video 01 to the client',
      'leadVideo approved Video 02 v1',
      'Sales received delivery of Video 02 v1',
      'leadDesign approved Design 01 v1',
      'Sales received delivery of Design 01 v1',
      'sales delivered Design 01 to the client',
    ];
    assert.deepEqual(texts, [
      ...verdicts,
      `sales created the project ${codes.projectA}`,
      'sales updated the project price',
      'ahmed commented',
    ], 'in order; downloads and the cancelled order are not part of it');

    const exec = (await reports.loadClientReport(ahmed(), ids.retainer, SEPT))!;
    assert.deepEqual(exec.activity.map((l) => l.text), [...verdicts, `sales created the project ${codes.projectA}`, 'ahmed commented'],
      'a price change is not news to someone who cannot see prices');
    const s = (await reports.loadClientReport(sales(), ids.shared, SEPT))!;
    assert.equal(s.projects[0].comments, 0);
  });
});

describe('opening the next month by hand (brief §37)', { skip }, () => {
  test('the first click creates the month; a second changes nothing and says so', async () => {
    const first = await lifecycle.openMonth(sales(), { clientId: ids.retainer, year: 2075, month: 11 });
    assert.deepEqual([first.created, first.status, first.year, first.month], [true, 'open', 2075, 11]);
    ids.november = first.clientMonthId;
    const again = await lifecycle.openMonth(sales(), { clientId: ids.retainer, year: 2075, month: 11 });
    assert.deepEqual([again.created, again.status, again.clientMonthId], [false, 'open', ids.november]);
    const closed = await lifecycle.openMonth(pm(), { clientId: ids.retainer, year: 2075, month: 4 });
    assert.deepEqual([closed.created, closed.status, closed.clientMonthId], [false, 'closed', ids.april]);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM client_months WHERE client_id = ${ids.retainer} AND period_year = 2075 AND period_month = 11`;
    assert.equal(n, 1);
    const line = (await queries.monthSummaries(sales(), ids.retainer)).find((m) => m.month === 11)!;
    assert.deepEqual([line.status, line.projects], ['open', 0]);
  });

  test('only someone who may file, on a client they may see, and only a real month', async () => {
    await assert.rejects(lifecycle.openMonth(leadVideo(), { clientId: ids.retainer, year: 2075, month: 12 }), /not permitted/);
    await assert.rejects(lifecycle.openMonth(ahmed(), { clientId: ids.retainer, year: 2075, month: 12 }), /not permitted/);
    await assert.rejects(lifecycle.openMonth(otherSales(), { clientId: ids.retainer, year: 2075, month: 12 }), /No such client/);
    await assert.rejects(lifecycle.openMonth(sales(), { clientId: ids.retainer, year: 2075, month: 13 }), /Unknown month/);
    await assert.rejects(lifecycle.openMonth(sales(), { clientId: ids.retainer, year: 1999, month: 1 }), /Unknown month/);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM client_months WHERE client_id = ${ids.retainer} AND period_month = 12`;
    assert.equal(n, 0);
  });
});

describe('the "+ Create month" button, and the month’s own lines in its report (brief §36, §37)', { skip }, () => {
  let actions: typeof import('../src/app/clients/actions');
  const form = (fields: Record<string, string | number>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.append(key, String(value));
    return data;
  };
  const clientPage = () => `http://portal.test/clients/${ids.retainer}`;
  const create = () => asUser(ids.sales, clientPage(), () =>
    actions.createNextMonth({}, form({ clientId: ids.retainer, year: 2075, month: 10 })));
  const openedLines = async () => Number((await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM activity_log
    WHERE action = 'client.month_opened' AND client_id = ${ids.retainer}`)[0].n);

  before(async () => {
    if (skip) return;
    actions = await import('../src/app/clients/actions');
  });

  test('the first click creates the month and says so; a second, or one on a closed month, writes nothing', async () => {
    assert.deepEqual(await create(), { notice: 'October 2075 created.' });
    const [row] = await sql<{ id: number }[]>`
      SELECT id FROM client_months WHERE client_id = ${ids.retainer} AND period_year = 2075 AND period_month = 10`;
    ids.october = Number(row.id);
    assert.equal(await openedLines(), 1, 'one "opened" line');

    assert.deepEqual(await create(), { notice: 'October 2075 is already open.' });
    assert.equal(await openedLines(), 1, 'nothing is logged for a click that changed nothing');

    assert.deepEqual(
      await asUser(ids.sales, clientPage(), () => actions.closeClientMonth({}, form({ clientMonthId: ids.october }))),
      { notice: 'October 2075 closed.' },
    );
    assert.deepEqual(await create(), { notice: 'October 2075 is already on record and closed. Reopen it to file into it.' });
    assert.equal(await openedLines(), 1);
    assert.equal((await monthRow(ids.october)).status, 'closed', 'and the month is as it was');
  });

  test('the report lists the month’s own lines — opened, closed, reopened, copied into — with its projects’', async () => {
    assert.deepEqual(
      await asUser(ids.admin, clientPage(), () => actions.reopenClientMonth({}, form({ clientMonthId: ids.october }))),
      { notice: 'October 2075 reopened.' },
    );
    const line = (await queries.monthSummaries(sales(), ids.retainer)).find((m) => m.id === ids.october)!;
    assert.equal(line.status, 'open');
    assert.ok(line.reopenedAt, 'the line says it was reopened');

    await assert.rejects(
      asUser(ids.sales, `${clientPage()}/months/${ids.september}/copy`, () => actions.copyClientMonth({}, form({
        clientId: ids.retainer, fromMonthId: ids.september, period: '2075-10',
        project: ids.projectA,
        [`dept_${ids.projectA}`]: ids.video,
        [`planned_${ids.projectA}_${ids.video}`]: 3,
        [`deadline_${ids.projectA}`]: '2075-10-20',
      }))),
      (error: Error & { digest?: string }) =>
        typeof error.digest === 'string' && error.digest.startsWith('NEXT_REDIRECT')
          && error.digest.includes(`;/clients/${ids.retainer}?copied=1;`),
      'the copy lands back on the client page, counted',
    );
    const [copied] = await sql<{ project_code: string }[]>`
      SELECT project_code FROM projects
      WHERE client_month_id = ${ids.october} AND copied_from_project_id = ${ids.projectA}`;
    assert.ok(copied, 'one copy in October');

    const report = (await reports.loadClientReport(sales(), ids.retainer, { year: 2075, month: 10 }))!;
    assert.deepEqual(report.activity.map((l) => l.text), [
      'sales opened October 2075',
      'sales closed October 2075',
      'admin reopened October 2075',
      'sales copied 1 project from September 2075 into October 2075',
      `sales created the project ${copied.project_code} by copying ${codes.projectA}`,
    ], 'in order: the month’s lines and its projects’');
  });
});

describe('a copy may add a team the source did not have (brief §38)', { skip }, () => {
  test('the plan offers every production team, and deadlines move by the gap actually chosen', async () => {
    const plan = await copy.copyMonthPlan(sales(), { clientId: ids.retainer, fromMonthId: ids.september, period: '2075-12' });
    const production = await sql<{ id: number; name: string }[]>`
      SELECT id, name FROM departments WHERE is_production ORDER BY sort_order`;
    assert.deepEqual(plan.availableDepartments, production.map((d) => ({ id: Number(d.id), name: d.name })));
    assert.equal(plan.target.value, '2075-12');
    assert.equal(plan.target.status, null);
    const a = plan.projects.find((p) => p.id === ids.projectA)!;
    assert.equal(a.suggestedDeadline, '2075-12-20', 'three months on, for a September → December copy');
    assert.equal(plan.projects.some((p) => p.id === ids.projectB), false, 'the cancelled order is not offered');
  });

  test('the copy keeps the teams ticked, adds the new one, and drops what is not a production team', async () => {
    const result = await copy.copyMonth(sales(), {
      clientId: ids.retainer, fromMonthId: ids.september, period: '2075-12',
      projects: [{
        sourceProjectId: ids.projectA,
        departments: [
          { departmentId: ids.design, plannedDeliverables: 4 },
          { departmentId: ids.social, plannedDeliverables: 2 },
          { departmentId: 999999, plannedDeliverables: 1 },
        ],
      }],
    });
    assert.equal(result.monthCreated, true);
    ids.december = result.clientMonthId;
    const copied = result.projects[0].projectId;
    assert.deepEqual((await teamsOf(copied)).map((t) => [t.slug, Number(t.planned), t.lead]),
      [['design', 4, null], ['social', 2, null]], 'Video unticked, Social Media added, the unknown id ignored');
    const [row] = await sql`SELECT status, copied_from_project_id FROM projects WHERE id = ${copied}`;
    assert.deepEqual([row.status, Number(row.copied_from_project_id)], ['new', ids.projectA]);
  });

  test('a "?to=" that is not a month is the field’s error, and the plan falls back to the default month', async () => {
    assert.deepEqual(copy.copyTarget(undefined), { period: null, error: null }, 'no choice: the default, nothing to say');
    assert.deepEqual(copy.copyTarget(' 2075-12 '), { period: '2075-12', error: null });
    for (const typed of ['October 2075', '2075-13', '2075-1', '1999-01']) {
      const target = copy.copyTarget(typed);
      assert.equal(target.period, null, typed);
      assert.match(target.error ?? '', /is not a month\. Enter it as YYYY-MM/, typed);
    }
    // What the page then asks for: the month after the source, as with no "?to=" at all.
    const plan = await copy.copyMonthPlan(sales(), {
      clientId: ids.retainer, fromMonthId: ids.september, period: copy.copyTarget('October 2075').period,
    });
    assert.equal(plan.target.value, '2075-10');
  });
});

describe('a copied repeating order keeps repeating from the copy (brief §29, §38)', { skip }, () => {
  test('the job continues the chain from the manual copy, not from the source', async () => {
    const r = await fileProject(sales(), {
      clientId: ids.retainer, period: '2075-09', title: 'Monthly reels', recursMonthly: true, deadline: '2075-09-30',
      departments: [{ departmentId: ids.video, plannedDeliverables: 10 }],
    });
    ids.projectR = r.projectId;
    const manual = await copy.copyMonth(sales(), {
      clientId: ids.retainer, fromMonthId: ids.september, period: '2075-10',
      projects: [{ sourceProjectId: ids.projectR, departments: [{ departmentId: ids.video, plannedDeliverables: 10 }], deadline: '2075-10-31' }],
    });
    ids.projectR2 = manual.projects[0].projectId;
    assert.deepEqual((await copiesOf(ids.projectR)).map((c) => [Number(c.id), c.recurs_monthly, c.period_month]),
      [[ids.projectR2, true, 10]], 'the copy is itself a repeating order');

    // Held to this suite's client, so recurring.test.ts's own runs and these never touch each other's chains.
    const own = { clientIds: [ids.retainer] };
    await runRecurring(at(10), own);
    assert.equal((await copiesOf(ids.projectR)).length, 1, 'no second October copy of the source');
    assert.equal((await copiesOf(ids.projectR2)).length, 0, 'nothing to do for October: the copy is already there');

    await runRecurring(at(11), { clientIds: [ids.shared] });
    assert.equal((await copiesOf(ids.projectR2)).length, 0, 'held to another client, the run leaves the chain alone');
    await runRecurring(at(11), own);
    const next = await copiesOf(ids.projectR2);
    assert.deepEqual(next.map((c) => [c.recurs_monthly, c.period_month]), [[true, 11]], 'November comes from the October copy');
    assert.equal((await copiesOf(ids.projectR)).length, 1);
    const [nov] = await sql`SELECT deadline::text AS deadline, status FROM projects WHERE id = ${next[0].id}`;
    assert.deepEqual([nov.deadline, nov.status], ['2075-11-30', 'new']);
    // End the chain so nothing else in a shared database extends it.
    await sql`UPDATE projects SET recurs_monthly = false WHERE client_id = ${ids.retainer}`;
  });
});

describe('a cancelled order with an approved file still to deliver holds its month (brief §18, §36)', { skip }, () => {
  test('neither the archive nor a close by hand takes the month until Sales hands the file over', async () => {
    const p = await fileProject(sales(), {
      clientId: ids.retainer, period: '2075-03', title: 'Dropped launch', requiresPmQa: false,
      departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
    });
    ids.march = p.clientMonthId;
    await triageProject(pm(), {
      projectId: p.projectId, teams: [{ departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 1 }],
    });
    const team = Number((await sql`SELECT id FROM project_departments WHERE project_id = ${p.projectId}`)[0].id);
    const a = await createAssignment(leadVideo(), {
      projectDepartmentId: team, assigneeId: ids.ahmed, title: 'Teaser', deliverableCount: 1, deliverableBaseName: 'Teaser',
    });
    await upload(ahmed(), a.deliverableIds[0], 'teaser.mp4');
    const ok = await reviewDeliverable(leadVideo(), { deliverableId: a.deliverableIds[0], decision: 'approved' });
    await changeProjectStatus(pm(), { projectId: p.projectId, change: 'cancel', reason: 'Client pulled the launch' });
    assert.equal((await sql`SELECT status FROM deliveries WHERE id = ${ok.deliveryId}`)[0].status, 'pending_delivery',
      'the approved file stays deliverable (§18)');

    const settled = () => lifecycle.settledMonths(AS_OF, { clientIds: [ids.retainer] });
    assert.equal((await settled()).some((m) => m.clientMonthId === ids.march), false, 'not settled while the file waits');
    await assert.rejects(
      lifecycle.closeMonth(sales(), { clientMonthId: ids.march }),
      (e: Error) => e instanceof lifecycle.MonthError
        && e.message.includes(`${p.projectCode} (cancelled, an approved file still awaits delivery)`)
        && /Deliver or complete what was approved/.test(e.message),
      'the refusal names the order and what to do',
    );
    assert.equal((await monthRow(ids.march)).status, 'open');

    await updateDelivery(sales(), { deliveryId: ok.deliveryId!, status: 'delivered' });
    assert.ok((await settled()).some((m) => m.clientMonthId === ids.march), 'delivered: nothing left to do');
    const closed = await lifecycle.closeMonth(sales(), { clientMonthId: ids.march });
    assert.deepEqual([closed.status, closed.projectCount], ['closed', 1]);
  });
});

describe('the nightly archive (brief §36)', { skip }, () => {
  const mine = (list: { clientId: number; clientMonthId: number }[]) =>
    list.filter((m) => m.clientId === ids.retainer).map((m) => m.clientMonthId);
  // Held to this suite's client, so w3-infra's months and these never reach each other.
  const settled = (asOf: Date) => lifecycle.settledMonths(asOf, { clientIds: [ids.retainer] });
  const archive = (asOf: Date) => lifecycle.closeSettledMonths(asOf, { clientIds: [ids.retainer] });

  test('a month settles a week after it ends, only when every project in it is finished', async () => {
    assert.deepEqual(mine(await settled(new Date('2075-07-07T23:00:00Z'))), [], 'June is still within its grace');
    assert.deepEqual(mine(await settled(new Date('2075-07-08T00:30:00Z'))), [ids.june]);
    assert.deepEqual(mine(await settled(AS_OF)), [ids.june],
      'July has an open order, March and April are closed, May and August are empty, September is still moving');
    const june = (await settled(AS_OF)).find((m) => m.clientMonthId === ids.june)!;
    assert.deepEqual([june.clientName, june.year, june.month, june.projectCount], ['W3 clients Retainer', 2075, 6, 2]);
  });

  test('a project reopened while the archive waits for the month keeps its month open', async () => {
    const commit = gate();
    const locked = gate();
    const holder = sql.begin(async (tx) => {
      await tx`SELECT id FROM client_months WHERE id = ${ids.june} FOR UPDATE`;
      await tx`UPDATE projects SET status = 'in_progress' WHERE id = ${ids.projectD}`;
      locked.open();
      await commit.opened;
    });
    await locked.opened;
    const run = archive(AS_OF);
    await waitForLockWait('FOR UPDATE');
    commit.open();
    await holder;
    const { closed } = await run;
    assert.equal(closed.some((m) => m.clientMonthId === ids.june), false);
    assert.equal((await monthRow(ids.june)).status, 'open');
    await sql`UPDATE projects SET status = 'completed' WHERE id = ${ids.projectD}`;
  });

  test('held to other clients, the run neither lists nor closes the month', async () => {
    assert.deepEqual(mine(await lifecycle.settledMonths(AS_OF, { clientIds: [ids.shared] })), []);
    assert.deepEqual(await lifecycle.settledMonths(AS_OF, { clientIds: [] }), [], 'held to no client: nothing at all');
    assert.deepEqual(mine((await lifecycle.closeSettledMonths(AS_OF, { clientIds: [ids.shared] })).closed), []);
    assert.equal((await monthRow(ids.june)).status, 'open');
    assert.deepEqual(mine(await settled(AS_OF)), [ids.june], 'held to this one, it is listed');
  });

  test('the run closes June with no closer, and the record says the archive did it', async () => {
    const { closed } = await archive(AS_OF);
    assert.deepEqual(mine(closed), [ids.june]);
    assert.deepEqual(await monthRow(ids.june), { status: 'closed', closed_by: null });

    const [line] = await sql<{ actor_id: number | null; client_id: number; metadata: Record<string, unknown> }[]>`
      SELECT actor_id, client_id, metadata FROM activity_log
      WHERE action = 'client.month_closed' AND entity_type = 'client_month' AND entity_id = ${ids.june}`;
    assert.equal(line.actor_id, null);
    assert.equal(Number(line.client_id), ids.retainer);
    assert.deepEqual(line.metadata, { year: 2075, month: 6, projectCount: 2, automatic: true });

    const june = (await queries.monthSummaries(sales(), ids.retainer)).find((m) => m.id === ids.june)!;
    assert.deepEqual([june.status, june.closedBy, june.projects, june.completed], ['closed', null, 1, 0]);
    const report = (await reports.loadClientReport(sales(), ids.retainer, JUNE))!;
    assert.equal(report.month?.status, 'closed');
    const texts = report.activity.map((l) => l.text).join('\n');
    assert.ok(report.activity.some((l) => l.text === 'June 2075 was archived automatically'), texts);

    // The delivered revision went with the month, recorded the same way.
    const [rev] = await sql`SELECT status, closed_at FROM revisions WHERE id = ${ids.juneRevision}`;
    assert.equal(rev.status, 'closed', 'nothing is listed as open in an archived month');
    assert.ok(rev.closed_at);
    const [revLine] = await sql<{ actor_id: number | null; client_id: number; project_id: number; metadata: Record<string, unknown> }[]>`
      SELECT actor_id, client_id, project_id, metadata FROM activity_log
      WHERE action = 'revision.closed' AND entity_type = 'revision' AND entity_id = ${ids.juneRevision}`;
    assert.deepEqual([revLine.actor_id, Number(revLine.client_id), Number(revLine.project_id)], [null, ids.retainer, ids.projectD]);
    assert.deepEqual(revLine.metadata, { revisionNo: 1, status: 'closed', monthClosed: true, automatic: true });
    assert.ok(report.activity.some((l) => l.text === 'Revision #01 was closed automatically when the month was archived'), texts);
  });

  test('a second run finds nothing to do', async () => {
    assert.deepEqual(mine((await archive(AS_OF)).closed), []);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM activity_log WHERE action = 'client.month_closed' AND entity_id = ${ids.june}`;
    assert.equal(n, 1);
    const [{ r }] = await sql`SELECT count(*)::int AS r FROM activity_log WHERE action = 'revision.closed' AND entity_id = ${ids.juneRevision}`;
    assert.equal(r, 1, 'the revision is not closed twice either');
  });

  test('a reopened month with work in it again is left alone', async () => {
    await lifecycle.reopenMonth(admin(), { clientMonthId: ids.june });
    await sql`UPDATE projects SET status = 'in_progress' WHERE id = ${ids.projectD}`;
    assert.deepEqual(mine(await settled(AS_OF)), []);
    assert.deepEqual(mine((await archive(AS_OF)).closed), []);
    assert.equal((await monthRow(ids.june)).status, 'open');
  });

  test('a month management reopened stays open until closed by hand, however settled it is', async () => {
    await sql`UPDATE projects SET status = 'completed', completed_at = now() WHERE id = ${ids.projectD}`;
    const line = (await queries.monthSummaries(sales(), ids.retainer)).find((m) => m.id === ids.june)!;
    assert.equal(line.status, 'open');
    assert.ok(line.reopenedAt, 'the line carries the reopen');
    assert.deepEqual(mine(await settled(AS_OF)), [], 'settled again, and still not for the archive');
    assert.deepEqual(mine(await settled(new Date('2076-03-01T03:00:00Z'))), [], 'nor months later');
    assert.deepEqual(mine((await archive(AS_OF)).closed), []);
    assert.equal((await monthRow(ids.june)).status, 'open');

    const closed = await lifecycle.closeMonth(pm(), { clientMonthId: ids.june });
    assert.equal(closed.status, 'closed');
    const [row] = await sql`SELECT status, closed_by, reopened_at FROM client_months WHERE id = ${ids.june}`;
    assert.deepEqual([row.status, Number(row.closed_by), row.reopened_at], ['closed', ids.pm, null], 'a plain closed month again');
    const again = (await queries.monthSummaries(sales(), ids.retainer)).find((m) => m.id === ids.june)!;
    assert.deepEqual([again.status, again.closedBy, again.reopenedAt], ['closed', 'pm', null]);
  });
});

describe('the archive holds against a write in flight (brief §36)', { skip }, () => {
  test('a write holding the month keeps a close waiting until it lands', async () => {
    const release = gate();
    const locked = gate();
    const writer = getDb().transaction(async (tx) => {
      await lifecycle.assertMonthOpen(tx, { clientMonthId: ids.august });
      locked.open();
      await release.opened;
    });
    await locked.opened;
    const close = lifecycle.closeMonth(pm(), { clientMonthId: ids.august });
    assert.equal(await waitForLockWait('FOR UPDATE'), true, 'the close is queued behind the writer');
    assert.equal((await monthRow(ids.august)).status, 'open', 'and has not closed the month');
    release.open();
    await writer;
    assert.equal((await close).status, 'closed');
    assert.equal((await monthRow(ids.august)).status, 'closed');
  });

  test('a write that arrives while the close holds the month waits, then is refused', async () => {
    const commit = gate();
    const locked = gate();
    const closer = sql.begin(async (tx) => {
      await tx`SELECT id FROM client_months WHERE id = ${ids.may} FOR UPDATE`;
      await tx`UPDATE client_months SET status = 'closed', closed_at = now(), closed_by = ${ids.pm} WHERE id = ${ids.may}`;
      locked.open();
      await commit.opened;
    });
    await locked.opened;
    const attempt = getDb().transaction(async (tx) => {
      await lifecycle.assertMonthOpen(tx, { clientMonthId: ids.may });
      await tx.execute(q`UPDATE client_months SET notes = 'slipped in' WHERE id = ${ids.may}`);
    });
    assert.equal(await waitForLockWait('FOR SHARE'), true, 'the write waits for the close');
    commit.open();
    await closer;
    await assert.rejects(attempt, /month is closed/);
    const [row] = await sql`SELECT status, notes FROM client_months WHERE id = ${ids.may}`;
    assert.deepEqual([row.status, row.notes], ['closed', null], 'nothing landed in the closed month');
  });

  test('the guard answers for a project by its month, through the pool as well', async () => {
    await lifecycle.assertMonthOpen(getDb(), { projectId: ids.projectF });
    await sql`UPDATE projects SET status = 'completed', completed_at = now() WHERE id = ${ids.projectF}`;
    // A delivered revision on the July order, and one already cancelled.
    const [delivered] = await sql<{ id: number }[]>`
      INSERT INTO revisions (project_id, revision_no, title, client_feedback, created_by, status)
      VALUES (${ids.projectF}, 1, 'Retitle', 'New title card.', ${ids.sales}, 'delivered') RETURNING id`;
    const [withdrawn] = await sql<{ id: number }[]>`
      INSERT INTO revisions (project_id, revision_no, title, client_feedback, created_by, status, closed_at)
      VALUES (${ids.projectF}, 2, 'Never mind', 'Leave it.', ${ids.sales}, 'cancelled', now()) RETURNING id`;
    await lifecycle.closeMonth(pm(), { clientMonthId: ids.july });
    await assert.rejects(lifecycle.assertMonthOpen(getDb(), { projectId: ids.projectF }), /month is closed/);

    // Closing by hand closes the delivered revision too, in the closer's name.
    assert.equal((await sql`SELECT status FROM revisions WHERE id = ${delivered.id}`)[0].status, 'closed');
    assert.equal((await sql`SELECT status FROM revisions WHERE id = ${withdrawn.id}`)[0].status, 'cancelled', 'an ended one is left as it was');
    const lines = await sql<{ actor_id: number; entity_id: number; metadata: Record<string, unknown> }[]>`
      SELECT actor_id, entity_id, metadata FROM activity_log
      WHERE action = 'revision.closed' AND project_id = ${ids.projectF} ORDER BY id`;
    assert.deepEqual(lines.map((l) => [Number(l.actor_id), Number(l.entity_id), l.metadata]),
      [[ids.pm, Number(delivered.id), { revisionNo: 1, status: 'closed', monthClosed: true }]]);
    const { describeActivity } = await import('../src/lib/activity/describe');
    assert.equal(describeActivity({ action: 'revision.closed', actorName: 'pm', metadata: lines[0].metadata }),
      'pm closed revision #01 with the month');
    await assert.rejects(
      lifecycle.assertMonthOpen(getDb(), { projectId: ids.projectF }, (m) => new RangeError(m)),
      (e: unknown) => e instanceof RangeError,
      'the caller’s own error type is used',
    );
    await lifecycle.assertMonthOpen(getDb(), { projectId: 0 }, () => new Error('never'));
  });
});

describe('the client overview: this month on top, the rest folded away (brief §35)', { skip }, () => {
  const Y = 2070;
  /** Mid-September: the overview client's September is the open month holding today. */
  const MID_SEPTEMBER = new Date(Date.UTC(Y, 8, 15, 12));
  /** Late November: nothing is open in November, so the newest open month stands in. */
  const LATE_NOVEMBER = new Date(Date.UTC(Y, 10, 20, 12));
  const line = (p: { title: string; approved: number; total: number; percent: number | null }) =>
    [p.title, p.approved, p.total, p.percent];
  const head = (b: { month: { year: number; month: number; status: string } }) =>
    [b.month.year, b.month.month, b.month.status];
  const overview = (who: Actor, today: Date) => queries.loadClientMonths(who, ids.overview, { today });

  before(async () => {
    if (skip) return;
    const [c] = await sql<{ id: number }[]>`
      INSERT INTO clients (name, owner_user_id, created_by, status, started_on)
      VALUES ('W3 clients Overview', ${ids.sales}, ${ids.sales}, 'active', '2069-01-01') RETURNING id`;
    ids.overview = Number(c.id);

    // September: Reels routed and two of three cuts approved; an SEO audit just filed.
    const reels = await fileProject(sales(), {
      clientId: ids.overview, period: `${Y}-09`, title: 'Reels', requiresPmQa: false, priceAmount: '5000.00',
      departments: [{ departmentId: ids.video, plannedDeliverables: 3 }],
    });
    ids.overviewSeptember = reels.clientMonthId;
    await triageProject(pm(), {
      projectId: reels.projectId, teams: [{ departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: 3 }],
    });
    const team = Number((await sql`SELECT id FROM project_departments WHERE project_id = ${reels.projectId}`)[0].id);
    const cut = await createAssignment(leadVideo(), {
      projectDepartmentId: team, assigneeId: ids.ahmed, title: 'Cut', deliverableCount: 3, deliverableBaseName: 'Reel',
    });
    for (const [i, deliverableId] of cut.deliverableIds.slice(0, 2).entries()) {
      await upload(ahmed(), deliverableId, `reel-${i + 1}.mp4`);
      await reviewDeliverable(leadVideo(), { deliverableId, decision: 'approved' });
    }
    await fileProject(sales(), {
      clientId: ids.overview, period: `${Y}-09`, title: 'SEO audit',
      departments: [{ departmentId: ids.seo, plannedDeliverables: 2 }],
    });
    // October: opened ahead for planning, nothing in it yet (§37).
    await lifecycle.openMonth(sales(), { clientId: ids.overview, year: Y, month: 10 });
    // August: its one order done and the month closed by the PM. July: an order left open.
    const film = await fileProject(sales(), {
      clientId: ids.overview, period: `${Y}-08`, title: 'August film',
      departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
    });
    await sql`UPDATE projects SET status = 'completed', completed_at = now() WHERE id = ${film.projectId}`;
    await sql`UPDATE client_months SET status = 'closed', closed_at = now(), closed_by = ${ids.pm} WHERE id = ${film.clientMonthId}`;
    await fileProject(sales(), {
      clientId: ids.overview, period: `${Y}-07`, title: 'July retainer',
      departments: [{ departmentId: ids.design, plannedDeliverables: 1 }],
    });
  });

  test('Sales: September on top with each order’s percentage; October apart; August and July previous, with their status', async () => {
    const o = await overview(sales(), MID_SEPTEMBER);
    assert.equal(o.months.length, 4);
    assert.equal(o.projects.length, 4, 'the lifetime counters still cover every order');
    assert.equal(o.showPricing, true);

    assert.deepEqual(head(o.current!), [Y, 9, 'open']);
    assert.equal(o.current!.month.id, ids.overviewSeptember);
    assert.deepEqual(o.current!.projects.map(line), [['SEO audit', 0, 0, null], ['Reels', 2, 3, 67]],
      'newest filed first; two of three approved is 67%, and an order not yet routed has no percentage');
    assert.equal(o.current!.projects[1].priceAmount, '5000.00', 'Sales sees the price');
    assert.ok(o.current!.projects.every((p) => p.clientMonthId === ids.overviewSeptember));

    assert.deepEqual(o.upcoming.map(head), [[Y, 10, 'open']], 'opened ahead: shown apart, never as previous');
    assert.deepEqual(o.upcoming[0].projects, []);

    assert.deepEqual(o.previous.map(head), [[Y, 8, 'closed'], [Y, 7, 'open']], 'newest first, each with its status');
    assert.equal(o.previous[0].month.closedBy, 'pm');
    assert.deepEqual(o.previous[0].projects.map(line), [['August film', 0, 0, null]]);
    assert.deepEqual(o.previous[1].projects.map((p) => p.title), ['July retainer']);
  });

  test('with nothing open this month, the newest open month stands in and everything else is previous', async () => {
    const o = await overview(sales(), LATE_NOVEMBER);
    assert.deepEqual(head(o.current!), [Y, 10, 'open']);
    assert.deepEqual(o.upcoming, []);
    assert.deepEqual(o.previous.map(head), [[Y, 9, 'open'], [Y, 8, 'closed'], [Y, 7, 'open']]);
  });

  test('the rows follow the viewer: an Executive sees their own order without its price, another rep sees empty months', async () => {
    const exec = await overview(ahmed(), MID_SEPTEMBER);
    assert.equal(exec.showPricing, false);
    assert.deepEqual(exec.current!.projects.map(line), [['Reels', 2, 3, 67]], 'only the order they hold an assignment on');
    assert.equal(exec.current!.projects[0].priceAmount, null, 'and never its price');
    assert.deepEqual(exec.previous.map((b) => b.projects.length), [0, 0]);

    const other = await overview(otherSales(), MID_SEPTEMBER);
    assert.equal(other.months.length, 4, 'the months are on record, as monthSummaries lists them');
    assert.deepEqual([other.current!.projects, ...other.upcoming.map((b) => b.projects), ...other.previous.map((b) => b.projects)],
      [[], [], [], []], 'with nothing of theirs in any of them');
  });

  test('with every month closed there is no current month, and all four are previous, newest first', async () => {
    await sql`UPDATE client_months SET status = 'closed', closed_at = now(), closed_by = ${ids.pm} WHERE client_id = ${ids.overview}`;
    const o = await overview(sales(), MID_SEPTEMBER);
    assert.equal(o.current, null, 'what the page renders as the empty state, with "+ Create month"');
    assert.deepEqual(o.upcoming, []);
    assert.deepEqual(o.previous.map(head), [[Y, 10, 'closed'], [Y, 9, 'closed'], [Y, 8, 'closed'], [Y, 7, 'closed']]);
    assert.equal(o.months.length, 4);
  });
});
