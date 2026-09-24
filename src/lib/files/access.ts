import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { can } from '@/lib/authz';
import { isProjectVisible } from '@/lib/authz/queries';
import { MONTH_CLOSED_MESSAGE, isProjectMonthClosed } from '@/lib/months/lifecycle';

export interface FileContext {
  fileId: number;
  storageKey: string;
  storagePath: string;
  originalFilename: string;
  mimeType: string | null;
  sizeBytes: number;
  isDeleted: boolean;
  /** The project this file belongs to — the unit access is decided on. */
  projectId: number | null;
  deliverableId: number | null;
}

/**
 * Resolves a file to the project it belongs to, whether it arrived as a
 * deliverable version or as an attachment on a project, assignment, revision
 * or comment.
 */
export async function loadFileContext(storageKey: string): Promise<FileContext | null> {
  const rows = await getDb().execute<{
    file_id: number;
    storage_key: string;
    storage_path: string;
    original_filename: string;
    mime_type: string | null;
    size_bytes: string;
    deleted_at: Date | null;
    project_id: number | null;
    deliverable_id: number | null;
  }>(sql`
    SELECT
      f.id                AS file_id,
      f.storage_key::text AS storage_key,
      f.storage_path,
      f.original_filename,
      f.mime_type,
      f.size_bytes::text  AS size_bytes,
      f.deleted_at,
      COALESCE(d.project_id, a.project_id, asg.project_id, r.project_id, cd.project_id) AS project_id,
      dv.deliverable_id
    FROM files f
    LEFT JOIN deliverable_versions dv ON dv.file_id = f.id
    LEFT JOIN deliverables d          ON d.id = dv.deliverable_id
    LEFT JOIN attachments a           ON a.file_id = f.id
    LEFT JOIN assignments asg         ON asg.id = a.assignment_id
    LEFT JOIN revisions r             ON r.id = a.revision_id
    LEFT JOIN comments c              ON c.id = a.comment_id
    LEFT JOIN deliverables cd_d       ON cd_d.id = c.deliverable_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(c.project_id, cd_d.project_id) AS project_id
    ) cd ON true
    WHERE f.storage_key = ${storageKey}::uuid
    LIMIT 1
  `);

  const row = rows[0];
  if (!row) return null;

  return {
    fileId: Number(row.file_id),
    storageKey: row.storage_key,
    storagePath: row.storage_path,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    isDeleted: row.deleted_at !== null,
    projectId: row.project_id === null ? null : Number(row.project_id),
    deliverableId: row.deliverable_id === null ? null : Number(row.deliverable_id),
  };
}

export type FileDecision =
  | { allowed: true }
  | { allowed: false; reason: 'deleted' | 'orphaned' | 'out_of_scope' };

/**
 * A file is readable exactly when its project is. That is what makes the
 * shared workspace work (brief §10): a Video executive assigned to a project
 * can open the Design files on that same project, because both hang off a
 * project they can see — and it is also what stops them reaching a project
 * they hold no assignment on.
 */
export async function decideFileAccess(actor: Actor, file: FileContext): Promise<FileDecision> {
  if (file.isDeleted && !can(actor, 'files.delete')) {
    return { allowed: false, reason: 'deleted' };
  }
  if (file.projectId === null) {
    // A file with no reachable parent is not readable by anyone but an
    // administrator; it usually means a failed or partial cleanup.
    return can(actor, 'files.delete')
      ? { allowed: true }
      : { allowed: false, reason: 'orphaned' };
  }
  const visible = await isProjectVisible(getDb(), actor, file.projectId);
  return visible ? { allowed: true } : { allowed: false, reason: 'out_of_scope' };
}

/**
 * Who may add bytes to a deliverable slot.
 *
 * Seeing a project is not enough to upload into it — otherwise any member of
 * a shared workspace could file work against another department's slot. The
 * uploader must be the assignee, a lead of that slot's department, or hold
 * portal-wide project access (PM and management).
 */
export async function canUploadToDeliverable(
  actor: Actor,
  deliverableId: number,
): Promise<{ allowed: boolean; projectId?: number; reason?: string }> {
  const rows = await getDb().execute<{
    project_id: number;
    department_id: number;
    assignee_id: number | null;
  }>(sql`
    SELECT d.project_id, pd.department_id, a.assignee_id
    FROM deliverables d
    JOIN project_departments pd ON pd.id = d.project_department_id
    LEFT JOIN assignments a     ON a.id = d.assignment_id
    WHERE d.id = ${deliverableId}
    LIMIT 1
  `);

  const row = rows[0];
  if (!row) return { allowed: false, reason: 'No such deliverable.' };

  const projectId = Number(row.project_id);
  if (!(await isProjectVisible(getDb(), actor, projectId))) {
    return { allowed: false, reason: 'No such deliverable.' };
  }
  if (await isProjectMonthClosed(getDb(), projectId)) {
    return { allowed: false, projectId, reason: MONTH_CLOSED_MESSAGE };
  }

  const slot = {
    assigneeId: row.assignee_id === null ? null : Number(row.assignee_id),
    departmentId: Number(row.department_id),
  };
  if (mayUploadTo(actor, slot)) return { allowed: true, projectId };
  return { allowed: false, reason: 'This deliverable is not assigned to you.' };
}

/**
 * The upload rule itself, on a slot already known to be visible. Kept pure so
 * the workspace can decide it for forty slots without forty queries — and so
 * the queue and the page can never disagree about who holds the button.
 */
export function mayUploadTo(
  actor: Actor,
  slot: { assigneeId: number | null; departmentId: number },
): boolean {
  if (!actor.isActive) return false;
  const isAssignee = slot.assigneeId !== null && slot.assigneeId === actor.id;
  const leadsDepartment = actor.leadDepartmentIds.includes(slot.departmentId);
  return isAssignee || leadsDepartment || can(actor, 'projects.viewAll');
}

/** Attachments are looser: anyone who can see the project may attach to it. */
export async function canAttachToProject(
  actor: Actor,
  projectId: number,
): Promise<{ allowed: boolean; reason?: string }> {
  const visible = await isProjectVisible(getDb(), actor, projectId);
  if (!visible) return { allowed: false, reason: 'No such project.' };
  if (await isProjectMonthClosed(getDb(), projectId)) return { allowed: false, reason: MONTH_CLOSED_MESSAGE };
  return { allowed: true };
}
