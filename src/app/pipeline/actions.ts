'use server';

import { revalidatePath } from 'next/cache';
import { recordActivity } from '@/lib/auth/audit';
import { requireActor } from '@/lib/auth/dal';
import {
  PipelineError, createOpportunity, loseOpportunity, moveOpportunity, updateOpportunity, type Stage,
} from '@/lib/pipeline/opportunities';

export interface PipelineFormState {
  error?: string;
  notice?: string;
  saved?: number;
}

const text = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim() || null;
function value(formData: FormData): number | null {
  const raw = text(formData, 'estimatedValue');
  return raw === null ? null : Number(raw);
}

async function run(
  fn: () => Promise<{ clientId?: number; id?: number }>,
  log: (r: { clientId?: number; id?: number }) => { action: string; entityId: number; metadata?: Record<string, unknown> },
  notice: string,
): Promise<PipelineFormState> {
  const actor = await requireActor();
  let result;
  try {
    result = await fn();
  } catch (error) {
    if (error instanceof PipelineError) return { error: error.message };
    throw error;
  }
  const entry = log(result);
  await recordActivity({ actorId: actor.id, entityType: 'opportunity', clientId: result.clientId ?? null, ...entry });
  revalidatePath('/pipeline');
  if (result.clientId) revalidatePath(`/clients/${result.clientId}`);
  return { notice, saved: Date.now() };
}

export async function addOpportunity(_prev: PipelineFormState, formData: FormData): Promise<PipelineFormState> {
  const actor = await requireActor();
  const clientId = Number(formData.get('clientId'));
  const title = String(formData.get('title') ?? '');
  return run(
    async () => ({ ...(await createOpportunity(actor, {
      clientId, title, stage: String(formData.get('stage') ?? 'lead') as Stage,
      estimatedValue: value(formData), currency: text(formData, 'currency'),
      expectedClose: text(formData, 'expectedClose'), notes: text(formData, 'notes'),
    })), clientId }),
    (r) => ({ action: 'opportunity.created', entityId: r.id!, metadata: { title } }),
    'Added to the pipeline.',
  );
}

export async function changeStage(_prev: PipelineFormState, formData: FormData): Promise<PipelineFormState> {
  const actor = await requireActor();
  const id = Number(formData.get('id'));
  const stage = String(formData.get('stage') ?? '') as Stage;
  return run(
    () => moveOpportunity(actor, { id, stage }),
    () => ({ action: 'opportunity.stage_changed', entityId: id, metadata: { stage } }),
    'Moved.',
  );
}

export async function editOpportunity(_prev: PipelineFormState, formData: FormData): Promise<PipelineFormState> {
  const actor = await requireActor();
  const id = Number(formData.get('id'));
  return run(
    () => updateOpportunity(actor, {
      id, title: String(formData.get('title') ?? ''), estimatedValue: value(formData),
      currency: text(formData, 'currency'),
      expectedClose: text(formData, 'expectedClose'), notes: text(formData, 'notes'),
    }),
    () => ({ action: 'opportunity.updated', entityId: id }),
    'Saved.',
  );
}

export async function markLost(_prev: PipelineFormState, formData: FormData): Promise<PipelineFormState> {
  const actor = await requireActor();
  const id = Number(formData.get('id'));
  const reason = String(formData.get('reason') ?? '');
  return run(
    () => loseOpportunity(actor, { id, reason }),
    () => ({ action: 'opportunity.lost', entityId: id, metadata: { reason: reason.trim().slice(0, 200) } }),
    'Marked lost.',
  );
}
