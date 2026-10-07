'use server';

import { revalidatePath } from 'next/cache';
import { recordActivity } from '@/lib/auth/audit';
import { requireActor } from '@/lib/auth/dal';
import { MonthError } from '@/lib/months/lifecycle';
import { TimeError, deleteTime, logTime } from '@/lib/time/entries';
import { parseHours } from '@/lib/time/format';

export interface TimeFormState {
  error?: string;
  notice?: string;
  /** Bumped on success so the form can reset. */
  saved?: number;
}

/** Records time on one of the person's own assignments (brief §29). */
export async function logTimeAction(_prev: TimeFormState, formData: FormData): Promise<TimeFormState> {
  const actor = await requireActor();
  const assignmentId = Number(formData.get('assignmentId'));
  if (!Number.isInteger(assignmentId)) return { error: 'Choose one of your assignments.' };

  let minutes: number | null;
  try {
    minutes = parseHours(String(formData.get('hours') ?? ''), 24);
  } catch {
    return { error: 'Enter hours like 2, 1.5 or 1:45 — at most 24.' };
  }
  if (minutes === null) return { error: 'Enter how long you worked.' };

  let result;
  try {
    result = await logTime(actor, {
      assignmentId,
      workDate: String(formData.get('workDate') ?? ''),
      minutes,
      note: String(formData.get('note') ?? ''),
    });
  } catch (error) {
    if (error instanceof TimeError || error instanceof MonthError) return { error: error.message };
    throw error;
  }

  await recordActivity({
    actorId: actor.id,
    action: 'time.logged',
    entityType: 'time_entry',
    entityId: result.entryId,
    metadata: { assignmentId, minutes, workDate: String(formData.get('workDate')) },
  });
  revalidatePath('/time');
  return { notice: 'Time logged.', saved: Date.now() };
}

export async function deleteTimeAction(_prev: TimeFormState, formData: FormData): Promise<TimeFormState> {
  const actor = await requireActor();
  const entryId = Number(formData.get('entryId'));
  if (!Number.isInteger(entryId)) return { error: 'No such entry.' };
  let result;
  try {
    result = await deleteTime(actor, entryId);
  } catch (error) {
    if (error instanceof TimeError || error instanceof MonthError) return { error: error.message };
    throw error;
  }
  await recordActivity({
    actorId: actor.id,
    action: 'time.deleted',
    entityType: 'time_entry',
    entityId: entryId,
    projectId: result.projectId,
  });
  revalidatePath('/time');
  return { notice: 'Entry removed.' };
}
