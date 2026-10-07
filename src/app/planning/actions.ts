'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { users } from '@/db/schema';
import { recordActivity } from '@/lib/auth/audit';
import { requireActor } from '@/lib/auth/dal';
import { PlanningError, createAssignment, parseAssignmentForm } from '@/lib/planning/assign';

export interface PlanningFormState {
  error?: string;
  notice?: string;
  /** The assignment just made, so the form can attach the references it was made with (§7). */
  created?: { projectId: number; assignmentId: number };
}

export async function assignWork(
  _prev: PlanningFormState,
  formData: FormData,
): Promise<PlanningFormState> {
  const actor = await requireActor();

  let result;
  let input;
  try {
    input = parseAssignmentForm(formData);
    if (!Number.isInteger(input.projectDepartmentId)) return { error: 'Unknown team.' };
    if (!Number.isInteger(input.assigneeId)) return { error: 'Choose who is doing the work.' };
    result = await createAssignment(actor, input);
  } catch (error) {
    if (error instanceof PlanningError) return { error: error.message };
    throw error;
  }

  // The name goes into the log so the feed reads "assigned work to Ahmed"
  // even after the account is renamed or removed (brief §25).
  const [assignee] = await getDb()
    .select({ fullName: users.fullName })
    .from(users)
    .where(eq(users.id, input.assigneeId))
    .limit(1);

  await recordActivity({
    actorId: actor.id,
    action: 'assignment.created',
    entityType: 'assignment',
    entityId: result.assignmentId,
    projectId: result.projectId,
    metadata: {
      assigneeId: input.assigneeId,
      assigneeName: assignee?.fullName ?? null,
      deliverables: result.deliverableIds.length,
      sequenceRange:
        result.firstSequenceNo === null
          ? null
          : `${result.firstSequenceNo}-${result.lastSequenceNo}`,
    },
  });

  revalidatePath('/planning');
  revalidatePath(`/planning/${input.projectDepartmentId}`);
  revalidatePath(`/projects/${result.projectId}`);

  const n = result.deliverableIds.length;
  return {
    created: { projectId: result.projectId, assignmentId: result.assignmentId },
    notice:
      n === 0
        ? 'Assigned with no deliverable slots yet.'
        : `Assigned with ${n} deliverable slot${n === 1 ? '' : 's'} (${result.firstSequenceNo}–${result.lastSequenceNo}).`,
  };
}
