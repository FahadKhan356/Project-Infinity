import 'server-only';
import { sql } from 'drizzle-orm';
import type { getDb } from '@/db';

type Executor = Pick<ReturnType<typeof getDb>, 'execute'>;

/** Statuses in which a revision still needs work or a decision. */
export const OPEN_REVISION_STATUSES = ['new', 'assigned', 'in_progress', 'awaiting_qa'] as const;

/**
 * The revision a new upload to this slot would answer: the latest one that
 * touches the slot and has not been closed or cancelled.
 */
export async function openRevisionFor(
  db: Executor,
  deliverableId: number,
): Promise<{ id: number; revisionNo: number } | null> {
  const rows = await db.execute<{ id: number; revision_no: number }>(sql`
    SELECT r.id, r.revision_no
    FROM revision_deliverables rd
    JOIN revisions r ON r.id = rd.revision_id
    WHERE rd.deliverable_id = ${deliverableId}
      AND r.status NOT IN ('closed', 'cancelled')
    ORDER BY r.revision_no DESC
    LIMIT 1
  `);
  const row = rows[0];
  return row ? { id: Number(row.id), revisionNo: Number(row.revision_no) } : null;
}

/**
 * Derives a revision's status from the slots it touches (brief §17) and
 * writes it if it changed. Closed and cancelled are decisions, never derived.
 *
 *   every slot delivered again               → delivered
 *   every slot approved or delivered          → approved
 *   any slot sitting in QA                    → awaiting_qa
 *   any version uploaded against it           → in_progress
 *   otherwise                                 → unchanged (new / assigned)
 */
export async function syncRevisionStatus(db: Executor, revisionId: number): Promise<string | null> {
  const rows = await db.execute<{
    status: string; total: number; delivered: number; done: number; in_qa: number; answered: number;
  }>(sql`
    SELECT r.status,
           count(d.id)::int AS total,
           count(*) FILTER (WHERE d.status = 'delivered')::int AS delivered,
           count(*) FILTER (WHERE d.status IN ('approved','delivered'))::int AS done,
           count(*) FILTER (WHERE d.status IN ('awaiting_lead_qa','awaiting_pm_qa'))::int AS in_qa,
           (SELECT count(*)::int FROM deliverable_versions v WHERE v.revision_id = r.id) AS answered
    FROM revisions r
    LEFT JOIN revision_deliverables rd ON rd.revision_id = r.id
    LEFT JOIN deliverables d           ON d.id = rd.deliverable_id AND d.status <> 'cancelled'
    WHERE r.id = ${revisionId}
    GROUP BY r.id, r.status
  `);
  const row = rows[0];
  if (!row) return null;
  if (row.status === 'closed' || row.status === 'cancelled') return row.status;

  const total = Number(row.total);
  let target = row.status;
  if (total > 0 && Number(row.delivered) === total) target = 'delivered';
  else if (total > 0 && Number(row.done) === total) target = 'approved';
  else if (Number(row.in_qa) > 0) target = 'awaiting_qa';
  else if (Number(row.answered) > 0) target = 'in_progress';

  if (target !== row.status) {
    await db.execute(sql`
      UPDATE revisions SET status = ${target}::revision_status WHERE id = ${revisionId}
    `);
  }
  return target;
}
