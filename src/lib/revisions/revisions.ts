import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { can, revisionScope } from '@/lib/authz';
import { isProjectVisible } from '@/lib/authz/queries';
import { assertMonthOpen } from '@/lib/months/lifecycle';
import { syncAssignmentStatus, syncProjectStatus } from '@/lib/qa/project-status';

export class RevisionError extends Error {}

export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export interface RevisionInput {
  projectId: number;
  title: string;
  clientFeedback: string;
  details?: string | null;
  priority?: Priority;
  deadline?: string | null;
  deliverableIds: number[];
}

export interface RevisionResult {
  revisionId: number;
  revisionNo: number;
  projectId: number;
  deliverableIds: number[];
  projectStatus: string | null;
}

/**
 * Sales opens a revision from client feedback (brief §15).
 *
 * It is pinned to the deliverables it is about, and those slots are the ones
 * that move: each goes back to `changes_requested` so the Executive's list
 * says "to redo", the delivery that came back is marked `revision_required`
 * (§14), and the project says `revision_required` (§18) until the revision
 * is worked through. Numbering is per project, so the client's "#03" is ours.
 */
export async function createRevision(actor: Actor, input: RevisionInput): Promise<RevisionResult> {
  if (!can(actor, 'revisions.create')) {
    throw new RevisionError('You are not permitted to open revisions.');
  }
  const title = input.title.trim();
  if (title.length < 2) throw new RevisionError('Give the revision a title.');
  const feedback = input.clientFeedback.trim();
  if (feedback.length === 0) throw new RevisionError('Enter the client’s feedback.');

  const deliverableIds = [...new Set(input.deliverableIds.filter((id) => Number.isInteger(id)))];
  if (deliverableIds.length === 0) throw new RevisionError('Choose at least one deliverable.');

  const db = getDb();
  if (!(await isProjectVisible(db, actor, input.projectId))) {
    throw new RevisionError('No such project.');
  }
  await assertMonthOpen(db, { projectId: input.projectId }, (m) => new RevisionError(m));

  const idList = sql.join(deliverableIds.map((id) => sql`${id}`), sql`, `);
  const slots = await db.execute<{ id: number; assignment_id: number | null }>(sql`
    SELECT id, assignment_id FROM deliverables
    WHERE id IN (${idList}) AND project_id = ${input.projectId} AND status <> 'cancelled'
  `);
  if (slots.length !== deliverableIds.length) {
    throw new RevisionError('A deliverable you chose is not on this project.');
  }

  return db.transaction(async (tx) => {
    // Lock the project so two revisions opened at once cannot share a number.
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${input.projectId} FOR UPDATE`);
    const [{ next }] = await tx.execute<{ next: number }>(sql`
      SELECT COALESCE(MAX(revision_no), 0) + 1 AS next FROM revisions WHERE project_id = ${input.projectId}
    `);
    const revisionNo = Number(next);

    const [revision] = await tx.execute<{ id: number }>(sql`
      INSERT INTO revisions (project_id, revision_no, title, client_feedback, details, priority, deadline, created_by)
      VALUES (${input.projectId}, ${revisionNo}, ${title}, ${feedback}, ${input.details?.trim() || null},
              ${input.priority ?? 'normal'}::priority_level, ${input.deadline ?? null}, ${actor.id})
      RETURNING id
    `);
    const revisionId = Number(revision.id);

    for (const deliverableId of deliverableIds) {
      await tx.execute(sql`
        INSERT INTO revision_deliverables (revision_id, deliverable_id, project_id)
        VALUES (${revisionId}, ${deliverableId}, ${input.projectId})
      `);
    }

    await tx.execute(sql`
      UPDATE deliverables SET status = 'changes_requested'
      WHERE id IN (${idList}) AND status IN ('approved', 'delivered')
    `);
    await tx.execute(sql`
      UPDATE deliveries dl
      SET status = 'revision_required',
          client_feedback = COALESCE(dl.client_feedback, ${feedback})
      WHERE dl.deliverable_id IN (${idList})
        AND dl.status IN ('delivered', 'client_feedback_received')
        AND dl.id = (SELECT max(id) FROM deliveries WHERE deliverable_id = dl.deliverable_id)
    `);

    const assignmentIds = new Set(
      slots.map((s) => s.assignment_id).filter((id): id is number => id !== null).map(Number),
    );
    for (const assignmentId of assignmentIds) await syncAssignmentStatus(tx, assignmentId);
    const projectStatus = await syncProjectStatus(tx, input.projectId);

    return { revisionId, revisionNo, projectId: input.projectId, deliverableIds, projectStatus };
  });
}

type RevisionRow = {
  id: number; project_id: number; revision_no: number; title: string; client_feedback: string;
  details: string | null; priority: Priority; deadline: string | null; status: string;
};

async function loadVisibleRevision(actor: Actor, revisionId: number): Promise<RevisionRow> {
  const rows = await getDb().execute<RevisionRow>(sql`
    SELECT r.id, r.project_id, r.revision_no, r.title, r.client_feedback, r.details, r.priority,
           to_char(r.deadline, 'YYYY-MM-DD') AS deadline, r.status
    FROM revisions r
    WHERE r.id = ${revisionId} AND ${revisionScope(actor, 'r')}
  `);
  const row = rows[0];
  if (!row) throw new RevisionError('No such revision.');
  return row;
}

export interface AssignRevisionInput {
  revisionId: number;
  deliverableId: number;
  assigneeId: number;
}

export interface AssignRevisionResult {
  revisionId: number;
  revisionNo: number;
  projectId: number;
  deliverableId: number;
  deliverableName: string;
  assigneeId: number;
  assignmentId: number;
  /** Whether a new assignment was opened for the assignee. */
  created: boolean;
}

/**
 * A Team Lead hands a revision to an Executive (brief §17).
 *
 * The slot moves to an open assignment of that person on the same team — or
 * a new one titled after the revision, carrying the client's feedback as its
 * instructions. The slot itself never moves teams, and never duplicates, so
 * progress and history stay attached to the same "Video 01".
 */
export async function assignRevision(actor: Actor, input: AssignRevisionInput): Promise<AssignRevisionResult> {
  if (!can(actor, 'assignments.create')) {
    throw new RevisionError('You are not permitted to assign work.');
  }
  const revision = await loadVisibleRevision(actor, input.revisionId);
  if (revision.status === 'closed' || revision.status === 'cancelled') {
    throw new RevisionError('This revision is closed.');
  }

  const db = getDb();
  await assertMonthOpen(db, { projectId: Number(revision.project_id) }, (m) => new RevisionError(m));
  const slots = await db.execute<{
    id: number; name: string; assignment_id: number | null; project_department_id: number;
    department_id: number; team_lead_id: number | null;
  }>(sql`
    SELECT d.id, d.name, d.assignment_id, d.project_department_id, pd.department_id, pd.team_lead_id
    FROM deliverables d
    JOIN project_departments pd ON pd.id = d.project_department_id
    WHERE d.id = ${input.deliverableId}
      AND EXISTS (SELECT 1 FROM revision_deliverables rd
                  WHERE rd.revision_id = ${input.revisionId} AND rd.deliverable_id = d.id)
  `);
  const slot = slots[0];
  if (!slot) throw new RevisionError('That deliverable is not part of this revision.');

  const departmentId = Number(slot.department_id);
  const isLead =
    (slot.team_lead_id !== null && Number(slot.team_lead_id) === actor.id) ||
    actor.leadDepartmentIds.includes(departmentId);
  if (!isLead && !can(actor, 'planning.viewAllDepartments')) {
    throw new RevisionError('This team’s work is not yours to assign.');
  }

  const membership = await db.execute<{ ok: number }>(sql`
    SELECT 1 AS ok FROM department_members
    WHERE user_id = ${input.assigneeId} AND department_id = ${departmentId} LIMIT 1
  `);
  if (membership.length === 0) throw new RevisionError('That person is not a member of this team.');

  const projectDepartmentId = Number(slot.project_department_id);
  const previousAssignmentId = slot.assignment_id === null ? null : Number(slot.assignment_id);

  return db.transaction(async (tx) => {
    const open = await tx.execute<{ id: number }>(sql`
      SELECT id FROM assignments
      WHERE assignee_id = ${input.assigneeId} AND project_department_id = ${projectDepartmentId}
        AND status NOT IN ('completed', 'cancelled')
      ORDER BY created_at DESC LIMIT 1
    `);

    let assignmentId: number;
    let created = false;
    if (open[0]) {
      assignmentId = Number(open[0].id);
    } else {
      const instructions = revision.details
        ? `${revision.client_feedback}\n\n${revision.details}`
        : revision.client_feedback;
      const [inserted] = await tx.execute<{ id: number }>(sql`
        INSERT INTO assignments (project_department_id, project_id, assignee_id, assigned_by, title,
                                 instructions, start_date, end_date, priority)
        VALUES (${projectDepartmentId}, ${revision.project_id}, ${input.assigneeId}, ${actor.id},
                ${`Revision #${revision.revision_no}: ${revision.title}`}, ${instructions},
                current_date, ${revision.deadline}, ${revision.priority}::priority_level)
        RETURNING id
      `);
      assignmentId = Number(inserted.id);
      created = true;
    }

    await tx.execute(sql`
      UPDATE deliverables
      SET assignment_id = ${assignmentId},
          due_date = COALESCE(${revision.deadline}::date, due_date)
      WHERE id = ${slot.id}
    `);

    if (previousAssignmentId !== null && previousAssignmentId !== assignmentId) {
      await syncAssignmentStatus(tx, previousAssignmentId);
    }
    await syncAssignmentStatus(tx, assignmentId);
    await tx.execute(sql`
      UPDATE revisions SET status = 'assigned' WHERE id = ${input.revisionId} AND status = 'new'
    `);

    return {
      revisionId: input.revisionId,
      revisionNo: Number(revision.revision_no),
      projectId: Number(revision.project_id),
      deliverableId: Number(slot.id),
      deliverableName: slot.name,
      assigneeId: input.assigneeId,
      assignmentId,
      created,
    };
  });
}

export interface CloseRevisionInput {
  revisionId: number;
  outcome: 'closed' | 'cancelled';
}

export interface CloseRevisionResult {
  revisionId: number;
  revisionNo: number;
  projectId: number;
  status: 'closed' | 'cancelled';
  projectStatus: string | null;
}

/**
 * Sales (or the Project Manager) ends a revision. Closing records that the
 * client is satisfied; cancelling withdraws it and gives each untouched slot
 * back the delivered state it had.
 */
export async function closeRevision(actor: Actor, input: CloseRevisionInput): Promise<CloseRevisionResult> {
  if (!can(actor, 'revisions.create') && !can(actor, 'projects.triage')) {
    throw new RevisionError('You are not permitted to close revisions.');
  }
  if (input.outcome !== 'closed' && input.outcome !== 'cancelled') {
    throw new RevisionError('Choose an outcome.');
  }
  const revision = await loadVisibleRevision(actor, input.revisionId);
  if (revision.status === 'closed' || revision.status === 'cancelled') {
    throw new RevisionError('This revision is already closed.');
  }

  return getDb().transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE revisions SET status = ${input.outcome}::revision_status, closed_at = now()
      WHERE id = ${input.revisionId}
    `);

    if (input.outcome === 'cancelled') {
      // A slot that was sent back for this revision and never re-uploaded
      // returns to delivered, and so does the delivery that was flagged.
      const restored = await tx.execute<{ id: number; assignment_id: number | null }>(sql`
        UPDATE deliverables d
        SET status = 'delivered'
        FROM revision_deliverables rd
        WHERE rd.revision_id = ${input.revisionId} AND rd.deliverable_id = d.id
          AND d.status = 'changes_requested'
          AND NOT EXISTS (SELECT 1 FROM deliverable_versions v
                          WHERE v.deliverable_id = d.id AND v.revision_id = ${input.revisionId})
          AND EXISTS (SELECT 1 FROM deliveries dl
                      WHERE dl.deliverable_id = d.id AND dl.status = 'revision_required'
                        AND dl.id = (SELECT max(id) FROM deliveries WHERE deliverable_id = d.id))
        RETURNING d.id, d.assignment_id
      `);
      if (restored.length > 0) {
        const ids = sql.join(restored.map((r) => sql`${Number(r.id)}`), sql`, `);
        await tx.execute(sql`
          UPDATE deliveries dl SET status = 'delivered'
          WHERE dl.deliverable_id IN (${ids}) AND dl.status = 'revision_required'
            AND dl.id = (SELECT max(id) FROM deliveries WHERE deliverable_id = dl.deliverable_id)
        `);
        for (const r of restored) {
          if (r.assignment_id !== null) await syncAssignmentStatus(tx, Number(r.assignment_id));
        }
      }
    }

    const projectStatus = await syncProjectStatus(tx, Number(revision.project_id));
    return {
      revisionId: input.revisionId,
      revisionNo: Number(revision.revision_no),
      projectId: Number(revision.project_id),
      status: input.outcome,
      projectStatus,
    };
  });
}

export function parseRevisionForm(formData: FormData): RevisionInput {
  const text = (key: string): string | null => {
    const value = String(formData.get(key) ?? '').trim();
    return value === '' ? null : value;
  };
  const priorityRaw = String(formData.get('priority') ?? 'normal');
  const priority = (['low', 'normal', 'high', 'urgent'] as const).includes(priorityRaw as Priority)
    ? (priorityRaw as Priority)
    : 'normal';
  return {
    projectId: Number(formData.get('projectId')),
    title: String(formData.get('title') ?? ''),
    clientFeedback: String(formData.get('clientFeedback') ?? ''),
    details: text('details'),
    priority,
    deadline: text('deadline'),
    deliverableIds: formData.getAll('deliverableId').map(Number).filter(Number.isInteger),
  };
}
