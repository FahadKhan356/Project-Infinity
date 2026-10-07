import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { can } from '@/lib/authz';
import { isProjectVisible } from '@/lib/authz/queries';
import { assertMonthOpen } from '@/lib/months/lifecycle';
import { onProjectStatusChanged } from '@/lib/notifications/notify';
import { syncAssignmentStatus, syncProjectStatus } from '@/lib/qa/project-status';
import { restoreRevisedSlots } from '@/lib/revisions/status';

export class ProjectStatusError extends Error {}

export type StatusChange = 'hold' | 'resume' | 'cancel';

export interface StatusChangeResult {
  projectId: number;
  from: string;
  status: string;
  /** Slots and assignments withdrawn by a cancellation. */
  cancelledSlots: number;
  cancelledAssignments: number;
}

/** Statuses a project cannot leave by a decision — its story is over. */
const FINISHED = new Set(['completed', 'cancelled']);

/**
 * The project statuses people decide rather than the work (brief §18): On
 * Hold and Cancelled. Everything else follows the slots (qa/project-status).
 *
 *   hold    — the project remembers where it was, and nothing new can be
 *             assigned or uploaded until it resumes. Work already in QA or
 *             awaiting delivery may still be finished.
 *   resume  — back to where it was, then re-derived from the work, so a QA
 *             sign-off that landed while it was held is not lost.
 *   cancel  — final. Every slot not yet approved and every open assignment
 *             and revision is withdrawn; approved files stay in the delivery
 *             queue, since Sales may still hand over what was finished. A
 *             revision withdrawn this way gives back what it sent back, as
 *             ending it on its own does: the delivered file stands, and
 *             Sales may still complete its hand-over.
 */
export async function changeProjectStatus(
  actor: Actor,
  input: { projectId: number; change: StatusChange; reason?: string | null },
): Promise<StatusChangeResult> {
  if (!can(actor, 'projects.changeStatus')) {
    throw new ProjectStatusError('You are not permitted to change this project’s status.');
  }
  const db = getDb();
  if (!(await isProjectVisible(db, actor, input.projectId))) {
    throw new ProjectStatusError('No such project.');
  }
  await assertMonthOpen(db, { projectId: input.projectId }, (m) => new ProjectStatusError(m));
  const reason = input.reason?.trim() || null;

  return db.transaction(async (tx) => {
    const [row] = await tx.execute<{ status: string; held_from_status: string | null }>(sql`
      SELECT status, held_from_status FROM projects WHERE id = ${input.projectId} FOR UPDATE
    `);
    if (!row) throw new ProjectStatusError('No such project.');
    const from = row.status;
    let status = from;
    let cancelledSlots = 0;
    let cancelledAssignments = 0;

    switch (input.change) {
      case 'hold': {
        if (FINISHED.has(from)) throw new ProjectStatusError(`A ${from} project cannot be put on hold.`);
        if (from === 'on_hold') throw new ProjectStatusError('The project is already on hold.');
        await tx.execute(sql`
          UPDATE projects SET status = 'on_hold', held_from_status = status WHERE id = ${input.projectId}
        `);
        status = 'on_hold';
        break;
      }
      case 'resume': {
        if (from !== 'on_hold') throw new ProjectStatusError('Only a project on hold can be resumed.');
        await tx.execute(sql`
          UPDATE projects SET status = held_from_status, held_from_status = NULL WHERE id = ${input.projectId}
        `);
        status = (await syncProjectStatus(tx, input.projectId)) ?? row.held_from_status ?? from;
        break;
      }
      case 'cancel': {
        if (FINISHED.has(from)) throw new ProjectStatusError(`The project is already ${from}.`);
        if (!reason) throw new ProjectStatusError('Say why the project is being cancelled.');

        // The revisions go with the project, and a slot one had sent back
        // gets its delivered (or approved) state back first — before the
        // slots are withdrawn, or it would be cancelled with the rest and
        // its delivery left flagged for a revision that no longer exists.
        await restoreRevisedSlots(tx, { projectId: input.projectId });

        const slots = await tx.execute<{ id: number }>(sql`
          UPDATE deliverables SET status = 'cancelled'
          WHERE project_id = ${input.projectId} AND status NOT IN ('approved','delivered','cancelled')
          RETURNING id
        `);
        cancelledSlots = slots.length;

        // A rework still in QA went with them and will never be reviewed, so
        // the delivery it was to replace gets its delivered state back as
        // well: nothing stays flagged for a revision that no longer exists,
        // with no move Sales could make. The file the client has stands (§14).
        await tx.execute(sql`
          UPDATE deliveries dl SET status = 'delivered'
          WHERE dl.project_id = ${input.projectId} AND dl.status = 'revision_required'
            AND dl.id = (SELECT max(id) FROM deliveries WHERE deliverable_id = dl.deliverable_id)
        `);

        // An assignment whose remaining slots all went is withdrawn; one that
        // had already delivered something is closed on what it delivered.
        const assignments = await tx.execute<{ id: number }>(sql`
          SELECT id FROM assignments
          WHERE project_id = ${input.projectId} AND status NOT IN ('completed','cancelled')
        `);
        for (const a of assignments) await syncAssignmentStatus(tx, Number(a.id));
        const withdrawn = await tx.execute<{ id: number }>(sql`
          UPDATE assignments SET status = 'cancelled'
          WHERE project_id = ${input.projectId} AND status NOT IN ('completed','cancelled')
          RETURNING id
        `);
        cancelledAssignments = withdrawn.length;

        await tx.execute(sql`
          UPDATE revisions SET status = 'cancelled', closed_at = now()
          WHERE project_id = ${input.projectId}
            AND status NOT IN ('delivered','closed','cancelled')
        `);
        await tx.execute(sql`
          UPDATE projects SET status = 'cancelled', held_from_status = NULL WHERE id = ${input.projectId}
        `);
        status = 'cancelled';
        break;
      }
      default:
        throw new ProjectStatusError('Unknown status change.');
    }

    await onProjectStatusChanged(tx, {
      projectId: input.projectId, change: input.change, reason, actorId: actor.id,
    });
    return { projectId: input.projectId, from, status, cancelledSlots, cancelledAssignments };
  });
}

/**
 * Why no new work may start on a project, or null when it may. Used by the
 * guards on assignment, upload and revision, so a held or cancelled project
 * gives the same answer everywhere.
 */
export function workBlockedReason(status: string): string | null {
  switch (status) {
    case 'on_hold': return 'This project is on hold. It must be resumed before new work starts.';
    case 'cancelled': return 'This project was cancelled.';
    case 'completed': return 'This project is completed.';
    default: return null;
  }
}
