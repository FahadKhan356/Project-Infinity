'use server';

import { revalidatePath } from 'next/cache';
import { recordActivity } from '@/lib/auth/audit';
import { requireActor } from '@/lib/auth/dal';
import { CostRateError, removeCostRate, setCostRate } from '@/lib/costs/rates';

export interface CostFormState {
  error?: string;
  notice?: string;
}

/** The CEO or COO sets a person's hourly cost from a date (brief §29). */
export async function saveCostRate(_prev: CostFormState, formData: FormData): Promise<CostFormState> {
  const actor = await requireActor();
  const userId = Number(formData.get('userId'));
  const effectiveFrom = String(formData.get('effectiveFrom') ?? '');
  const raw = String(formData.get('hourlyCost') ?? '').trim();
  if (!Number.isInteger(userId)) return { error: 'No such user.' };
  if (raw === '') return { error: 'Enter the hourly cost.' };
  try {
    await setCostRate(actor, { userId, effectiveFrom, hourlyCost: Number(raw), currency: String(formData.get('currency') ?? 'USD') });
  } catch (error) {
    if (error instanceof CostRateError) return { error: error.message };
    throw error;
  }
  // The log records that a rate changed, never the figure: the activity log
  // is readable by administrators who may not see costs.
  await recordActivity({
    actorId: actor.id, action: 'user.cost_rate_set', entityType: 'user', entityId: userId,
    metadata: { effectiveFrom },
  });
  revalidatePath(`/admin/users/${userId}`);
  return { notice: `Rate saved from ${effectiveFrom}.` };
}

export async function deleteCostRate(_prev: CostFormState, formData: FormData): Promise<CostFormState> {
  const actor = await requireActor();
  const userId = Number(formData.get('userId'));
  const effectiveFrom = String(formData.get('effectiveFrom') ?? '');
  try {
    await removeCostRate(actor, { userId, effectiveFrom });
  } catch (error) {
    if (error instanceof CostRateError) return { error: error.message };
    throw error;
  }
  await recordActivity({
    actorId: actor.id, action: 'user.cost_rate_removed', entityType: 'user', entityId: userId,
    metadata: { effectiveFrom },
  });
  revalidatePath(`/admin/users/${userId}`);
  return { notice: 'Rate removed.' };
}
