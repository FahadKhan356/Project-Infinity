'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { users } from '@/db/schema';
import { recordActivity } from '@/lib/auth/audit';
import { requireActor } from '@/lib/auth/dal';
import {
  RevisionError, assignRevision, closeRevision, createRevision, parseRevisionForm, revisionTag,
} from '@/lib/revisions/revisions';
import { WorkspaceError, addComment } from '@/lib/workspace/comments';

export interface RevisionFormState {
  error?: string;
  notice?: string;
  /** Set instead of redirecting when the form still has files to attach (§15). */
  createdRevision?: { projectId: number; revisionId: number };
}

function refresh(projectId: number, revisionId?: number) {
  revalidatePath('/revisions');
  if (revisionId !== undefined) revalidatePath(`/revisions/${revisionId}`);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/deliveries');
  revalidatePath('/work');
  revalidatePath('/planning');
}

/** Sales opens a revision from client feedback (brief §15). */
export async function openRevision(
  _prev: RevisionFormState,
  formData: FormData,
): Promise<RevisionFormState> {
  const actor = await requireActor();

  let result;
  try {
    const input = parseRevisionForm(formData);
    if (!Number.isInteger(input.projectId)) return { error: 'Unknown project.' };
    result = await createRevision(actor, input);
  } catch (error) {
    if (error instanceof RevisionError) return { error: error.message };
    throw error;
  }

  await recordActivity({
    actorId: actor.id,
    action: 'revision.created',
    entityType: 'revision',
    entityId: result.revisionId,
    projectId: result.projectId,
    metadata: {
      revisionNo: result.revisionNo,
      title: String(formData.get('title') ?? '').trim(),
      deliverableIds: result.deliverableIds,
      projectStatus: result.projectStatus,
    },
  });

  refresh(result.projectId, result.revisionId);
  if (formData.get('stayAfterCreate') === '1') {
    return { createdRevision: { projectId: result.projectId, revisionId: result.revisionId } };
  }
  redirect(`/revisions/${result.revisionId}`);
}

/** A Team Lead hands a revision's slot to an Executive (brief §17). */
export async function handRevision(
  _prev: RevisionFormState,
  formData: FormData,
): Promise<RevisionFormState> {
  const actor = await requireActor();
  const revisionId = Number(formData.get('revisionId'));
  const deliverableId = Number(formData.get('deliverableId'));
  const assigneeId = Number(formData.get('assigneeId'));
  if (!Number.isInteger(revisionId) || !Number.isInteger(deliverableId)) return { error: 'Unknown revision.' };
  if (!Number.isInteger(assigneeId)) return { error: 'Choose who is doing the work.' };

  let result;
  try {
    result = await assignRevision(actor, { revisionId, deliverableId, assigneeId });
  } catch (error) {
    if (error instanceof RevisionError) return { error: error.message };
    throw error;
  }

  const [assignee] = await getDb()
    .select({ fullName: users.fullName })
    .from(users)
    .where(eq(users.id, assigneeId))
    .limit(1);

  await recordActivity({
    actorId: actor.id,
    action: 'revision.assigned',
    entityType: 'revision',
    entityId: result.revisionId,
    projectId: result.projectId,
    metadata: {
      revisionNo: result.revisionNo,
      deliverableId: result.deliverableId,
      deliverableName: result.deliverableName,
      assigneeId,
      assigneeName: assignee?.fullName ?? null,
      assignmentId: result.assignmentId,
      assignmentCreated: result.created,
    },
  });

  refresh(result.projectId, result.revisionId);
  return {
    notice: `${result.deliverableName} handed to ${assignee?.fullName ?? 'them'}${
      result.created ? ' as a new assignment' : ''}.`,
  };
}

/** Sales or the PM ends a revision — closed (done) or cancelled (withdrawn). */
export async function endRevision(
  _prev: RevisionFormState,
  formData: FormData,
): Promise<RevisionFormState> {
  const actor = await requireActor();
  const revisionId = Number(formData.get('revisionId'));
  const outcome = String(formData.get('outcome') ?? '');
  if (!Number.isInteger(revisionId)) return { error: 'Unknown revision.' };
  if (outcome !== 'closed' && outcome !== 'cancelled') return { error: 'Choose an outcome.' };

  let result;
  try {
    result = await closeRevision(actor, { revisionId, outcome });
  } catch (error) {
    if (error instanceof RevisionError) return { error: error.message };
    throw error;
  }

  await recordActivity({
    actorId: actor.id,
    action: 'revision.closed',
    entityType: 'revision',
    entityId: result.revisionId,
    projectId: result.projectId,
    metadata: { revisionNo: result.revisionNo, status: result.status, projectStatus: result.projectStatus },
  });

  refresh(result.projectId, result.revisionId);
  return { notice: `Revision ${revisionTag(result.revisionNo)} ${result.status}.` };
}

export async function commentOnRevision(
  _prev: RevisionFormState,
  formData: FormData,
): Promise<RevisionFormState> {
  const actor = await requireActor();
  const revisionId = Number(formData.get('revisionId'));
  if (!Number.isInteger(revisionId)) return { error: 'Unknown revision.' };

  let result;
  try {
    result = await addComment(actor, { revisionId, body: String(formData.get('body') ?? '') });
  } catch (error) {
    if (error instanceof WorkspaceError) return { error: error.message };
    throw error;
  }

  await recordActivity({
    actorId: actor.id,
    action: 'comment.posted',
    entityType: 'comment',
    entityId: result.commentId,
    projectId: result.projectId,
    metadata: { revisionId },
  });

  revalidatePath(`/revisions/${revisionId}`);
  return { notice: 'Posted.' };
}
