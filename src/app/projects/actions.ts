'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { recordActivity } from '@/lib/auth/audit';
import { requireActor } from '@/lib/auth/dal';
import { can, projectScope } from '@/lib/authz';
import { IntakeError, fileProject, parseProjectForm } from '@/lib/projects/file-project';
import { WorkspaceError, addComment } from '@/lib/workspace/comments';

export interface ProjectFormState {
  error?: string;
  notice?: string;
}

/**
 * Sales files a confirmed project (brief §3).
 *
 * This is a thin shell: parsing and the transaction live in
 * src/lib/projects/file-project.ts so both can be tested directly.
 */
export async function createProject(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const actor = await requireActor();

  let result;
  try {
    const input = parseProjectForm(formData);
    if (!Number.isInteger(input.clientId)) {
      return { error: 'Choose a client. If they are new, create the client record first.' };
    }
    result = await fileProject(actor, input);
  } catch (error) {
    if (error instanceof IntakeError) return { error: error.message };
    throw error;
  }

  await recordActivity({
    actorId: actor.id,
    action: 'project.created',
    entityType: 'project',
    entityId: result.projectId,
    projectId: result.projectId,
    metadata: { projectCode: result.projectCode, monthCreated: result.monthCreated },
  });

  revalidatePath('/projects');
  revalidatePath('/clients');
  redirect(`/projects/${result.projectId}`);
}

export async function updateInternalNotes(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const actor = await requireActor();
  const projectId = Number(formData.get('projectId'));
  if (!Number.isInteger(projectId)) return { error: 'Unknown project.' };

  const visible = await getDb().execute<{ ok: number }>(
    sql`SELECT 1 AS ok FROM projects WHERE projects.id = ${projectId} AND ${projectScope(actor)} LIMIT 1`,
  );
  if (visible.length === 0) return { error: 'Unknown project.' };
  if (!can(actor, 'projects.create') && !can(actor, 'projects.triage')) {
    return { error: 'You are not permitted to edit this project.' };
  }

  const notes = String(formData.get('internalNotes') ?? '').trim() || null;
  await getDb().execute(sql`
    UPDATE projects SET internal_notes = ${notes} WHERE id = ${projectId}
  `);

  await recordActivity({
    actorId: actor.id,
    action: 'project.notes_updated',
    entityType: 'project',
    entityId: projectId,
    projectId,
  });

  revalidatePath(`/projects/${projectId}`);
  return { notice: 'Notes saved.' };
}

/** A comment on the shared workspace, or pinned to one of its slots (brief §9). */
export async function postComment(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const actor = await requireActor();

  const projectId = Number(formData.get('projectId'));
  if (!Number.isInteger(projectId)) return { error: 'Unknown project.' };
  const rawDeliverable = String(formData.get('deliverableId') ?? '').trim();
  const deliverableId = rawDeliverable === '' ? undefined : Number(rawDeliverable);
  if (deliverableId !== undefined && !Number.isInteger(deliverableId)) {
    return { error: 'Unknown deliverable.' };
  }

  let result;
  try {
    result = await addComment(actor, {
      body: String(formData.get('body') ?? ''),
      ...(deliverableId === undefined ? { projectId } : { deliverableId }),
    });
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
    metadata: deliverableId === undefined ? {} : { deliverableId },
  });

  revalidatePath(`/projects/${result.projectId}`);
  return { notice: 'Posted.' };
}
