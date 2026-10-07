import 'server-only';
import { sql } from 'drizzle-orm';
import type { getDb } from '@/db';

/** Anything that can run a statement — the pool or a transaction. */
type Executor = Pick<ReturnType<typeof getDb>, 'execute'>;

/**
 * Statuses that follow the work rather than a decision (brief §18, §26 step
 * 8). Only these are ever moved by the sync; `on_hold` and `cancelled` are
 * set by people, and the pre-production states by routing.
 */
const FOLLOWS_WORK = new Set([
  'in_progress', 'qa', 'approved', 'ready_for_delivery', 'delivered', 'revision_required',
  // A completed project takes client feedback as a revision (createRevision
  // allows it), so it must reopen: left "completed", every upload answering
  // the revision was refused (workBlockedReason) and the month could close.
  'completed',
]);

/**
 * Where routing leaves a project (projects/triage). Routing is not the work:
 * once any slot has started, the project follows its slots even while a
 * team still waits for a lead — the intake queue keeps that team in view.
 * Otherwise a partly routed project read "awaiting assignment" through
 * delivery and completion.
 */
const PRE_PRODUCTION = new Set(['new', 'awaiting_assignment', 'planned']);

/**
 * Derives a project's status from its slots, deliveries and revisions, and
 * writes it if it changed. Returns the status the project now has.
 *
 *   a revision is open and not yet approved              → revision_required
 *   a team has no lead, or has planned nothing yet       → in_progress
 *   every slot delivered and its latest delivery completed → completed
 *   every slot delivered                                 → delivered
 *   every slot approved or delivered                     → ready_for_delivery
 *   nothing left in production, some slot awaiting QA    → qa
 *   otherwise                                            → in_progress
 *
 * The slots only say how far the work that exists has come. A team still
 * without a lead, or whose lead has made no assignment or slot yet (the
 * test triage uses for a team it may still drop), has work to come, so the
 * project stays in progress. Otherwise it could deliver and complete on the
 * other teams alone, leave the intake queue and let its month close, and the
 * missing team could no longer be routed or planned — a lead given a team
 * whose colleagues had finished would find the project completed under
 * them. The intake queue (projects/triage) lists a project while such a team
 * holds it up, so the PM can route, chase or drop the team.
 *
 * There is no separate "approved" stage: a file that clears its final QA is
 * queued for Sales in the same transaction (brief §14, §26 step 6), so
 * Approved and Ready for Delivery are the same moment and the portal shows
 * `ready_for_delivery`. A project found at `approved` is moved on like any
 * other status the work decides.
 */
export async function syncProjectStatus(db: Executor, projectId: number): Promise<string | null> {
  const rows = await db.execute<{
    status: string; total: number; started: number; in_review: number; done: number;
    delivered: number; completed: number; open_revisions: number; waiting_teams: number;
  }>(sql`
    SELECT p.status,
           count(d.id)::int AS total,
           count(*) FILTER (WHERE d.status <> 'pending')::int AS started,
           count(*) FILTER (WHERE d.status IN ('awaiting_lead_qa','awaiting_pm_qa'))::int AS in_review,
           count(*) FILTER (WHERE d.status IN ('approved','delivered'))::int AS done,
           count(*) FILTER (WHERE d.status = 'delivered')::int AS delivered,
           count(*) FILTER (WHERE d.status = 'delivered'
             AND (SELECT dl.status FROM deliveries dl WHERE dl.deliverable_id = d.id
                  ORDER BY dl.id DESC LIMIT 1) = 'completed')::int AS completed,
           (SELECT count(*)::int FROM revisions r
             WHERE r.project_id = p.id
               AND r.status IN ('new','assigned','in_progress','awaiting_qa')) AS open_revisions,
           (SELECT count(*)::int FROM project_departments pd
             WHERE pd.project_id = p.id
               AND (pd.team_lead_id IS NULL
                    OR (NOT EXISTS (SELECT 1 FROM assignments a WHERE a.project_department_id = pd.id)
                        AND NOT EXISTS (SELECT 1 FROM deliverables x
                                        WHERE x.project_department_id = pd.id)))) AS waiting_teams
    FROM projects p
    LEFT JOIN deliverables d ON d.project_id = p.id AND d.status <> 'cancelled'
    WHERE p.id = ${projectId}
    GROUP BY p.id, p.status
  `);
  const row = rows[0];
  if (!row) return null;

  const total = Number(row.total);
  const follows = FOLLOWS_WORK.has(row.status)
    || (PRE_PRODUCTION.has(row.status) && Number(row.started) > 0);
  if (total === 0 || !follows) return row.status;

  const done = Number(row.done);
  const inReview = Number(row.in_review);
  let target: string;
  if (Number(row.open_revisions) > 0) target = 'revision_required';
  else if (Number(row.waiting_teams) > 0) target = 'in_progress';
  else if (Number(row.completed) === total) target = 'completed';
  else if (Number(row.delivered) === total) target = 'delivered';
  else if (done === total) target = 'ready_for_delivery';
  // In QA only once the Executives have nothing left to make: every slot is
  // signed off or waiting on a reviewer. One still in production (pending,
  // or sent back) keeps the project in progress.
  else if (inReview > 0 && inReview + done === total) target = 'qa';
  else target = 'in_progress';

  if (target === row.status) return row.status;

  await db.execute(sql`
    UPDATE projects
    SET status = ${target}::project_status,
        completed_at = CASE WHEN ${target} = 'completed' THEN COALESCE(completed_at, now()) ELSE NULL END
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
