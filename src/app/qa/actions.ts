'use server';

import { revalidatePath } from 'next/cache';
import { requireActor } from '@/lib/auth/dal';
import { QaError, parseReviewForm, reviewDeliverable } from '@/lib/qa/review';

export interface QaFormState {
  error?: string;
  notice?: string;
}

/**
 * One QA decision (brief §12, §13). The library owns the rules and writes
 * the record, inside its transaction and ahead of any automatic delivery
 * (§25, §29); this refreshes and answers.
 */
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

  revalidatePath('/qa');
  revalidatePath('/deliveries');
  revalidatePath('/work');
  revalidatePath('/planning');
  revalidatePath(`/projects/${result.projectId}`);

  // Trigger WhatsApp alert to CEO & COO
  try {
    const { getDb } = await import('@/db');
    const { sql } = await import('drizzle-orm');
    const [proj] = await getDb().execute<{ code: string; title: string; dept_name: string }>(sql`
      SELECT p.code, p.title, d.name AS dept_name
      FROM projects p
      JOIN deliverables del ON del.project_id = p.id
      JOIN project_departments pd ON pd.id = del.project_department_id
      JOIN departments d ON d.id = pd.department_id
      WHERE del.id = ${result.deliverableId}
      LIMIT 1
    `);
    if (proj) {
      import('@/lib/whatsapp/executive-alerts')
        .then(({ notifyExecutivesQaDecision }) =>
          notifyExecutivesQaDecision({
            projectCode: proj.code,
            projectTitle: proj.title,
            deliverableName: result.deliverableName,
            department: proj.dept_name,
            reviewerName: actor.fullName,
            reviewerRole: actor.role === 'team_lead' ? 'Team Lead' : 'Project Manager',
            decision: result.decision,
            comments: (formData.get('comments') as string)?.trim() || null,
            versionNo: result.versionNo,
            deliverableId: result.deliverableId,
          }),
        )
        .catch((e) => console.error('[WhatsApp QA Alert Error]', e));
    }
  } catch {
    // Non-blocking
  }

  const name = `${result.deliverableName} v${result.versionNo}`;
  return {
    notice:
      result.newStatus === 'approved'
        ? (result.autoDelivered
          ? `${name} approved and delivered to the client portal.`
          : `${name} approved — it is now in Sales’ delivery queue.`)
        : result.newStatus === 'awaiting_pm_qa'
          ? `${name} approved and passed to the Project Manager.`
          : `${name} sent back to ${result.stage === 'project_manager' ? 'the team' : 'the executive'}.`,
  };
}
