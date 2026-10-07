'use server';

import { revalidatePath } from 'next/cache';
import { recordActivity } from '@/lib/auth/audit';
import { requireActor } from '@/lib/auth/dal';
import { SummaryError, generateSummary } from '@/lib/insights/summary';

export interface SummaryState { error?: string }

export async function summariseProject(_prev: SummaryState, formData: FormData): Promise<SummaryState> {
  const actor = await requireActor();
  const projectId = Number(formData.get('projectId'));
  try {
    await generateSummary(actor, projectId);
  } catch (error) {
    if (error instanceof SummaryError) return { error: error.message };
    throw error;
  }
  await recordActivity({ actorId: actor.id, action: 'project.summarised', entityType: 'project', entityId: projectId, projectId });
  revalidatePath(`/projects/${projectId}`);
  return {};
}
