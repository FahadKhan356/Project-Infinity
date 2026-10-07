'use server';

import { revalidatePath } from 'next/cache';
import { recordActivity } from '@/lib/auth/audit';
import { requireClientActor } from '@/lib/auth/dal';
import { PortalError, clientDecide } from '@/lib/portal/portal';

export interface DecisionState {
  error?: string;
  notice?: string;
}

/** A client approves a delivered file or asks for changes (brief §29). */
export async function decide(_prev: DecisionState, formData: FormData): Promise<DecisionState> {
  const actor = await requireClientActor();
  const deliveryId = Number(formData.get('deliveryId'));
  const decision = formData.get('decision') === 'approved' ? 'approved' : 'changes_requested';
  if (!Number.isInteger(deliveryId)) return { error: 'Not found.' };
  let result;
  try {
    result = await clientDecide(actor, { deliveryId, decision, feedback: String(formData.get('feedback') ?? '') });
  } catch (error) {
    if (error instanceof PortalError) return { error: error.message };
    throw error;
  }
  await recordActivity({
    actorId: actor.id,
    action: 'delivery.client_decision',
    entityType: 'delivery',
    entityId: deliveryId,
    projectId: result.projectId,
    clientId: actor.clientId,
    metadata: { decision, deliverableName: result.deliverableName },
  });
  revalidatePath(`/portal/projects/${result.projectId}`);
  revalidatePath('/portal');
  return {
    notice: decision === 'approved'
      ? 'Thank you — approved.'
      : 'Thank you. Your account manager has your notes and the team will send a new version.',
  };
}
