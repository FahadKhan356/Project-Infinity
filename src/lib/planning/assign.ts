import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { assignments, departmentMembers, deliverables } from '@/db/schema';
import type { Actor } from '@/lib/authz';
import { can } from '@/lib/authz';

export class PlanningError extends Error {}

/** Twenty designs is a normal order; a hundred is a typo. */
export const MAX_DELIVERABLES_PER_ASSIGNMENT = 100;

export interface AssignmentInput {
  projectDepartmentId: number;
  assigneeId: number;
  title: string;
  instructions?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  /** How many deliverable slots to open. Zero is allowed for open-ended work. */
  deliverableCount: number;
  /** Slot names become "<base> 01", "<base> 02", … numbered per team. */
  deliverableBaseName?: string | null;
  deliverableDescription?: string | null;
  dueDate?: string | null;
}

export interface AssignmentResult {
  assignmentId: number;
  projectId: number;
  deliverableIds: number[];
  firstSequenceNo: number | null;
  lastSequenceNo: number | null;
}

/**
 * A Team Lead hands work to one of their people (brief §7).
 *
 * The slots are created in the same transaction as the assignment, because
 * "20 social media designs" is one decision, not twenty form submissions. Each
 * slot is a unit of progress; files attach to it as versions (§11, §19).
 */
export async function createAssignment(
  actor: Actor,
  input: AssignmentInput,
): Promise<AssignmentResult> {
  if (!can(actor, 'assignments.create')) {
    throw new PlanningError('You are not permitted to assign work.');
  }

  const count = Number.isInteger(input.deliverableCount) ? input.deliverableCount : 0;
  if (count < 0) throw new PlanningError('A deliverable count cannot be negative.');
  if (count > MAX_DELIVERABLES_PER_ASSIGNMENT) {
    throw new PlanningError(
      `That is more than ${MAX_DELIVERABLES_PER_ASSIGNMENT} deliverables. Split it into several assignments.`,
    );
  }

  const title = input.title.trim();
  if (title.length < 2) throw new PlanningError('Give the assignment a title.');

  if (input.startDate && input.endDate && input.endDate < input.startDate) {
    throw new PlanningError('The end date cannot fall before the start date.');
  }

  const db = getDb();

  const [team] = await db.execute<{
    id: number; project_id: number; department_id: number; team_lead_id: number | null;
    project_status: string;
  }>(sql`
    SELECT pd.id, pd.project_id, pd.department_id, pd.team_lead_id, p.status AS project_status
    FROM project_departments pd
    JOIN projects p ON p.id = pd.project_id
    WHERE pd.id = ${input.projectDepartmentId}
  `);
  if (!team) throw new PlanningError('No such team on that project.');

  // Only the lead of this team may plan it — or the Project Manager, who
  // oversees every department (§6).
  const isLeadOfTeam =
    team.team_lead_id !== null && Number(team.team_lead_id) === actor.id;
  if (!isLeadOfTeam && !can(actor, 'planning.viewAllDepartments')) {
    throw new PlanningError('This team is not yours to plan.');
  }

  if (team.project_status === 'cancelled' || team.project_status === 'completed') {
    throw new PlanningError('That project is closed.');
  }

  // The assignee must belong to the department doing the work. Otherwise a
  // designer could be handed video deliverables that their own QA panel would
  // never show.
  const membership = await db
    .select({ userId: departmentMembers.userId })
    .from(departmentMembers)
    .where(
      and(
        eq(departmentMembers.userId, input.assigneeId),
        eq(departmentMembers.departmentId, Number(team.department_id)),
      ),
    )
    .limit(1);
  if (membership.length === 0) {
    throw new PlanningError('That person is not a member of this team.');
  }

  const base = (input.deliverableBaseName ?? '').trim() || 'Deliverable';

  return db.transaction(async (tx) => {
    // Lock the team row so two leads planning at once cannot claim the same
    // sequence numbers.
    await tx.execute(sql`
      SELECT id FROM project_departments WHERE id = ${input.projectDepartmentId} FOR UPDATE
    `);

    const [assignment] = await tx
      .insert(assignments)
      .values({
        projectDepartmentId: input.projectDepartmentId,
        projectId: Number(team.project_id),
        assigneeId: input.assigneeId,
        assignedBy: actor.id,
        title,
        instructions: input.instructions ?? null,
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        priority: input.priority ?? 'normal',
      })
      .returning({ id: assignments.id });

    const deliverableIds: number[] = [];
    let firstSequenceNo: number | null = null;
    let lastSequenceNo: number | null = null;

    if (count > 0) {
      const [{ next }] = await tx.execute<{ next: number }>(sql`
        SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next
        FROM deliverables WHERE project_department_id = ${input.projectDepartmentId}
      `);
      const start = Number(next);

      const rows = Array.from({ length: count }, (_, index) => {
        const sequenceNo = start + index;
        return {
          projectId: Number(team.project_id),
          projectDepartmentId: input.projectDepartmentId,
          assignmentId: assignment.id,
          sequenceNo,
          name: `${base} ${String(sequenceNo).padStart(2, '0')}`,
          description: input.deliverableDescription ?? null,
          dueDate: input.dueDate ?? input.endDate ?? null,
          createdBy: actor.id,
        };
      });

      const created = await tx.insert(deliverables).values(rows).returning({ id: deliverables.id });
      deliverableIds.push(...created.map((row) => row.id));
      firstSequenceNo = start;
      lastSequenceNo = start + count - 1;
    }

    return {
      assignmentId: assignment.id,
      projectId: Number(team.project_id),
      deliverableIds,
      firstSequenceNo,
      lastSequenceNo,
    };
  });
}

export function parseAssignmentForm(formData: FormData): AssignmentInput {
  const text = (key: string): string | null => {
    const value = String(formData.get(key) ?? '').trim();
    return value === '' ? null : value;
  };

  const priorityRaw = String(formData.get('priority') ?? 'normal');
  const priority = (['low', 'normal', 'high', 'urgent'] as const).includes(priorityRaw as never)
    ? (priorityRaw as AssignmentInput['priority'])
    : 'normal';

  return {
    projectDepartmentId: Number(formData.get('projectDepartmentId')),
    assigneeId: Number(formData.get('assigneeId')),
    title: String(formData.get('title') ?? ''),
    instructions: text('instructions'),
    startDate: text('startDate'),
    endDate: text('endDate'),
    priority,
    deliverableCount: Number(formData.get('deliverableCount') ?? 0),
    deliverableBaseName: text('deliverableBaseName'),
    deliverableDescription: text('deliverableDescription'),
    dueDate: text('dueDate'),
  };
}
