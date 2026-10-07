/**
 * Time tracking and the reports built on it (brief §29): employee
 * productivity, team performance and profitability.
 *
 * Time is always one's own and dated honestly; reports are scoped to the
 * teams a viewer may see, and prices reach only pricing roles.
 *
 * Needs DATABASE_URL pointing at a migrated database. Other suites share the
 * database and the current month, so team totals are asserted as lower
 * bounds and person rows are pinned to this suite's users.
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
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run time tests';

let sql: ReturnType<typeof postgres>;
let storageRoot: string;
let time: typeof import('../src/lib/time/entries');
let productivity: typeof import('../src/lib/reports/productivity');
let uploads: typeof import('../src/lib/files/uploads');
let fileProject: typeof import('../src/lib/projects/file-project').fileProject;
let triageProject: typeof import('../src/lib/projects/triage').triageProject;
let createAssignment: typeof import('../src/lib/planning/assign').createAssignment;
let reviewDeliverable: typeof import('../src/lib/qa/review').reviewDeliverable;
let changeProjectStatus: typeof import('../src/lib/projects/status').changeProjectStatus;
let loadWorkspace: typeof import('../src/lib/workspace/workspace').loadWorkspace;

const ids: Record<string, number> = {};
const DOMAIN = '@timetest.local';
// Calendar dates in the machine's own zone, which is the zone the database
// compares CURRENT_DATE in: a UTC date here is a day behind for the first
// hours of every morning east of Greenwich, and "tomorrow" stops being in
// the future.
const now = new Date();
const calendarDate = (t: number) => {
  const d = new Date(t);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};
const today = calendarDate(now.getTime());
const daysAgo = (n: number) => calendarDate(now.getTime() - n * 86_400_000);
const period = { year: now.getFullYear(), month: now.getMonth() + 1 };
const periodValue = `${period.year}-${String(period.month).padStart(2, '0')}`;

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 0, email: `${role}${DOMAIN}`, fullName: role, role,
    isActive: true, mustChangePassword: false,
    leadDepartmentIds: [], departmentIds: [], permissions: new Set<Permission>(), ...over,
  };
}
const sales = () => actor('sales', { id: ids.sales });
const pm = () => actor('project_manager', { id: ids.pm });
const leadVideo = () => actor('team_lead', { id: ids.leadVideo, leadDepartmentIds: [ids.video], departmentIds: [ids.video] });
const leadDesign = () => actor('team_lead', { id: ids.leadDesign, leadDepartmentIds: [ids.design], departmentIds: [ids.design] });
const ahmed = () => actor('executive', { id: ids.ahmed, departmentIds: [ids.video] });
const omar = () => actor('executive', { id: ids.omar, departmentIds: [ids.video] });
const ceo = () => actor('ceo', { id: ids.ceo });

async function purge() {
  const users = sql`SELECT id FROM users WHERE email LIKE ${'%' + DOMAIN}`;
  await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
  await sql`DELETE FROM upload_sessions WHERE created_by IN (${users})`;
  await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'Time Test%')`;
  await sql`DELETE FROM clients WHERE name LIKE 'Time Test%'`;
  await sql`DELETE FROM files WHERE uploaded_by IN (${users})`;
  await sql`DELETE FROM notifications WHERE user_id IN (${users})`;
  await sql`DELETE FROM department_members WHERE user_id IN (${users})`;
  await sql`DELETE FROM user_cost_rates WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE email LIKE ${'%' + DOMAIN}`;
}

const stream = (b: Buffer) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(b)); c.close(); } });
async function uploadTo(who: Actor, deliverableId: number) {
  const b = randomBytes(32);
  const { session } = await uploads.createUploadSession(who, { target: 'deliverable', deliverableId, filename: 'cut.mp4', size: b.length });
  await uploads.appendChunk(who, session.id, 0, stream(b));
  return uploads.completeUpload(who, session.id);
}

/** A priced Video project with one assignment for Ahmed. */
async function newWork(opts: { slots?: number; estimatedMinutes?: number | null; due?: string | null } = {}) {
  const p = await fileProject(sales(), {
    clientId: ids.client, period: periodValue, title: 'Reels', priceAmount: '3000.00', requiresPmQa: false,
    departments: [{ departmentId: ids.video, plannedDeliverables: opts.slots ?? 1 }],
  });
  await triageProject(pm(), {
    projectId: p.projectId,
    teams: [{ departmentId: ids.video, teamLeadId: ids.leadVideo, plannedDeliverables: opts.slots ?? 1 }],
  });
  const [pd] = await sql`SELECT id FROM project_departments WHERE project_id = ${p.projectId}`;
  const a = await createAssignment(leadVideo(), {
    projectDepartmentId: Number(pd.id), assigneeId: ids.ahmed, title: 'Edit reels',
    deliverableCount: opts.slots ?? 1, estimatedMinutes: opts.estimatedMinutes ?? null, dueDate: opts.due ?? null,
  });
  return { projectId: p.projectId, assignmentId: a.assignmentId, slots: a.deliverableIds };
}

before(async () => {
  if (skip) return;
  storageRoot = await mkdtemp(path.join(tmpdir(), 'aktivacity-time-'));
  process.env.STORAGE_ROOT = storageRoot;
  sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });
  time = await import('../src/lib/time/entries');
  productivity = await import('../src/lib/reports/productivity');
  uploads = await import('../src/lib/files/uploads');
  ({ fileProject } = await import('../src/lib/projects/file-project'));
  ({ triageProject } = await import('../src/lib/projects/triage'));
  ({ createAssignment } = await import('../src/lib/planning/assign'));
  ({ reviewDeliverable } = await import('../src/lib/qa/review'));
  ({ changeProjectStatus } = await import('../src/lib/projects/status'));
  ({ loadWorkspace } = await import('../src/lib/workspace/workspace'));
  await purge();

  for (const slug of ['video', 'design']) {
    ids[slug] = Number((await sql`SELECT id FROM departments WHERE slug = ${slug}`)[0].id);
  }
  for (const [key, role] of [
    ['sales', 'sales'], ['pm', 'project_manager'], ['ceo', 'ceo'], ['leadVideo', 'team_lead'], ['leadDesign', 'team_lead'],
    ['ahmed', 'executive'], ['omar', 'executive'],
  ] as const) {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES (${key + DOMAIN}, 'x', ${key}, ${role}) RETURNING id`;
    ids[key] = Number(row.id);
  }
  for (const [key, slug, lead] of [
    ['leadVideo', 'video', true], ['leadDesign', 'design', true], ['ahmed', 'video', false], ['omar', 'video', false],
  ] as const) {
    await sql`INSERT INTO department_members (user_id, department_id, is_lead) VALUES (${ids[key]}, ${ids[slug]}, ${lead})`;
  }
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO clients (name, owner_user_id, created_by) VALUES ('Time Test Client', ${ids.sales}, ${ids.sales}) RETURNING id`;
  ids.client = Number(c.id);
});

after(async () => {
  if (skip || !sql) return;
  await purge();
  await sql.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('durations', () => {
  test('hours parse as decimals or h:mm, and format back', async () => {
    const f = await import('../src/lib/time/format');
    assert.equal(f.parseHours('1.5'), 90);
    assert.equal(f.parseHours('2:05'), 125);
    assert.equal(f.parseHours(' '), null);
    assert.throws(() => f.parseHours('abc'), RangeError);
    assert.throws(() => f.parseHours('25', 24), RangeError);
    assert.throws(() => f.parseHours('-1'), RangeError);
    assert.equal(f.formatMinutes(150), '2h 30m');
    assert.equal(f.formatMinutes(45), '45m');
    assert.equal(f.formatMinutes(360), '6h');
  });
});

describe('logging time (brief §29)', { skip }, () => {
  test('the assignee logs time on their own assignment and sees it', async () => {
    const w = await newWork();
    await time.logTime(ahmed(), { assignmentId: w.assignmentId, workDate: today, minutes: 90, note: 'rough cut' });
    const mine = await time.myTimeEntries(ahmed());
    assert.ok(mine.some((e) => e.minutes === 90 && e.note === 'rough cut' && e.projectId === w.projectId));
    assert.ok((await time.loggableAssignments(ahmed())).some((a) => a.id === w.assignmentId));
    assert.equal((await time.loggableAssignments(omar())).some((a) => a.id === w.assignmentId), false);
  });

  test('nobody logs time on someone else’s assignment, not even their lead', async () => {
    const w = await newWork();
    for (const who of [omar(), leadVideo(), pm()]) {
      await assert.rejects(time.logTime(who, { assignmentId: w.assignmentId, workDate: today, minutes: 30 }),
        /one of your assignments/);
    }
  });

  test('a day that has not happened, or one too long ago, is refused', async () => {
    const w = await newWork();
    await assert.rejects(time.logTime(ahmed(), { assignmentId: w.assignmentId, workDate: daysAgo(-1), minutes: 30 }),
      /not happened/);
    await assert.rejects(time.logTime(ahmed(), { assignmentId: w.assignmentId, workDate: daysAgo(time.BACKDATE_DAYS + 1), minutes: 30 }),
      /days back/);
    await time.logTime(ahmed(), { assignmentId: w.assignmentId, workDate: daysAgo(time.BACKDATE_DAYS), minutes: 30 });
  });

  test('a day cannot hold more than 24 hours across entries', async () => {
    const w = await newWork();
    const day = daysAgo(3);
    await time.logTime(ahmed(), { assignmentId: w.assignmentId, workDate: day, minutes: 20 * 60 });
    await assert.rejects(time.logTime(ahmed(), { assignmentId: w.assignmentId, workDate: day, minutes: 5 * 60 }),
      /more than 24 hours/);
    await assert.rejects(time.logTime(ahmed(), { assignmentId: w.assignmentId, workDate: day, minutes: 0 }),
      /between a minute/);
  });

  test('cancelled projects and closed months take no time', async () => {
    const cancelled = await newWork();
    await changeProjectStatus(pm(), { projectId: cancelled.projectId, change: 'cancel', reason: 'Dropped' });
    await assert.rejects(time.logTime(ahmed(), { assignmentId: cancelled.assignmentId, workDate: today, minutes: 30 }),
      /cancelled/);

    const archived = await newWork();
    const entry = await time.logTime(ahmed(), { assignmentId: archived.assignmentId, workDate: today, minutes: 30 });
    const [m] = await sql`SELECT client_month_id FROM projects WHERE id = ${archived.projectId}`;
    await sql`UPDATE client_months SET status = 'closed', closed_at = now(), closed_by = ${ids.pm} WHERE id = ${m.client_month_id}`;
    try {
      await assert.rejects(time.logTime(ahmed(), { assignmentId: archived.assignmentId, workDate: today, minutes: 30 }), /closed/);
      await assert.rejects(time.deleteTime(ahmed(), entry.entryId), /closed/);
    } finally {
      await sql`UPDATE client_months SET status = 'open', closed_at = NULL, closed_by = NULL WHERE id = ${m.client_month_id}`;
    }
  });

  test('only the person who logged an entry removes it', async () => {
    const w = await newWork();
    const e = await time.logTime(ahmed(), { assignmentId: w.assignmentId, workDate: today, minutes: 15 });
    await assert.rejects(time.deleteTime(omar(), e.entryId), /No such entry/);
    await assert.rejects(time.deleteTime(leadVideo(), e.entryId), /No such entry/);
    await time.deleteTime(ahmed(), e.entryId);
    assert.equal((await sql`SELECT 1 FROM time_entries WHERE id = ${e.entryId}`).length, 0);
  });

  test('the workspace shows effort to the assignee and the lead, not to colleagues', async () => {
    const w = await newWork({ estimatedMinutes: 240 });
    await time.logTime(ahmed(), { assignmentId: w.assignmentId, workDate: today, minutes: 60 });
    // Omar joins the project with his own assignment, so he can open the workspace.
    const [pd] = await sql`SELECT id FROM project_departments WHERE project_id = ${w.projectId}`;
    await createAssignment(leadVideo(), { projectDepartmentId: Number(pd.id), assigneeId: ids.omar, title: 'Thumbs', deliverableCount: 0 });
    const effortFor = async (who: Actor) => {
      const ws = await loadWorkspace(who, w.projectId);
      return ws!.teams.flatMap((t) => t.assignments).find((a) => a.id === w.assignmentId)!.effort;
    };
    assert.deepEqual(await effortFor(ahmed()), { loggedMinutes: 60, estimatedMinutes: 240 });
    assert.deepEqual(await effortFor(leadVideo()), { loggedMinutes: 60, estimatedMinutes: 240 });
    assert.deepEqual(await effortFor(pm()), { loggedMinutes: 60, estimatedMinutes: 240 });
    assert.equal(await effortFor(omar()), null);
  });
});

describe('productivity, team performance and profitability (brief §29)', { skip }, () => {
  let projectId: number;

  before(async () => {
    if (skip) return;
    // One slot, sent back once then approved, with an estimate and 90 minutes logged.
    const w = await newWork({ estimatedMinutes: 120, due: daysAgo(-7) });
    projectId = w.projectId;
    await time.logTime(ahmed(), { assignmentId: w.assignmentId, workDate: today, minutes: 90 });
    await uploadTo(ahmed(), w.slots[0]);
    await reviewDeliverable(leadVideo(), { deliverableId: w.slots[0], decision: 'changes_requested', comments: 'Tighter' });
    await uploadTo(ahmed(), w.slots[0]);
    await reviewDeliverable(leadVideo(), { deliverableId: w.slots[0], decision: 'approved' });
  });

  test('who may see it', () => {
    assert.equal(productivity.canViewProductivity(pm()), true);
    assert.equal(productivity.canViewProductivity(leadVideo()), true);
    assert.equal(productivity.canViewProductivity(ahmed()), false);
    assert.equal(productivity.canViewProductivity(sales()), false);
  });

  test('a person’s month reads from what the portal recorded', async () => {
    const report = (await productivity.loadProductivityReport(pm(), period))!;
    const a = report.people.find((p) => p.userId === ids.ahmed)!;
    assert.equal(a.uploads, 2);
    assert.equal(a.approved, 1);
    assert.equal(a.firstPass, 0, 'it was sent back once');
    assert.equal(a.withDueDate, 1);
    assert.equal(a.onTime, 1);
    assert.equal(a.reviews, 2);
    assert.equal(a.sentBack, 1);
    assert.equal(a.finishedWithEstimate, 1);
    assert.equal(a.estimatedMinutes, 120);
    assert.equal(a.actualMinutes, 90);
    assert.ok(a.minutes >= 90);
    const quiet = report.people.find((p) => p.userId === ids.omar);
    assert.ok(quiet, 'a team member with nothing this month is listed at zero');
    const video = report.teams.find((t) => t.departmentId === ids.video)!;
    assert.ok(video.approved >= 1 && video.minutes >= 90 && video.sentBack >= 1);
    assert.equal(productivity.rate(a.firstPass, a.approved), '0%');
    assert.equal(productivity.rate(0, 0), '—');
  });

  test('a Team Lead sees their own team only, and no prices', async () => {
    const design = (await productivity.loadProductivityReport(leadDesign(), period))!;
    assert.deepEqual(design.teams.map((t) => t.departmentId), [ids.design]);
    assert.equal(design.people.some((p) => p.userId === ids.ahmed), false);
    assert.equal(design.profitability, null);

    const video = (await productivity.loadProductivityReport(leadVideo(), period))!;
    assert.ok(video.people.some((p) => p.userId === ids.ahmed && p.approved === 1));
    assert.equal(video.profitability, null);
  });

  test('profitability is value per logged hour, for pricing roles', async () => {
    const report = (await productivity.loadProductivityReport(pm(), period))!;
    const row = report.profitability!.find((r) => r.projectId === projectId)!;
    assert.equal(row.priceAmount, 3000);
    assert.equal(row.loggedMinutes, 90);
    assert.equal(row.estimatedMinutes, 120);
    assert.equal(row.valuePerHour, 2000);
    assert.equal(row.approved, 1);
    assert.equal(await productivity.loadProductivityReport(ahmed(), period), null);
  });
});

describe('cost rates and margin (brief §29)', { skip }, () => {
  let rates: typeof import('../src/lib/costs/rates');
  before(async () => {
    if (skip) return;
    rates = await import('../src/lib/costs/rates');
  });

  test('only the CEO and COO set or read individual rates', async () => {
    await assert.rejects(rates.setCostRate(pm(), { userId: ids.ahmed, effectiveFrom: today, hourlyCost: 50 }), /not permitted/);
    assert.equal(await rates.costRates(pm(), ids.ahmed), null);
    await assert.rejects(rates.setCostRate(ceo(), { userId: ids.ahmed, effectiveFrom: 'soon', hourlyCost: 50 }), /date/);
    await assert.rejects(rates.setCostRate(ceo(), { userId: ids.ahmed, effectiveFrom: today, hourlyCost: -1 }), /valid/);
  });

  test('each hour is costed at the rate in force on its day; unrated hours are counted apart', async () => {
    await rates.setCostRate(ceo(), { userId: ids.ahmed, effectiveFrom: daysAgo(60), hourlyCost: 100 });
    await rates.setCostRate(ceo(), { userId: ids.ahmed, effectiveFrom: daysAgo(1), hourlyCost: 150 });
    await rates.setCostRate(ceo(), { userId: ids.ahmed, effectiveFrom: daysAgo(1), hourlyCost: 200 }); // replaces
    assert.deepEqual((await rates.costRates(ceo(), ids.ahmed))!.map((r) => [r.effectiveFrom, r.hourlyCost]),
      [[daysAgo(1), 200], [daysAgo(60), 100]]);

    const w = await newWork();
    const [pd] = await sql`SELECT id FROM project_departments WHERE project_id = ${w.projectId}`;
    const o = await createAssignment(leadVideo(), { projectDepartmentId: Number(pd.id), assigneeId: ids.omar, title: 'Thumbs', deliverableCount: 0 });
    await time.logTime(ahmed(), { assignmentId: w.assignmentId, workDate: daysAgo(5), minutes: 60 }); // 100
    await time.logTime(ahmed(), { assignmentId: w.assignmentId, workDate: today, minutes: 90 });      // 300
    await time.logTime(omar(), { assignmentId: o.assignmentId, workDate: today, minutes: 30 });        // no rate

    const row = (await productivity.loadProductivityReport(pm(), period))!.profitability!
      .find((r) => r.projectId === w.projectId)!;
    assert.equal(row.cost, 400);
    assert.equal(row.unratedMinutes, 30);
    assert.equal(row.margin, 2600);
    assert.equal(row.loggedMinutes, 180);
  });

  test('a rate in another currency leaves the margin blank rather than wrong', async () => {
    await rates.setCostRate(ceo(), { userId: ids.omar, effectiveFrom: daysAgo(10), hourlyCost: 20, currency: 'usd' });
    const w = await newWork();
    const [pd] = await sql`SELECT id FROM project_departments WHERE project_id = ${w.projectId}`;
    const o = await createAssignment(leadVideo(), { projectDepartmentId: Number(pd.id), assigneeId: ids.omar, title: 'Thumbs', deliverableCount: 0 });
    await time.logTime(omar(), { assignmentId: o.assignmentId, workDate: today, minutes: 60 });
    const row = (await productivity.loadProductivityReport(pm(), period))!.profitability!
      .find((r) => r.projectId === w.projectId)!;
    assert.equal(row.margin, null);
    await rates.removeCostRate(ceo(), { userId: ids.omar, effectiveFrom: daysAgo(10) });
    assert.deepEqual(await rates.costRates(ceo(), ids.omar), []);
  });
});
