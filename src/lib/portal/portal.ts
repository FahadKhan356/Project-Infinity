import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { isProjectMonthClosed } from '@/lib/months/lifecycle';
import { notifyUsers } from '@/lib/notifications/notify';
import { syncProjectStatus } from '@/lib/qa/project-status';

type Db = ReturnType<typeof getDb>;
type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export class PortalError extends Error {}

/**
 * The client portal (brief §29): client login, the automated portal, client
 * approval/rejection and automated delivery.
 *
 * Everything a client sees is read here, and only here, keyed to the client
 * their login belongs to. The rule is narrow on purpose: a client sees their
 * projects' names and progress, and the files that were delivered to them —
 * nothing unfinished, nothing internal, no price, no comment thread, no
 * team. The internal portal is closed to them entirely (requireActor).
 */

/** How a project reads from outside: the client does not need our pipeline. */
export function clientStatus(status: string): string {
  switch (status) {
    case 'new': case 'awaiting_assignment': case 'planned': return 'Scheduled';
    case 'in_progress': case 'qa': case 'revision_required': case 'approved': case 'ready_for_delivery':
      return 'In production';
    case 'delivered': return 'Delivered';
    case 'completed': return 'Completed';
    case 'on_hold': return 'On hold';
    case 'cancelled': return 'Cancelled';
    default: return 'In production';
  }
}

function assertClient(actor: Actor): number {
  if (actor.role !== 'client' || !actor.clientId || !actor.isActive) throw new PortalError('Not found.');
  return actor.clientId;
}

export interface PortalProject {
  id: number;
  projectCode: string;
  title: string;
  period: { year: number; month: number };
  status: string;
  deadline: string | null;
  deliverables: number;
  delivered: number;
  awaitingReview: number;
}

export async function portalProjects(actor: Actor): Promise<PortalProject[]> {
  const clientId = assertClient(actor);
  const rows = await getDb().execute<{
    id: number; project_code: string; title: string; period_year: number; period_month: number;
    status: string; deadline: string | null; total: number; delivered: number; awaiting: number;
  }>(sql`
    SELECT p.id, p.project_code, p.title, cm.period_year, cm.period_month, p.status,
           p.deadline::text AS deadline,
           (SELECT count(*) FROM deliverables d WHERE d.project_id = p.id AND d.status <> 'cancelled')::int AS total,
           (SELECT count(DISTINCT dl.deliverable_id) FROM deliveries dl
             WHERE dl.project_id = p.id AND dl.delivered_at IS NOT NULL)::int AS delivered,
           (SELECT count(*) FROM deliveries dl
             WHERE dl.project_id = p.id AND dl.status = 'delivered' AND dl.client_decision IS NULL)::int AS awaiting
    FROM projects p JOIN client_months cm ON cm.id = p.client_month_id
    WHERE p.client_id = ${clientId}
      AND (p.status <> 'cancelled'
           OR EXISTS (SELECT 1 FROM deliveries dl WHERE dl.project_id = p.id AND dl.delivered_at IS NOT NULL))
    ORDER BY cm.period_year DESC, cm.period_month DESC, p.created_at DESC
  `);
  return rows.map((r) => ({
    id: Number(r.id), projectCode: r.project_code, title: r.title,
    period: { year: Number(r.period_year), month: Number(r.period_month) },
    status: clientStatus(r.status), deadline: r.deadline,
    deliverables: Number(r.total), delivered: Number(r.delivered), awaitingReview: Number(r.awaiting),
  }));
}

export interface PortalFile {
  deliveryId: number;
  versionNo: number;
  filename: string;
  mimeType: string | null;
  sizeBytes: number;
  downloadUrl: string;
  deliveredAt: string;
  status: string;
  decision: 'approved' | 'changes_requested' | null;
  decidedAt: string | null;
  feedback: string | null;
  /** The newest file delivered for this deliverable, awaiting the client's word. */
  canDecide: boolean;
}

export interface PortalDeliverable {
  id: number;
  name: string;
  files: PortalFile[];
}

export interface PortalProjectDetail extends PortalProject {
  objective: string | null;
  monthClosed: boolean;
  items: PortalDeliverable[];
}

export async function portalProject(actor: Actor, projectId: number): Promise<PortalProjectDetail | null> {
  const clientId = assertClient(actor);
  const project = (await portalProjects(actor)).find((p) => p.id === projectId);
  if (!project) return null;
  const db = getDb();
  const [meta] = await db.execute<{ objective: string | null; client_id: number }>(sql`
    SELECT objective, client_id FROM projects WHERE id = ${projectId} AND client_id = ${clientId}
  `);
  if (!meta) return null;

  const rows = await db.execute<{
    deliverable_id: number; name: string; delivery_id: number; version_no: number; filename: string;
    mime_type: string | null; size_bytes: string; storage_key: string; delivered_at: string; status: string;
    client_decision: 'approved' | 'changes_requested' | null; decided_at: string | null; client_feedback: string | null;
    newest: boolean;
  }>(sql`
    SELECT d.id AS deliverable_id, d.name, dl.id AS delivery_id, v.version_no, f.original_filename AS filename,
           f.mime_type, f.size_bytes::text AS size_bytes, f.storage_key::text AS storage_key,
           to_char(dl.delivered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS delivered_at,
           dl.status, dl.client_decision,
           to_char(dl.client_decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS decided_at,
           dl.client_feedback,
           (dl.delivered_at = max(dl.delivered_at) OVER (PARTITION BY d.id)) AS newest
    FROM deliveries dl
    JOIN deliverables d          ON d.id = dl.deliverable_id
    JOIN deliverable_versions v  ON v.id = dl.deliverable_version_id
    JOIN files f                 ON f.id = v.file_id
    WHERE dl.project_id = ${projectId} AND dl.delivered_at IS NOT NULL AND f.deleted_at IS NULL
    ORDER BY d.sequence_no, dl.delivered_at DESC
  `);
  const monthClosed = await isProjectMonthClosed(db, projectId);
  const items = new Map<number, PortalDeliverable>();
  for (const r of rows) {
    const id = Number(r.deliverable_id);
    if (!items.has(id)) items.set(id, { id, name: r.name, files: [] });
    items.get(id)!.files.push({
      deliveryId: Number(r.delivery_id), versionNo: Number(r.version_no), filename: r.filename,
      mimeType: r.mime_type, sizeBytes: Number(r.size_bytes), downloadUrl: `/api/files/${r.storage_key}`,
      deliveredAt: r.delivered_at, status: r.status, decision: r.client_decision, decidedAt: r.decided_at,
      feedback: r.client_feedback,
      canDecide: r.newest === true && r.status === 'delivered' && r.client_decision === null && !monthClosed,
    });
  }
  return { ...project, objective: meta.objective, monthClosed, items: [...items.values()] };
}

/**
 * The client approves a delivered file, or asks for changes (brief §29).
 * Approval completes the delivery. A request for changes is recorded with
 * the client's words and handed to Sales and the Project Manager, who open
 * the revision (§15) — the client does not reach into production.
 */
export async function clientDecide(
  actor: Actor,
  input: { deliveryId: number; decision: 'approved' | 'changes_requested'; feedback?: string | null },
): Promise<{ projectId: number; deliverableName: string }> {
  const clientId = assertClient(actor);
  const feedback = input.feedback?.trim().slice(0, 4000) || null;
  if (input.decision !== 'approved' && input.decision !== 'changes_requested') throw new PortalError('Choose a decision.');
  if (input.decision === 'changes_requested' && !feedback) throw new PortalError('Tell us what should change.');

  const db = getDb();
  return db.transaction(async (tx) => {
    const [row] = await tx.execute<{
      project_id: number; deliverable_id: number; name: string; status: string; decision: string | null;
      newest: boolean; project_code: string; title: string; sales_owner_id: number; project_manager_id: number | null;
    }>(sql`
      SELECT dl.project_id, dl.deliverable_id, d.name, dl.status, dl.client_decision AS decision,
             p.project_code, p.title, p.sales_owner_id, p.project_manager_id,
             (dl.delivered_at = (SELECT max(x.delivered_at) FROM deliveries x WHERE x.deliverable_id = dl.deliverable_id)) AS newest
      FROM deliveries dl
      JOIN deliverables d ON d.id = dl.deliverable_id
      JOIN projects p     ON p.id = dl.project_id
      WHERE dl.id = ${input.deliveryId} AND p.client_id = ${clientId} AND dl.delivered_at IS NOT NULL
      FOR UPDATE OF dl
    `);
    if (!row) throw new PortalError('Not found.');
    const projectId = Number(row.project_id);
    if (await isProjectMonthClosed(tx, projectId)) {
      throw new PortalError('This month has been closed. Please contact your account manager.');
    }
    if (row.status !== 'delivered' || row.decision !== null || row.newest !== true) {
      throw new PortalError('This file has already been reviewed, or a newer version was delivered.');
    }

    await tx.execute(sql`
      UPDATE deliveries
      SET status = ${input.decision === 'approved' ? 'completed' : 'client_feedback_received'}::delivery_status,
          client_decision = ${input.decision}, client_decided_by = ${actor.id}, client_decided_at = now(),
          client_feedback = COALESCE(${feedback}, client_feedback)
      WHERE id = ${input.deliveryId}
    `);
    await syncProjectStatus(tx, projectId);

    const managers = row.project_manager_id !== null
      ? [Number(row.project_manager_id)]
      : (await tx.execute<{ id: number }>(sql`SELECT id FROM users WHERE role = 'project_manager' AND is_active`)).map((u) => Number(u.id));
    await notifyUsers(tx, [Number(row.sales_owner_id), ...managers], {
      type: input.decision === 'approved' ? 'delivery.client_approved' : 'delivery.client_changes',
      title: input.decision === 'approved'
        ? `Client approved ${row.name}: ${row.project_code}`
        : `Client asked for changes to ${row.name}: ${row.project_code}`,
      body: input.decision === 'approved' ? `${actor.fullName} approved it in the portal.` : `${actor.fullName}: ${feedback}`,
      linkPath: input.decision === 'approved' ? `/projects/${projectId}` : '/deliveries',
      entityType: 'project', entityId: projectId,
    }, actor.id);

    return { projectId, deliverableName: row.name };
  });
}

/** May this client login read this file? Only a file delivered to its own client. */
export async function clientMayReadFile(actor: Actor, fileId: number): Promise<boolean> {
  if (actor.role !== 'client' || !actor.clientId || !actor.isActive) return false;
  const rows = await getDb().execute<{ ok: number }>(sql`
    SELECT 1 AS ok
    FROM deliveries dl
    JOIN deliverable_versions v ON v.id = dl.deliverable_version_id
    JOIN projects p ON p.id = dl.project_id
    JOIN files f ON f.id = v.file_id
    WHERE v.file_id = ${fileId} AND dl.delivered_at IS NOT NULL
      AND p.client_id = ${actor.clientId} AND f.deleted_at IS NULL
    LIMIT 1
  `);
  return rows.length > 0;
}

/** Tell a client's portal logins that a file is waiting for them. */
export async function notifyClientOfDelivery(
  db: Executor,
  input: { deliveryId: number; actorId: number | null },
): Promise<void> {
  const [row] = await db.execute<{ client_id: number; project_id: number; name: string; project_code: string; title: string }>(sql`
    SELECT p.client_id, p.id AS project_id, d.name, p.project_code, p.title
    FROM deliveries dl JOIN deliverables d ON d.id = dl.deliverable_id JOIN projects p ON p.id = dl.project_id
    WHERE dl.id = ${input.deliveryId}
  `);
  if (!row) return;
  const logins = await db.execute<{ id: number }>(sql`
    SELECT id FROM users WHERE role = 'client' AND client_id = ${row.client_id} AND is_active
  `);
  await notifyUsers(db, logins.map((u) => Number(u.id)), {
    type: 'portal.delivered',
    title: `New file ready: ${row.name}`,
    body: `${row.title} (${row.project_code}) — open it to review and approve.`,
    linkPath: `/portal/projects/${row.project_id}`,
    entityType: 'project', entityId: Number(row.project_id),
  }, input.actorId ?? undefined);
}

/**
 * Automated client delivery (brief §29). For a client with auto-delivery on,
 * a file that clears final QA is delivered to the portal at once, instead of
 * waiting in Sales' queue. Called inside the QA transaction, and leaves the
 * same `delivery.updated` line in the project's timeline (§25) that Sales
 * delivering by hand would — marked automatic, so the two can be told apart.
 * Returns whether it delivered.
 */
export async function autoDeliverIfEnabled(
  db: Executor,
  input: { deliveryId: number; deliverableId: number; actorId: number },
): Promise<boolean> {
  const updated = await db.execute<{ id: number; project_id: number; client_id: number; name: string }>(sql`
    UPDATE deliveries dl
    SET status = 'delivered', delivered_at = now(), delivered_by = ${input.actorId},
        notes = 'Delivered automatically to the client portal'
    FROM projects p, clients c, deliverables d
    WHERE dl.id = ${input.deliveryId} AND p.id = dl.project_id AND c.id = p.client_id AND d.id = dl.deliverable_id
      AND c.portal_auto_deliver AND dl.status = 'pending_delivery'
      AND EXISTS (SELECT 1 FROM users u WHERE u.role = 'client' AND u.client_id = c.id AND u.is_active)
    RETURNING dl.id, p.id AS project_id, c.id AS client_id, d.name
  `);
  const row = updated[0];
  if (!row) return false;
  await db.execute(sql`UPDATE deliverables SET status = 'delivered' WHERE id = ${input.deliverableId} AND status = 'approved'`);
  // Written on the same executor as the delivery, so the record and the
  // delivery commit or roll back together (recordActivity uses the pool).
  await db.execute(sql`
    INSERT INTO activity_log (actor_id, action, entity_type, entity_id, project_id, client_id, metadata)
    VALUES (${input.actorId}, 'delivery.updated', 'delivery', ${input.deliveryId}, ${Number(row.project_id)},
            ${Number(row.client_id)},
            ${JSON.stringify({ status: 'delivered', deliverableId: input.deliverableId, deliverableName: row.name, automatic: true })}::jsonb)
  `);
  await notifyClientOfDelivery(db, { deliveryId: input.deliveryId, actorId: input.actorId });
  return true;
}

export interface PortalNews {
  id: number;
  title: string;
  body: string | null;
  linkPath: string | null;
  createdAt: string;
}

/** What is new for this login: unread portal notifications, newest first. */
export async function portalNews(actor: Actor): Promise<PortalNews[]> {
  assertClient(actor);
  const rows = await getDb().execute<{ id: number; title: string; body: string | null; link_path: string | null; created_at: string }>(sql`
    SELECT id, title, body, link_path,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
    FROM notifications WHERE user_id = ${actor.id} AND NOT is_read
    ORDER BY created_at DESC LIMIT 20
  `);
  return rows.map((r) => ({ id: Number(r.id), title: r.title, body: r.body, linkPath: r.link_path, createdAt: r.created_at }));
}

/** Opening a project reads its news. */
export async function markProjectNewsRead(actor: Actor, projectId: number): Promise<void> {
  assertClient(actor);
  await getDb().execute(sql`
    UPDATE notifications SET is_read = true, read_at = now()
    WHERE user_id = ${actor.id} AND entity_type = 'project' AND entity_id = ${projectId} AND NOT is_read
  `);
}

export async function portalClientName(actor: Actor): Promise<string> {
  const clientId = assertClient(actor);
  const [row] = await getDb().execute<{ name: string }>(sql`SELECT name FROM clients WHERE id = ${clientId}`);
  return row?.name ?? '';
}
