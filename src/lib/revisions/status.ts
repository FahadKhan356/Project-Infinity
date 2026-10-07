import 'server-only';
import { sql } from 'drizzle-orm';
import type { getDb } from '@/db';
import { syncAssignmentStatus } from '@/lib/qa/project-status';

type Executor = Pick<ReturnType<typeof getDb>, 'execute'>;

/** Statuses in which a revision still needs work or a decision. */
export const OPEN_REVISION_STATUSES = ['new', 'assigned', 'in_progress', 'awaiting_qa'] as const;

/**
 * A revision that ends — closed, cancelled, or withdrawn with its project —
 * gives back what it sent back. Every slot it holds at `changes_requested`
 * whose latest delivery still stands returns to where that delivery says it
 * was: delivered, and so does the delivery that was flagged for it;
 * delivered with its hand-over completed, which was never flagged; or
 * approved, its file still waiting in Sales' queue — never flagged either,
 * and "delivered" would be a lie that left the pending delivery with
 * nothing to move. Whether a rework was uploaded makes no difference: one
 * still in QA holds the slot elsewhere than `changes_requested` and decides
 * for itself, and one QA rejected has nothing left to answer once the
 * revision is over — the delivered file stands until a reworked version
 * clears QA and arrives as a new delivery (brief §14, §17). A slot another
 * open revision still wants redone stays sent back. Left alone, the slot
 * said "to redo" with nothing to redo, the delivery sat at "revision
 * required" with no revision behind it and no move Sales could make, and a
 * completed project fell back to in progress.
 *
 * `ending` names the revision being ended, or the project whose every
 * revision is — a cancellation (§18) — so none of them holds a slot for
 * another. Returns the slots restored, their assignments re-derived.
 */
export async function restoreRevisedSlots(
  db: Executor,
  ending: { revisionId: number } | { projectId: number },
): Promise<{ deliverableId: number; assignmentId: number | null }[]> {
  const ended = 'revisionId' in ending
    ? sql`r.id = ${ending.revisionId}`
    : sql`r.project_id = ${ending.projectId}`;
  const restored = await db.execute<{ id: number; assignment_id: number | null }>(sql`
    UPDATE deliverables d
    SET status = CASE WHEN dl.status = 'pending_delivery' THEN 'approved' ELSE 'delivered' END::deliverable_status
    FROM deliveries dl
    WHERE d.status = 'changes_requested'
      AND EXISTS (SELECT 1 FROM revision_deliverables rd
                  JOIN revisions r ON r.id = rd.revision_id
                  WHERE rd.deliverable_id = d.id AND ${ended})
      AND dl.deliverable_id = d.id
      AND dl.id = (SELECT max(id) FROM deliveries WHERE deliverable_id = d.id)
      AND dl.status IN ('revision_required', 'completed', 'pending_delivery')
      AND NOT EXISTS (SELECT 1 FROM revision_deliverables other
                      JOIN revisions r ON r.id = other.revision_id
                      WHERE other.deliverable_id = d.id AND NOT (${ended})
                        AND r.status IN ('new', 'assigned', 'in_progress', 'awaiting_qa'))
    RETURNING d.id, d.assignment_id
  `);
  if (restored.length === 0) return [];

  const ids = sql.join(restored.map((r) => sql`${Number(r.id)}`), sql`, `);
  await db.execute(sql`
    UPDATE deliveries dl SET status = 'delivered'
    WHERE dl.deliverable_id IN (${ids}) AND dl.status = 'revision_required'
      AND dl.id = (SELECT max(id) FROM deliveries WHERE deliverable_id = dl.deliverable_id)
  `);
  for (const r of restored) {
    if (r.assignment_id !== null) await syncAssignmentStatus(db, Number(r.assignment_id));
  }
  return restored.map((r) => ({
    deliverableId: Number(r.id),
    assignmentId: r.assignment_id === null ? null : Number(r.assignment_id),
  }));
}

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
