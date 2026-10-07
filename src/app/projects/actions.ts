'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { recordActivity } from '@/lib/auth/audit';
import { requireActor } from '@/lib/auth/dal';
import { can, projectScope } from '@/lib/authz';
import { MonthError, assertMonthOpen } from '@/lib/months/lifecycle';
import { IntakeError, fileProject, parseProjectForm } from '@/lib/projects/file-project';
import {
  ProjectEditError, editProjectDetails, parseProjectDetailsForm, parseTeamQaForm, DETAIL_LABELS,
} from '@/lib/projects/edit';
import { ProjectStatusError, changeProjectStatus, type StatusChange } from '@/lib/projects/status';
import { ProjectShareError, shareProject, unshareProject } from '@/lib/projects/viewers';
import { WorkspaceError, addComment } from '@/lib/workspace/comments';

export interface ProjectFormState {
  error?: string;
  notice?: string;
  /** Set instead of redirecting when the form still has files to attach (§3). */
  createdProjectId?: number;
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
  const opportunityId = Number(formData.get('opportunityId'));
  if (formData.get('opportunityId') && Number.isInteger(opportunityId)) {
    await recordActivity({
      actorId: actor.id,
      action: 'opportunity.won',
      entityType: 'opportunity',
      entityId: opportunityId,
      projectId: result.projectId,
      metadata: { projectCode: result.projectCode },
    });
    revalidatePath('/pipeline');
  }

  revalidatePath('/projects');
  revalidatePath('/clients');
  if (formData.get('stayAfterCreate') === '1') return { createdProjectId: result.projectId };
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
  try {
    await assertMonthOpen(getDb(), { projectId });
  } catch (error) {
    if (error instanceof MonthError) return { error: error.message };
    throw error;
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

/**
 * A comment on the shared workspace, or pinned to one of its slots or file
 * versions (brief §9, §10, §19).
 */
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
  const rawVersion = String(formData.get('versionId') ?? '').trim();
  const versionId = rawVersion === '' ? undefined : Number(rawVersion);
  if (versionId !== undefined && !Number.isInteger(versionId)) {
    return { error: 'Unknown file version.' };
  }

  let result;
  try {
    result = await addComment(actor, {
      body: String(formData.get('body') ?? ''),
      // The most specific target given wins: a version, else a slot, else the project.
      ...(versionId !== undefined ? { versionId } : deliverableId !== undefined ? { deliverableId } : { projectId }),
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
    // What the feed line names (describeActivity): "on Thumbnail 01 v3".
    metadata: result.slot === null ? {} : {
      deliverableId: result.slot.deliverableId,
      deliverableName: result.slot.deliverableName,
      ...(result.slot.versionId === null ? {} : { versionId: result.slot.versionId, versionNo: result.slot.versionNo }),
    },
  });

  revalidatePath(`/projects/${result.projectId}`);
  return { notice: 'Posted.' };
}

/** Hold, resume or cancel (brief §18). */
export async function changeStatus(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const actor = await requireActor();
  const projectId = Number(formData.get('projectId'));
  if (!Number.isInteger(projectId)) return { error: 'Unknown project.' };
  const change = String(formData.get('change') ?? '') as StatusChange;
  if (change !== 'hold' && change !== 'resume' && change !== 'cancel') {
    return { error: 'Choose what to do.' };
  }
  const reason = String(formData.get('reason') ?? '').trim().slice(0, 1000) || null;

  let result;
  try {
    result = await changeProjectStatus(actor, { projectId, change, reason });
  } catch (error) {
    if (error instanceof ProjectStatusError || error instanceof MonthError) return { error: error.message };
    throw error;
  }

  await recordActivity({
    actorId: actor.id,
    action: 'project.status_changed',
    entityType: 'project',
    entityId: projectId,
    projectId,
    metadata: {
      change, reason, from: result.from, status: result.status,
      cancelledSlots: result.cancelledSlots, cancelledAssignments: result.cancelledAssignments,
    },
  });

  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/projects');
  return {
    notice: change === 'hold' ? 'The project is on hold.'
      : change === 'resume' ? 'The project has resumed.'
      : `The project is cancelled. ${result.cancelledSlots} unfinished slot${result.cancelledSlots === 1 ? '' : 's'} withdrawn.`,
  };
}

/** Sales or the PM corrects what was filed (brief §3, §27). */
export async function editProject(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const actor = await requireActor();
  const projectId = Number(formData.get('projectId'));
  if (!Number.isInteger(projectId)) return { error: 'Unknown project.' };

  let result;
  try {
    result = await editProjectDetails(actor, {
      projectId,
      details: parseProjectDetailsForm(formData),
      teamQa: parseTeamQaForm(formData),
    });
  } catch (error) {
    if (error instanceof ProjectEditError || error instanceof MonthError) return { error: error.message };
    throw error;
  }

  if (result.changed.length > 0) {
    // The feed is read by everyone on the project, so it names the fields,
    // never the values; projectActivity drops "price" for those who cannot
    // see pricing.
    await recordActivity({
      actorId: actor.id,
      action: 'project.details_edited',
      entityType: 'project',
      entityId: projectId,
      projectId,
      metadata: { fields: result.changed.map((key) => DETAIL_LABELS[key]) },
    });
  }

  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/projects');
  redirect(`/projects/${projectId}`);
}

/**
 * Management or the PM lets a Sales rep view this project, or stops (brief
 * §23: "projects they create/are authorized to view"). One action for both,
 * told apart by the button pressed.
 */
export async function changeSharing(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const actor = await requireActor();
  const projectId = Number(formData.get('projectId'));
  if (!Number.isInteger(projectId)) return { error: 'Unknown project.' };
  const userId = Number(formData.get('userId'));
  if (!Number.isInteger(userId) || userId <= 0) return { error: 'Choose a Sales representative.' };
  const share = formData.get('change') !== 'unshare';

  let result;
  try {
    result = share
      ? await shareProject(actor, { projectId, userId })
      : await unshareProject(actor, { projectId, userId });
  } catch (error) {
    if (error instanceof ProjectShareError) return { error: error.message };
    throw error;
  }

  if (result.changed) {
    await recordActivity({
      actorId: actor.id,
      action: share ? 'project.shared' : 'project.unshared',
      entityType: 'project',
      entityId: projectId,
      projectId,
      metadata: { userId, userName: result.userName },
    });
  }

  revalidatePath(`/projects/${projectId}`);
  return {
    notice: !share ? `${result.userName} can no longer view this project.`
      : result.changed ? `Shared with ${result.userName}.`
      : `${result.userName} can already view this project.`,
  };
}
