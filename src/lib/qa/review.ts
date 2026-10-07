import 'server-only';
import { autoDeliverIfEnabled } from '@/lib/portal/portal';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { requestIpAddress } from '@/lib/auth/audit';
import type { Actor } from '@/lib/authz';
import { can, canReviewDepartment } from '@/lib/authz';
import { isProjectVisible } from '@/lib/authz/queries';
import { assertMonthOpen } from '@/lib/months/lifecycle';
import { onQaReviewed } from '@/lib/notifications/notify';
import { openRevisionFor, syncRevisionStatus } from '@/lib/revisions/status';
import { syncAssignmentStatus, syncProjectStatus } from './project-status';

export class QaError extends Error {}

export type QaDecision = 'approved' | 'changes_requested' | 'rejected';
export type QaStage = 'team_lead' | 'project_manager';

export const QA_DECISIONS: readonly QaDecision[] = ['approved', 'changes_requested', 'rejected'];

export interface ReviewInput {
  deliverableId: number;
  decision: QaDecision;
  comments?: string | null;
}

export interface ReviewResult {
  deliverableId: number;
  deliverableName: string;
  projectId: number;
  versionId: number;
  versionNo: number;
  stage: QaStage;
  roundNo: number;
  decision: QaDecision;
  newStatus: 'awaiting_pm_qa' | 'approved' | 'changes_requested';
  /** Set when this decision cleared the last QA stage (brief §14). */
  deliveryId: number | null;
  /** The cleared file went straight to the client portal (brief §29), not to Sales' queue. */
  autoDelivered: boolean;
  projectStatus: string | null;
}

/**
 * One QA decision on the current version of a slot (brief §12, §13).
 *
 * The stage is read from the slot, not chosen by the reviewer: a slot that is
 * `awaiting_lead_qa` can only be judged by a lead of its team (or the PM, who
 * covers every team — §6), and one that is `awaiting_pm_qa` only by a Project
 * Manager. Every round is appended to `qa_reviews`, so the history in §25 is
 * a query, not a reconstruction.
 */
export async function reviewDeliverable(actor: Actor, input: ReviewInput): Promise<ReviewResult> {
  if (!actor.isActive) throw new QaError('Your account is not active.');
  if (!QA_DECISIONS.includes(input.decision)) throw new QaError('Choose a decision.');

  const db = getDb();

  const rows = await db.execute<{
    id: number; project_id: number; name: string; status: string; assignment_id: number | null;
    department_id: number; requires_pm_qa: boolean; version_id: number | null; version_no: number | null;
  }>(sql`
    SELECT d.id, d.project_id, d.name, d.status, d.assignment_id,
           pd.department_id, pd.requires_pm_qa, v.id AS version_id, v.version_no
    FROM deliverables d
    JOIN project_departments pd ON pd.id = d.project_department_id
    LEFT JOIN deliverable_versions v ON v.deliverable_id = d.id AND v.is_current
    WHERE d.id = ${input.deliverableId}
  `);
  const slot = rows[0];
  if (!slot || !(await isProjectVisible(db, actor, Number(slot.project_id)))) {
    throw new QaError('No such deliverable.');
  }
  await assertMonthOpen(db, { projectId: Number(slot.project_id) }, (m) => new QaError(m));

  let stage: QaStage;
  if (slot.status === 'awaiting_lead_qa') stage = 'team_lead';
  else if (slot.status === 'awaiting_pm_qa') stage = 'project_manager';
  else throw new QaError(`${slot.name} is not awaiting review.`);

  if (stage === 'team_lead' && !canReviewDepartment(actor, Number(slot.department_id))) {
    throw new QaError('This team’s work is not yours to review.');
  }
  if (stage === 'project_manager' && !can(actor, 'qa.reviewAsProjectManager')) {
    throw new QaError('Only a Project Manager can sign off at this stage.');
  }
  if (slot.version_id === null) throw new QaError('Nothing has been uploaded to review.');

  const versionId = Number(slot.version_id);
  const versionNo = Number(slot.version_no);
  const projectId = Number(slot.project_id);
  const comments = (input.comments ?? '').trim() || null;
  // Both send the work back; a rejection is the harder verdict, and the
  // executive who starts over is owed the reason (brief §12).
  if (input.decision === 'rejected' && !comments) {
    throw new QaError('Say why the file is rejected, so the executive knows what to redo.');
  }
  const ipAddress = await requestIpAddress();

  return db.transaction(async (tx) => {
    // Lock the slot and re-read its status: two reviewers, or one double
    // click, must not record two decisions on the same round.
    const locked = await tx.execute<{ status: string }>(sql`
      SELECT status FROM deliverables WHERE id = ${slot.id} FOR UPDATE
    `);
    if (locked[0]?.status !== slot.status) {
      throw new QaError('This deliverable was reviewed a moment ago. Refresh to see where it stands.');
    }

    const [{ rounds }] = await tx.execute<{ rounds: number }>(sql`
      SELECT count(*)::int AS rounds FROM qa_reviews
      WHERE deliverable_version_id = ${versionId} AND stage = ${stage}::qa_stage
    `);
    const roundNo = Number(rounds) + 1;

    await tx.execute(sql`
      INSERT INTO qa_reviews (deliverable_version_id, stage, round_no, reviewer_id, decision, comments)
      VALUES (${versionId}, ${stage}::qa_stage, ${roundNo}, ${actor.id}, ${input.decision}::qa_decision, ${comments})
    `);

    let newStatus: ReviewResult['newStatus'];
    let deliveryId: number | null = null;

    if (input.decision !== 'approved') {
      newStatus = 'changes_requested';
    } else if (stage === 'team_lead' && slot.requires_pm_qa) {
      newStatus = 'awaiting_pm_qa';
    } else {
      newStatus = 'approved';
      const [delivery] = await tx.execute<{ id: number }>(sql`
        INSERT INTO deliveries (project_id, deliverable_id, deliverable_version_id, status, approved_at)
        VALUES (${projectId}, ${slot.id}, ${versionId}, 'pending_delivery', now())
        RETURNING id
      `);
      deliveryId = Number(delivery.id);
    }

    await tx.execute(sql`
      UPDATE deliverables SET status = ${newStatus}::deliverable_status WHERE id = ${slot.id}
    `);
    // The decision goes on the record here (brief §25), with the decision
    // and ahead of what it sets off: when it clears the last QA stage, Sales
    // receives the delivery next (§14), and an automatic delivery writes its
    // own line after that, so the timeline reads approval, then Sales
    // received delivery, then any automatic delivery. Where the project ends
    // up is filled in below, once it is known.
    const [logged] = await tx.execute<{ id: number }>(sql`
      INSERT INTO activity_log (actor_id, action, entity_type, entity_id, project_id, metadata, ip_address)
      VALUES (${actor.id}, 'qa.reviewed', 'deliverable', ${Number(slot.id)}, ${projectId},
              ${JSON.stringify({
                stage, decision: input.decision, roundNo, deliverableName: slot.name, versionNo, newStatus, deliveryId,
              })}::jsonb,
              ${ipAddress})
      RETURNING id
    `);
    if (deliveryId !== null) {
      await tx.execute(sql`
        INSERT INTO activity_log (actor_id, action, entity_type, entity_id, project_id, client_id, metadata, ip_address)
        VALUES (${actor.id}, 'delivery.received', 'delivery', ${deliveryId}, ${projectId},
                (SELECT client_id FROM projects WHERE id = ${projectId}),
                ${JSON.stringify({ deliveryId, deliverableId: Number(slot.id), deliverableName: slot.name, versionNo, stage })}::jsonb,
                ${ipAddress})
      `);
    }
    // Automated client delivery (brief §29): straight to the portal when the
    // client has asked for it, instead of waiting in Sales' queue. Decided
    // before the notices go out, so Sales is told what actually happened.
    const autoDelivered = deliveryId !== null
      && await autoDeliverIfEnabled(tx, { deliveryId, deliverableId: Number(slot.id), actorId: actor.id });

    await onQaReviewed(tx, {
      deliverableId: Number(slot.id), versionNo, stage, decision: input.decision, newStatus,
      comments, actorId: actor.id, autoDelivered,
    });

    if (slot.assignment_id !== null) await syncAssignmentStatus(tx, Number(slot.assignment_id));
    const revision = await openRevisionFor(tx, Number(slot.id));
    if (revision) await syncRevisionStatus(tx, revision.id);
    const projectStatus = await syncProjectStatus(tx, projectId);
    await tx.execute(sql`
      UPDATE activity_log SET metadata = metadata || jsonb_build_object('projectStatus', ${projectStatus}::text)
      WHERE id = ${Number(logged.id)}
    `);

    return {
      deliverableId: Number(slot.id),
      deliverableName: slot.name,
      projectId,
      versionId,
      versionNo,
      stage,
      roundNo,
      decision: input.decision,
      newStatus,
      deliveryId,
      autoDelivered,
      projectStatus,
    };
  });
}

export function parseReviewForm(formData: FormData): ReviewInput {
  const decisionRaw = String(formData.get('decision') ?? '');
  const decision = QA_DECISIONS.includes(decisionRaw as QaDecision)
    ? (decisionRaw as QaDecision)
    : ('' as QaDecision);
  const comments = String(formData.get('comments') ?? '').trim();
  return {
    deliverableId: Number(formData.get('deliverableId')),
    decision,
    comments: comments === '' ? null : comments,
  };
}
