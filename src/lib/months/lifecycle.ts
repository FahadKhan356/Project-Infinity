import 'server-only';
import { sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/db';
import { recordActivity } from '@/lib/auth/audit';
import type { Actor } from '@/lib/authz';
import { can, clientScope } from '@/lib/authz';
import { resolveClientMonth } from '@/lib/projects/intake';
import { isClientVisible } from '@/lib/projects/queries';

/** Anything that can run a statement — the pool or a transaction. */
type Executor = Pick<ReturnType<typeof getDb>, 'execute'>;

export class MonthError extends Error {}

/** Project statuses that mean the work is finished with, one way or the other. */
const SETTLED = ['completed', 'cancelled'] as const;

/**
 * True for a project row (alias `p`) that keeps its month open: one not yet
 * settled, or one cancelled while an approved file was still waiting in
 * Sales' delivery queue. Cancelling keeps approved slots deliverable on
 * purpose (lib/projects/status), so the month waits until that delivery is
 * delivered or marked complete — closing it sooner would freeze a hand-over
 * the portal itself says is still to be made. The closing by hand, the
 * archive's listing and its re-check under the lock all ask this one
 * question, so they cannot disagree.
 */
function holdsMonthOpen(p: string): SQL {
  const alias = sql.raw(p);
  return sql`(
    ${alias}.status NOT IN (${sql.join(SETTLED.map((s) => sql`${s}`), sql`, `)})
    OR (${alias}.status = 'cancelled' AND EXISTS (
      SELECT 1 FROM deliveries dl
      WHERE dl.project_id = ${alias}.id AND dl.status = 'pending_delivery'
        AND dl.id = (SELECT max(id) FROM deliveries WHERE deliverable_id = dl.deliverable_id)
    ))
  )`;
}

/** The refusal a close gets, naming each project that holds the month and what to do about it. */
function stillOpenMessage(open: { project_code: string; status: string }[]): string {
  const undelivered = open.filter((p) => p.status === 'cancelled').length;
  const codes = open.map((p) => p.status === 'cancelled'
    ? `${p.project_code} (cancelled, an approved file still awaits delivery)`
    : `${p.project_code} (${p.status.replace(/_/g, ' ')})`);
  const advice = undelivered === 0
    ? 'Complete or cancel them before closing the month.'
    : undelivered === open.length
      ? 'Deliver or complete what was approved before closing the month.'
      : 'Complete or cancel them, and deliver or complete what was approved, before closing the month.';
  return `${open.length === 1 ? 'A project is' : `${open.length} projects are`} still open: ${codes.join(', ')}. ${advice}`;
}

type ClosedRevision = { id: number; revision_no: number; project_id: number };

/**
 * A revision whose every slot was delivered again is done: it is listed as
 * open only because nobody pressed "close". Closing the month ends it, so
 * the archive lists nothing as still open — and once the month is closed
 * nothing could end it anyway. A revision in any other unsettled status
 * keeps its project unsettled, and so the month open, through
 * `holdsMonthOpen`. Runs inside the closing transaction; the caller records
 * each one once the close has landed.
 */
async function closeDeliveredRevisions(tx: Executor, clientMonthId: number): Promise<ClosedRevision[]> {
  return tx.execute<ClosedRevision>(sql`
    UPDATE revisions r
    SET status = 'closed', closed_at = now()
    FROM projects p
    WHERE p.id = r.project_id AND p.client_month_id = ${clientMonthId} AND r.status = 'delivered'
    RETURNING r.id, r.revision_no, r.project_id
  `);
}

/** One `revision.closed` line per revision the close ended, by the same actor as the close. */
async function recordRevisionsClosed(
  closed: ClosedRevision[],
  by: { actorId: number | null; clientId: number; automatic?: boolean },
): Promise<void> {
  for (const r of closed) {
    await recordActivity({
      actorId: by.actorId,
      action: 'revision.closed',
      entityType: 'revision',
      entityId: Number(r.id),
      projectId: Number(r.project_id),
      clientId: by.clientId,
      metadata: {
        revisionNo: Number(r.revision_no), status: 'closed', monthClosed: true,
        ...(by.automatic ? { automatic: true } : {}),
      },
    });
  }
}

export interface MonthRef {
  clientMonthId: number;
}

export interface MonthResult {
  clientMonthId: number;
  clientId: number;
  year: number;
  month: number;
  status: 'open' | 'closed';
  projectCount: number;
}

type MonthRow = {
  id: number; client_id: number; period_year: number; period_month: number; status: 'open' | 'closed';
};

async function loadVisibleMonth(actor: Actor, clientMonthId: number): Promise<MonthRow> {
  const rows = await getDb().execute<MonthRow>(sql`
    SELECT cm.id, cm.client_id, cm.period_year, cm.period_month, cm.status
    FROM client_months cm
    JOIN clients c ON c.id = cm.client_id
    WHERE cm.id = ${clientMonthId} AND ${clientScope(actor, 'c')}
  `);
  const row = rows[0];
  if (!row) throw new MonthError('No such month.');
  return row;
}

/**
 * Closes a month into the client's archive (brief §36).
 *
 * A month closes only when every project in it is settled — completed or
 * cancelled, and a cancelled one with nothing still waiting to be delivered
 * (`holdsMonthOpen`). Archiving work that is still moving would freeze an
 * Executive mid-upload, so the refusal names the projects that are still
 * open and the caller finishes or cancels them first. An empty month can
 * close. Its delivered revisions close with it, and a month management had
 * reopened is a plain closed month again.
 */
export async function closeMonth(actor: Actor, input: MonthRef): Promise<MonthResult> {
  if (!can(actor, 'month.close')) throw new MonthError('You are not permitted to close months.');
  const month = await loadVisibleMonth(actor, input.clientMonthId);
  if (month.status === 'closed') throw new MonthError('This month is already closed.');

  const db = getDb();
  const { result, revisions } = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM client_months WHERE id = ${month.id} FOR UPDATE`);

    const open = await tx.execute<{ project_code: string; status: string }>(sql`
      SELECT p.project_code, p.status FROM projects p
      WHERE p.client_month_id = ${month.id} AND ${holdsMonthOpen('p')}
      ORDER BY p.project_code
    `);
    if (open.length > 0) throw new MonthError(stillOpenMessage(open));

    const [{ n }] = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM projects WHERE client_month_id = ${month.id}
    `);
    const closedRevisions = await closeDeliveredRevisions(tx, Number(month.id));
    await tx.execute(sql`
      UPDATE client_months
      SET status = 'closed', closed_at = now(), closed_by = ${actor.id}, reopened_at = NULL
      WHERE id = ${month.id}
    `);

    const result: MonthResult = {
      clientMonthId: Number(month.id),
      clientId: Number(month.client_id),
      year: Number(month.period_year),
      month: Number(month.period_month),
      status: 'closed',
      projectCount: Number(n),
    };
    return { result, revisions: closedRevisions };
  });
  await recordRevisionsClosed(revisions, { actorId: actor.id, clientId: result.clientId });
  return result;
}

export interface SettledMonth {
  clientMonthId: number;
  clientId: number;
  clientName: string;
  year: number;
  month: number;
  projectCount: number;
}

/** Days after a month ends before the archive takes it, so a late order or a last file still lands. */
const ARCHIVE_GRACE_DAYS = 7;

export interface ArchiveOptions {
  /** Only these clients' months; the nightly job leaves it out and covers every client. */
  clientIds?: number[];
}

/**
 * Open months the archive is ready to take (brief §36: "completed months
 * should automatically become part of the client's historical archive"):
 * the period ended more than the grace ago, and every project in it is
 * settled — completed, or cancelled with nothing left to deliver
 * (`holdsMonthOpen`). An empty month is left open — nothing was delivered,
 * so there is nothing to archive, and Sales may still file into it or copy
 * forward from it. A month management reopened is left alone for good: it
 * was reopened to change something, the archive cannot know when that is
 * done, and so it stays open until someone closes it by hand.
 *
 * `asOf` is the clock: the nightly job leaves it at now, a test drives it.
 */
export async function settledMonths(asOf: Date = new Date(), options: ArchiveOptions = {}): Promise<SettledMonth[]> {
  const today = asOf.toISOString().slice(0, 10);
  const only = options.clientIds?.filter(Number.isInteger) ?? null;
  const rows = await getDb().execute<{
    id: number; client_id: number; client_name: string; period_year: number; period_month: number; n: number;
  }>(sql`
    SELECT cm.id, cm.client_id, c.name AS client_name, cm.period_year, cm.period_month,
           (SELECT count(*)::int FROM projects p WHERE p.client_month_id = cm.id) AS n
    FROM client_months cm
    JOIN clients c ON c.id = cm.client_id
    WHERE cm.status = 'open'
      AND cm.reopened_at IS NULL
      ${only ? sql`AND cm.client_id IN (${sql.join([-1, ...only].map((id) => sql`${id}`), sql`, `)})` : sql``}
      AND make_date(cm.period_year, cm.period_month, 1) + interval '1 month' + ${ARCHIVE_GRACE_DAYS} * interval '1 day'
          <= ${today}::date
      AND EXISTS (SELECT 1 FROM projects p WHERE p.client_month_id = cm.id)
      AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.client_month_id = cm.id AND ${holdsMonthOpen('p')})
    ORDER BY cm.client_id, cm.period_year, cm.period_month
  `);
  return rows.map((r) => ({
    clientMonthId: Number(r.id), clientId: Number(r.client_id), clientName: r.client_name,
    year: Number(r.period_year), month: Number(r.period_month), projectCount: Number(r.n),
  }));
}

/**
 * Closes every month `settledMonths` lists, each in its own transaction
 * under the same row lock `closeMonth` takes, re-checking the projects
 * under the lock so a project reopened meanwhile keeps its month. Written
 * with no `closed_by`, which is how the archive shows it was automatic;
 * the delivered revisions it closes on the way are recorded the same way.
 */
export async function closeSettledMonths(
  asOf: Date = new Date(),
  options: ArchiveOptions = {},
): Promise<{ closed: SettledMonth[] }> {
  const db = getDb();
  const closed: SettledMonth[] = [];
  for (const m of await settledMonths(asOf, options)) {
    const done = await db.transaction(async (tx): Promise<ClosedRevision[] | null> => {
      const [locked] = await tx.execute<{ status: string; reopened_at: string | null }>(sql`
        SELECT status, reopened_at FROM client_months WHERE id = ${m.clientMonthId} FOR UPDATE
      `);
      if (locked?.status !== 'open' || locked.reopened_at !== null) return null;
      const [{ open }] = await tx.execute<{ open: number }>(sql`
        SELECT count(*)::int AS open FROM projects p
        WHERE p.client_month_id = ${m.clientMonthId} AND ${holdsMonthOpen('p')}
      `);
      if (Number(open) > 0) return null;
      const revisions = await closeDeliveredRevisions(tx, m.clientMonthId);
      await tx.execute(sql`
        UPDATE client_months SET status = 'closed', closed_at = now(), closed_by = NULL, reopened_at = NULL
        WHERE id = ${m.clientMonthId}
      `);
      return revisions;
    });
    if (done === null) continue;
    await recordActivity({
      actorId: null,
      action: 'client.month_closed',
      entityType: 'client_month',
      entityId: m.clientMonthId,
      clientId: m.clientId,
      metadata: { year: m.year, month: m.month, projectCount: m.projectCount, automatic: true },
    });
    await recordRevisionsClosed(done, { actorId: null, clientId: m.clientId, automatic: true });
    closed.push(m);
  }
  return { closed };
}

/**
 * Reopens an archived month so its records can be edited again (brief §36:
 * "authorized users can still reopen/edit records if necessary"). A separate
 * capability from closing — Sales closes their own months, but only
 * management and admin can unlock an archive. The reopen is kept on the
 * month, and the nightly archive leaves such a month to be closed by hand.
 */
export async function reopenMonth(actor: Actor, input: MonthRef): Promise<MonthResult> {
  if (!can(actor, 'month.reopen')) throw new MonthError('You are not permitted to reopen months.');
  const month = await loadVisibleMonth(actor, input.clientMonthId);
  if (month.status === 'open') throw new MonthError('This month is not closed.');

  const db = getDb();
  await db.execute(sql`
    UPDATE client_months SET status = 'open', closed_at = NULL, closed_by = NULL, reopened_at = now()
    WHERE id = ${month.id}
  `);
  const [{ n }] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM projects WHERE client_month_id = ${month.id}
  `);
  return {
    clientMonthId: Number(month.id),
    clientId: Number(month.client_id),
    year: Number(month.period_year),
    month: Number(month.period_month),
    status: 'open',
    projectCount: Number(n),
  };
}

export interface OpenMonthResult {
  clientMonthId: number;
  clientId: number;
  year: number;
  month: number;
  status: 'open' | 'closed';
  /** False when the month was already on record — nothing was written. */
  created: boolean;
}

/**
 * "+ Create October 2026" (brief §37): opens a client's next monthly
 * workspace by hand, ahead of its first order. Filing a project opens its
 * month on its own (resolveClientMonth), so this only matters for planning
 * ahead — and the permanent client record is not touched, let alone typed
 * in again. A month already on record is left as it is and reported as
 * such, rather than as a second opening.
 */
export async function openMonth(
  actor: Actor,
  input: { clientId: number; year: number; month: number },
): Promise<OpenMonthResult> {
  if (!can(actor, 'projects.create')) throw new MonthError('You are not permitted to open a month.');
  const { year, month } = input;
  if (!Number.isInteger(year) || !Number.isInteger(month) || year < 2020 || year > 2100 || month < 1 || month > 12) {
    throw new MonthError('Unknown month.');
  }
  const db = getDb();
  if (!(await isClientVisible(db, actor, input.clientId))) throw new MonthError('No such client.');

  return db.transaction(async (tx) => {
    const resolved = await resolveClientMonth(tx, { clientId: input.clientId, year, month, userId: actor.id });
    const [row] = await tx.execute<{ status: 'open' | 'closed' }>(sql`
      SELECT status FROM client_months WHERE id = ${resolved.id}
    `);
    return {
      clientMonthId: resolved.id,
      clientId: input.clientId,
      year,
      month,
      status: row?.status ?? 'open',
      created: resolved.created,
    };
  });
}

export const MONTH_CLOSED_MESSAGE =
  'This month is closed and its records are read-only. Ask management to reopen it first.';

/**
 * The read-only rule for archived months (brief §36). Every mutation on a
 * project — filing, triage, planning, uploads, QA, delivery, comments,
 * revisions — calls this before it writes, so the archive cannot be edited
 * through a side door. The caller supplies its own error type so the
 * refusal reaches the form the way that module's other refusals do.
 *
 * The month row is read FOR SHARE. A caller that passes its own transaction
 * then holds that lock until it commits, so a close — which takes the row
 * FOR UPDATE — waits for the write to land, and a write that arrives while
 * the close holds the row waits and then sees "closed". Through the bare
 * pool the lock ends with the statement and the guard is a plain check.
 */
export async function assertMonthOpen(
  db: Executor,
  target: { projectId: number } | { clientMonthId: number },
  fail: (message: string) => Error = (message) => new MonthError(message),
): Promise<void> {
  const rows =
    'projectId' in target
      ? await db.execute<{ status: string }>(sql`
          SELECT status FROM client_months
          WHERE id = (SELECT p.client_month_id FROM projects p WHERE p.id = ${target.projectId})
          FOR SHARE
        `)
      : await db.execute<{ status: string }>(sql`
          SELECT status FROM client_months WHERE id = ${target.clientMonthId} FOR SHARE
        `);
  if (rows[0]?.status === 'closed') throw fail(MONTH_CLOSED_MESSAGE);
}

/** True when the month a project belongs to is closed. For pages, not for guards. */
export async function isProjectMonthClosed(db: Executor, projectId: number): Promise<boolean> {
  const rows = await db.execute<{ status: string }>(sql`
    SELECT cm.status FROM projects p JOIN client_months cm ON cm.id = p.client_month_id
    WHERE p.id = ${projectId}
  `);
  return rows[0]?.status === 'closed';
}
