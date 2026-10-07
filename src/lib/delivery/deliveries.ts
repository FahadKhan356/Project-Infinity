import 'server-only';
import { notifyClientOfDelivery } from '@/lib/portal/portal';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { requestIpAddress } from '@/lib/auth/audit';
import type { Actor } from '@/lib/authz';
import { can, projectScope } from '@/lib/authz';
import { isProjectVisible } from '@/lib/authz/queries';
import { assertMonthOpen } from '@/lib/months/lifecycle';
import { syncProjectStatus } from '@/lib/qa/project-status';
import { openRevisionFor, syncRevisionStatus } from '@/lib/revisions/status';

export class DeliveryError extends Error {}

/** Brief §14, verbatim. */
export type DeliveryStatus =
  | 'pending_delivery' | 'delivered' | 'client_feedback_received' | 'revision_required' | 'completed';

export const DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  'pending_delivery', 'delivered', 'client_feedback_received', 'revision_required', 'completed',
];

/**
 * Where a delivery may go from where it is. Sales works the list top to
 * bottom; a file cannot be "completed" before it has been sent. "Revision
 * required" is neither entered nor left by hand: opening a revision on the
 * file (§15) sets it, so the status always has the revision behind it that
 * the teams work, and the revision decides what follows — the reworked file
 * arrives as a new delivery once it clears QA (§17), or ending the revision
 * before one does (closed, cancelled, or withdrawn with its project) gives
 * this one back its delivered state. Marking the old file delivered again
 * would contradict the open revision and tell the client about a file that
 * is being replaced.
 */
export const DELIVERY_TRANSITIONS: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  pending_delivery: ['delivered'],
  delivered: ['client_feedback_received', 'completed'],
  client_feedback_received: ['completed'],
  revision_required: [],
  completed: [],
};

export interface DeliveryRow {
  deliveryId: number;
  status: DeliveryStatus;
  projectId: number;
  projectCode: string;
  projectTitle: string;
  clientName: string;
  department: string;
  deliverableId: number;
  deliverableName: string;
  versionNo: number;
  originalFilename: string;
  sizeBytes: number;
  downloadUrl: string;
  /**
   * Every QA sign-off on the delivered version, oldest first: the Team Lead's
   * and, where the team needs it, the Project Manager's (brief §12–§14).
   */
  qaApprovals: QaApproval[];
  approvedAt: string | null;
  deliveredAt: string | null;
  deliveredBy: string | null;
  clientFeedback: string | null;
  notes: string | null;
  /** Set when the client decided in the portal (brief §29). */
  clientDecision: { decision: 'approved' | 'changes_requested'; by: string; at: string } | null;
  /**
   * Whether this person may move the delivery along. False for a read-only
   * viewer: the Project Manager (§5, §23), or a rep the project is shared with.
   */
  canUpdate: boolean;
  /** Whether they may open a revision on the file (§16) — not on a shared project. */
  canRevise: boolean;
}

export interface QaApproval {
  stage: 'team_lead' | 'project_manager';
  reviewer: string;
  comments: string | null;
  /** ISO-8601, UTC. */
  at: string;
}

const iso = (column: SQL) =>
  sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
type SQL = ReturnType<typeof sql>;

/**
 * Sales → Deliveries (brief §14): everything that has cleared QA, for the
 * projects this person can see. Completed rows drop out unless asked for.
 * The Project Manager reads the same list (§5, §23); only Sales marks it.
 * A project shared with a rep is listed for reading: its rows are neither
 * theirs to mark nor to revise, so the flags use the scope without shares.
 */
export async function deliveryQueue(
  actor: Actor,
  options: { includeCompleted?: boolean } = {},
): Promise<DeliveryRow[]> {
  if (!can(actor, 'delivery.view')) return [];

  const rows = await getDb().execute<{
    id: number; status: DeliveryStatus; project_id: number; project_code: string; project_title: string;
    client_name: string; department: string; deliverable_id: number; deliverable_name: string;
    version_no: number; original_filename: string; size_bytes: string; storage_key: string;
    qa_approvals: QaApproval[]; approved_at: string | null; delivered_at: string | null;
    delivered_by: string | null; client_feedback: string | null; notes: string | null;
    client_decision: 'approved' | 'changes_requested' | null; client_decided_by: string | null; client_decided_at: string | null;
    can_update: boolean; can_revise: boolean;
  }>(sql`
    SELECT dl.id, dl.status, p.id AS project_id, p.project_code, p.title AS project_title,
           c.name AS client_name, dept.name AS department,
           d.id AS deliverable_id, d.name AS deliverable_name,
           v.version_no, f.original_filename, f.size_bytes::text AS size_bytes,
           f.storage_key::text AS storage_key,
           COALESCE((
             SELECT json_agg(json_build_object(
                      'stage', q.stage, 'reviewer', qu.full_name, 'comments', q.comments,
                      'at', ${iso(sql`q.reviewed_at`)}) ORDER BY q.reviewed_at, q.id)
             FROM qa_reviews q JOIN users qu ON qu.id = q.reviewer_id
             WHERE q.deliverable_version_id = dl.deliverable_version_id AND q.decision = 'approved'
           ), '[]'::json) AS qa_approvals,
           ${iso(sql`dl.approved_at`)}  AS approved_at,
           ${iso(sql`dl.delivered_at`)} AS delivered_at,
           db_u.full_name AS delivered_by, dl.client_feedback, dl.notes,
           dl.client_decision, (SELECT full_name FROM users WHERE id = dl.client_decided_by) AS client_decided_by,
           ${iso(sql`dl.client_decided_at`)} AS client_decided_at,
           ${can(actor, 'delivery.manage') ? projectScope(actor, 'p') : sql`false`} AS can_update,
           ${can(actor, 'revisions.create') ? projectScope(actor, 'p') : sql`false`} AS can_revise
    FROM deliveries dl
    JOIN projects p             ON p.id = dl.project_id
    JOIN clients c              ON c.id = p.client_id
    JOIN deliverables d         ON d.id = dl.deliverable_id
    JOIN project_departments pd ON pd.id = d.project_department_id
    JOIN departments dept       ON dept.id = pd.department_id
    JOIN deliverable_versions v ON v.id = dl.deliverable_version_id
    JOIN files f                ON f.id = v.file_id
    LEFT JOIN users db_u        ON db_u.id = dl.delivered_by
    WHERE ${projectScope(actor, 'p', { shared: true })}
      AND ${options.includeCompleted ? sql`true` : sql`dl.status <> 'completed'`}
      -- a slot re-approved after a revision has a newer delivery; the old one is history
      AND dl.id = (SELECT max(id) FROM deliveries WHERE deliverable_id = dl.deliverable_id)
    ORDER BY
      CASE dl.status WHEN 'pending_delivery' THEN 0 WHEN 'revision_required' THEN 1
                     WHEN 'client_feedback_received' THEN 2 WHEN 'delivered' THEN 3 ELSE 4 END,
      dl.approved_at, dl.id
  `);

  return rows.map((r) => ({
    deliveryId: Number(r.id),
    status: r.status,
    projectId: Number(r.project_id),
    projectCode: r.project_code,
    projectTitle: r.project_title,
    clientName: r.client_name,
    department: r.department,
    deliverableId: Number(r.deliverable_id),
    deliverableName: r.deliverable_name,
    versionNo: Number(r.version_no),
    originalFilename: r.original_filename,
    sizeBytes: Number(r.size_bytes),
    downloadUrl: `/api/files/${r.storage_key}`,
    qaApprovals: (r.qa_approvals ?? []).map((a) => ({
      stage: a.stage, reviewer: a.reviewer, comments: a.comments, at: a.at,
    })),
    approvedAt: r.approved_at,
    deliveredAt: r.delivered_at,
    deliveredBy: r.delivered_by,
    clientFeedback: r.client_feedback,
    notes: r.notes,
    clientDecision: r.client_decision && r.client_decided_at
      ? { decision: r.client_decision, by: r.client_decided_by ?? 'the client', at: r.client_decided_at }
      : null,
    canUpdate: r.can_update === true,
    canRevise: r.can_revise === true,
  }));
}

export interface DeliveryUpdate {
  deliveryId: number;
  status: DeliveryStatus;
  notes?: string | null;
  clientFeedback?: string | null;
}

export interface DeliveryUpdateResult {
  deliveryId: number;
  projectId: number;
  deliverableId: number;
  deliverableName: string;
  status: DeliveryStatus;
  projectStatus: string | null;
}

/**
 * Sales moves a delivery along (brief §14). The portal does not send the file
 * anywhere; it records that a person did.
 */
export async function updateDelivery(actor: Actor, input: DeliveryUpdate): Promise<DeliveryUpdateResult> {
  if (!can(actor, 'delivery.manage')) {
    throw new DeliveryError('You are not permitted to manage deliveries.');
  }
  if (!DELIVERY_STATUSES.includes(input.status)) throw new DeliveryError('Choose a delivery status.');

  const db = getDb();
  const rows = await db.execute<{
    id: number; project_id: number; deliverable_id: number; deliverable_name: string; status: DeliveryStatus;
  }>(sql`
    SELECT dl.id, dl.project_id, dl.deliverable_id, d.name AS deliverable_name, dl.status
    FROM deliveries dl JOIN deliverables d ON d.id = dl.deliverable_id
    WHERE dl.id = ${input.deliveryId}
  `);
  const delivery = rows[0];
  if (!delivery || !(await isProjectVisible(db, actor, Number(delivery.project_id), { shared: true }))) {
    throw new DeliveryError('No such delivery.');
  }
  // A project shared with a rep is theirs to read, not to deliver (§23).
  if (!(await isProjectVisible(db, actor, Number(delivery.project_id)))) {
    throw new DeliveryError('This project is shared with you to view; its own Sales rep records delivery.');
  }
  await assertMonthOpen(db, { projectId: Number(delivery.project_id) }, (m) => new DeliveryError(m));

  if (!DELIVERY_TRANSITIONS[delivery.status].includes(input.status)) {
    throw new DeliveryError(
      `A delivery cannot go from ${label(delivery.status)} to ${label(input.status)}.`,
    );
  }

  const projectId = Number(delivery.project_id);
  const deliverableId = Number(delivery.deliverable_id);
  const ipAddress = await requestIpAddress();

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE deliveries
      SET status = ${input.status}::delivery_status,
          notes = ${input.notes === undefined ? sql`notes` : (input.notes ?? null)},
          client_feedback = ${input.clientFeedback === undefined ? sql`client_feedback` : (input.clientFeedback ?? null)},
          delivered_at = CASE WHEN ${input.status} = 'delivered' THEN now() ELSE delivered_at END,
          delivered_by = CASE WHEN ${input.status} = 'delivered' THEN ${actor.id} ELSE delivered_by END
      WHERE id = ${input.deliveryId}
    `);

    if (input.status === 'delivered') {
      await tx.execute(sql`
        UPDATE deliverables SET status = 'delivered' WHERE id = ${deliverableId} AND status = 'approved'
      `);
      const revision = await openRevisionFor(tx, deliverableId);
      if (revision) await syncRevisionStatus(tx, revision.id);
      // The client's portal logins see it now, and are told (brief §29).
      await notifyClientOfDelivery(tx, { deliveryId: Number(delivery.id), actorId: actor.id });
    }

    const projectStatus = await syncProjectStatus(tx, projectId);

    // The change goes on the record here (brief §25), written on the same
    // executor as the delivery so the record and the change commit or roll
    // back together — whoever calls the library, not only the form.
    await tx.execute(sql`
      INSERT INTO activity_log (actor_id, action, entity_type, entity_id, project_id, client_id, metadata, ip_address)
      VALUES (${actor.id}, 'delivery.updated', 'delivery', ${Number(delivery.id)}, ${projectId},
              (SELECT client_id FROM projects WHERE id = ${projectId}),
              ${JSON.stringify({
                status: input.status, deliverableId, deliverableName: delivery.deliverable_name, projectStatus,
              })}::jsonb,
              ${ipAddress})
    `);

    return {
      deliveryId: Number(delivery.id),
      projectId,
      deliverableId,
      deliverableName: delivery.deliverable_name,
      status: input.status,
      projectStatus,
    };
  });
}

function label(status: string): string {
  return status.replace(/_/g, ' ');
}

export function parseDeliveryForm(formData: FormData): DeliveryUpdate {
  const text = (key: string): string | null | undefined => {
    if (!formData.has(key)) return undefined;
    const value = String(formData.get(key) ?? '').trim();
    return value === '' ? null : value;
  };
  return {
    deliveryId: Number(formData.get('deliveryId')),
    status: String(formData.get('status') ?? '') as DeliveryStatus,
    notes: text('notes'),
    clientFeedback: text('clientFeedback'),
  };
}
