import 'server-only';
import { sql } from 'drizzle-orm';
import type { getDb } from '@/db';

/** Anything that can run a statement — the pool or a transaction. */
type Executor = Pick<ReturnType<typeof getDb>, 'execute'>;

/**
 * Statuses that follow the work rather than a decision (brief §18, §26 step
 * 8). Only these are ever moved by the sync; `on_hold`, `cancelled` and the
 * pre-production states are set by people.
 */
const FOLLOWS_WORK = new Set(['in_progress', 'qa', 'approved', 'ready_for_delivery', 'delivered']);

/**
 * Derives a project's status from its slots and deliveries, and writes it if
 * it changed. Returns the status the project now has.
 *
 *   every slot delivered and every delivery completed → completed
 *   every slot delivered                              → delivered
 *   every slot approved or delivered                  → ready_for_delivery
 *   otherwise                                         → in_progress
 */
export async function syncProjectStatus(db: Executor, projectId: number): Promise<string | null> {
  const rows = await db.execute<{
    status: string; total: number; done: number; delivered: number; completed: number;
  }>(sql`
    SELECT p.status,
           count(d.id)::int AS total,
           count(*) FILTER (WHERE d.status IN ('approved','delivered'))::int AS done,
           count(*) FILTER (WHERE d.status = 'delivered')::int AS delivered,
           count(*) FILTER (WHERE d.status = 'delivered'
             AND EXISTS (SELECT 1 FROM deliveries dl WHERE dl.deliverable_id = d.id)
             AND NOT EXISTS (SELECT 1 FROM deliveries dl
                             WHERE dl.deliverable_id = d.id AND dl.status <> 'completed'))::int AS completed
    FROM projects p
    LEFT JOIN deliverables d ON d.project_id = p.id AND d.status <> 'cancelled'
    WHERE p.id = ${projectId}
    GROUP BY p.id, p.status
  `);
  const row = rows[0];
  if (!row) return null;

  const total = Number(row.total);
  if (total === 0 || !FOLLOWS_WORK.has(row.status)) return row.status;

  let target: string;
  if (Number(row.completed) === total) target = 'completed';
  else if (Number(row.delivered) === total) target = 'delivered';
  else if (Number(row.done) === total) target = 'ready_for_delivery';
  else target = 'in_progress';

  if (target === row.status) return row.status;

  await db.execute(sql`
    UPDATE projects
    SET status = ${target}::project_status,
        completed_at = CASE WHEN ${target} = 'completed' THEN COALESCE(completed_at, now()) ELSE completed_at END
    WHERE id = ${projectId}
  `);
  return target;
}

/**
 * An assignment closes when its last slot is signed off, and reopens if a
 * slot comes back. Cancelled assignments are left alone.
 */
export async function syncAssignmentStatus(db: Executor, assignmentId: number): Promise<void> {
  await db.execute(sql`
    UPDATE assignments a
    SET status = CASE
      WHEN s.total > 0 AND s.done = s.total THEN 'completed'::assignment_status
      WHEN s.started > 0 THEN 'in_progress'::assignment_status
      ELSE a.status
    END
    FROM (
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE d.status IN ('approved','delivered'))::int AS done,
             count(*) FILTER (WHERE d.status <> 'pending')::int AS started
      FROM deliverables d
      WHERE d.assignment_id = ${assignmentId} AND d.status <> 'cancelled'
    ) s
    WHERE a.id = ${assignmentId} AND a.status <> 'cancelled'
  `);
}
