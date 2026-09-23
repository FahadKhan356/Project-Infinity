'use server';

import { revalidatePath } from 'next/cache';
import { recordActivity } from '@/lib/auth/audit';
import { requireActor } from '@/lib/auth/dal';
import { QaError, parseReviewForm, reviewDeliverable } from '@/lib/qa/review';

export interface QaFormState {
  error?: string;
  notice?: string;
}

/** One QA decision (brief §12, §13). The library owns the rules; this records and refreshes. */
export async function submitReview(
  _prev: QaFormState,
  formData: FormData,
): Promise<QaFormState> {
  const actor = await requireActor();

  let result;
  try {
    const input = parseReviewForm(formData);
    if (!Number.isInteger(input.deliverableId)) return { error: 'Unknown deliverable.' };
    if (!input.decision) return { error: 'Choose a decision.' };
    result = await reviewDeliverable(actor, input);
  } catch (error) {
    if (error instanceof QaError) return { error: error.message };
    throw error;
  }

  await recordActivity({
    actorId: actor.id,
    action: 'qa.reviewed',
    entityType: 'deliverable',
    entityId: result.deliverableId,
    projectId: result.projectId,
    metadata: {
      stage: result.stage,
      decision: result.decision,
      roundNo: result.roundNo,
      deliverableName: result.deliverableName,
      versionNo: result.versionNo,
      newStatus: result.newStatus,
      deliveryId: result.deliveryId,
      projectStatus: result.projectStatus,
    },
  });

  revalidatePath('/qa');
  revalidatePath('/deliveries');
  revalidatePath('/work');
  revalidatePath('/planning');
  revalidatePath(`/projects/${result.projectId}`);

  const name = `${result.deliverableName} v${result.versionNo}`;
  return {
    notice:
      result.newStatus === 'approved'
        ? `${name} approved — it is now in Sales’ delivery queue.`
        : result.newStatus === 'awaiting_pm_qa'
          ? `${name} approved and passed to the Project Manager.`
          : `${name} sent back to ${result.stage === 'project_manager' ? 'the team' : 'the executive'}.`,
  };
}
