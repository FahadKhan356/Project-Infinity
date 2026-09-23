'use server';

import { revalidatePath } from 'next/cache';
import { recordActivity } from '@/lib/auth/audit';
import { requireActor } from '@/lib/auth/dal';
import { DeliveryError, parseDeliveryForm, updateDelivery } from '@/lib/delivery/deliveries';

export interface DeliveryFormState {
  error?: string;
  notice?: string;
}

/** Sales moves a delivery along (brief §14). */
export async function submitDeliveryUpdate(
  _prev: DeliveryFormState,
  formData: FormData,
): Promise<DeliveryFormState> {
  const actor = await requireActor();

  let result;
  try {
    const input = parseDeliveryForm(formData);
    if (!Number.isInteger(input.deliveryId)) return { error: 'Unknown delivery.' };
    result = await updateDelivery(actor, input);
  } catch (error) {
    if (error instanceof DeliveryError) return { error: error.message };
    throw error;
  }

  await recordActivity({
    actorId: actor.id,
    action: 'delivery.updated',
    entityType: 'delivery',
    entityId: result.deliveryId,
    projectId: result.projectId,
    metadata: {
      status: result.status,
      deliverableId: result.deliverableId,
      deliverableName: result.deliverableName,
      projectStatus: result.projectStatus,
    },
  });

  revalidatePath('/deliveries');
  revalidatePath('/projects');
  revalidatePath(`/projects/${result.projectId}`);
  revalidatePath('/work');

  return { notice: `${result.deliverableName}: ${result.status.replace(/_/g, ' ')}.` };
}
