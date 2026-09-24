import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { can, clientScope } from '@/lib/authz';

/** Anything that can run a statement — the pool or a transaction. */
type Executor = Pick<ReturnType<typeof getDb>, 'execute'>;

export class MonthError extends Error {}

/** Project statuses that mean the work is finished with, one way or the other. */
const SETTLED = ['completed', 'cancelled'] as const;

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
 * cancelled. Archiving work that is still moving would freeze an Executive
 * mid-upload, so the refusal names the projects that are still open and the
 * caller finishes or cancels them first. An empty month can close.
 */
export async function closeMonth(actor: Actor, input: MonthRef): Promise<MonthResult> {
  if (!can(actor, 'month.close')) throw new MonthError('You are not permitted to close months.');
  const month = await loadVisibleMonth(actor, input.clientMonthId);
  if (month.status === 'closed') throw new MonthError('This month is already closed.');

  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM client_months WHERE id = ${month.id} FOR UPDATE`);

    const open = await tx.execute<{ project_code: string; status: string }>(sql`
      SELECT project_code, status FROM projects
      WHERE client_month_id = ${month.id}
        AND status NOT IN (${sql.join(SETTLED.map((s) => sql`${s}`), sql`, `)})
      ORDER BY project_code
    `);
    if (open.length > 0) {
      const codes = open.map((p) => `${p.project_code} (${p.status.replace(/_/g, ' ')})`);
      throw new MonthError(
        `${open.length === 1 ? 'A project is' : `${open.length} projects are`} still open: ${codes.join(', ')}. ` +
          'Complete or cancel them before closing the month.',
      );
    }

    const [{ n }] = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM projects WHERE client_month_id = ${month.id}
    `);
    await tx.execute(sql`
      UPDATE client_months
      SET status = 'closed', closed_at = now(), closed_by = ${actor.id}
      WHERE id = ${month.id}
    `);

    return {
      clientMonthId: Number(month.id),
      clientId: Number(month.client_id),
      year: Number(month.period_year),
      month: Number(month.period_month),
      status: 'closed',
      projectCount: Number(n),
    };
  });
}

/**
 * Reopens an archived month so its records can be edited again (brief §36:
 * "authorized users can still reopen/edit records if necessary"). A separate
 * capability from closing — Sales closes their own months, but only
 * management and admin can unlock an archive.
 */
export async function reopenMonth(actor: Actor, input: MonthRef): Promise<MonthResult> {
  if (!can(actor, 'month.reopen')) throw new MonthError('You are not permitted to reopen months.');
  const month = await loadVisibleMonth(actor, input.clientMonthId);
  if (month.status === 'open') throw new MonthError('This month is not closed.');

  const db = getDb();
  await db.execute(sql`
    UPDATE client_months SET status = 'open', closed_at = NULL, closed_by = NULL WHERE id = ${month.id}
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

export const MONTH_CLOSED_MESSAGE =
  'This month is closed and its records are read-only. Ask management to reopen it first.';

/**
 * The read-only rule for archived months (brief §36). Every mutation on a
 * project — filing, triage, planning, uploads, QA, delivery, comments,
 * revisions — calls this before it writes, so the archive cannot be edited
 * through a side door. The caller supplies its own error type so the
 * refusal reaches the form the way that module's other refusals do.
 */
export async function assertMonthOpen(
  db: Executor,
  target: { projectId: number } | { clientMonthId: number },
  fail: (message: string) => Error = (message) => new MonthError(message),
): Promise<void> {
  const rows =
    'projectId' in target
      ? await db.execute<{ status: string }>(sql`
          SELECT cm.status FROM projects p
          JOIN client_months cm ON cm.id = p.client_month_id
          WHERE p.id = ${target.projectId}
        `)
      : await db.execute<{ status: string }>(sql`
          SELECT status FROM client_months WHERE id = ${target.clientMonthId}
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
