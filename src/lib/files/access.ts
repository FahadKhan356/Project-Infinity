import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { can, revisionScope } from '@/lib/authz';
import { isProjectVisible } from '@/lib/authz/queries';
import { MONTH_CLOSED_MESSAGE, isProjectMonthClosed } from '@/lib/months/lifecycle';
import { workBlockedReason } from '@/lib/projects/status';

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
  /** Its AKT-YYYY-NNNN, which the download carries in the filename (§24). */
  projectCode: string | null;
  deliverableId: number | null;
  /** Set for a deliverable version; attachments have none. */
  versionNo: number | null;
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
    project_code: string | null;
    deliverable_id: number | null;
    version_no: number | null;
  }>(sql`
    SELECT
      f.id                AS file_id,
      f.storage_key::text AS storage_key,
      f.storage_path,
      f.original_filename,
      f.mime_type,
      f.size_bytes::text  AS size_bytes,
      f.deleted_at,
      p.id                AS project_id,
      p.project_code,
      dv.deliverable_id,
      dv.version_no
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
    LEFT JOIN projects p
      ON p.id = COALESCE(d.project_id, a.project_id, asg.project_id, r.project_id, cd.project_id)
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
    projectCode: row.project_code,
    deliverableId: row.deliverable_id === null ? null : Number(row.deliverable_id),
    versionNo: row.version_no === null ? null : Number(row.version_no),
  };
}

export type FileDecision =
  | { allowed: true }
  | { allowed: false; reason: 'deleted' | 'orphaned' | 'out_of_scope' | 'download_withheld' };

/**
 * What the actor wants with the bytes: to see them in place (`read`), to
 * keep a copy (`download`, brief §43), or to delete the file (`write`).
 */
export type FileIntent = 'read' | 'download' | 'write';

/**
 * A file is readable exactly when its project is. That is what makes the
 * shared workspace work (brief §10): a Video executive assigned to a project
 * can open the Design files on that same project, because both hang off a
 * project they can see — and it is also what stops them reaching a project
 * they hold no assignment on.
 *
 * A project shared with a Sales rep to view (§23) opens its files to read
 * only: `intent: 'write'` — deleting — counts the projects that are theirs,
 * so a share never widens what a rep changes (authz/scope ScopeOptions).
 *
 * Keeping a copy is a right of its own (§43): `intent: 'download'` asks
 * the same visibility question as a read and then, last, whether the
 * account holds `files.download`. Last, so an account without it still
 * learns nothing about files it cannot see — the answer for those stays
 * `out_of_scope`, and the route keeps answering 404.
 */
export async function decideFileAccess(
  actor: Actor,
  file: FileContext,
  intent: FileIntent = 'read',
): Promise<FileDecision> {
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
  const visible = await isProjectVisible(getDb(), actor, file.projectId, intent === 'write' ? {} : { shared: true });
  if (!visible) return { allowed: false, reason: 'out_of_scope' };
  if (intent === 'download' && !can(actor, 'files.download')) {
    return { allowed: false, reason: 'download_withheld' };
  }
  return { allowed: true };
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
    project_status: string;
    slot_status: string;
  }>(sql`
    SELECT d.project_id, pd.department_id, a.assignee_id, p.status AS project_status, d.status AS slot_status
    FROM deliverables d
    JOIN projects p             ON p.id = d.project_id
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
  const blocked = workBlockedReason(row.project_status);
  if (blocked) return { allowed: false, projectId, reason: blocked };
  const slotBlocked = uploadBlockedReason(row.slot_status);
  if (slotBlocked) return { allowed: false, projectId, reason: slotBlocked };

  const slot = {
    assigneeId: row.assignee_id === null ? null : Number(row.assignee_id),
    departmentId: Number(row.department_id),
  };
  if (mayUploadTo(actor, slot)) return { allowed: true, projectId };
  return { allowed: false, reason: 'This deliverable is not assigned to you.' };
}

/**
 * Whether a slot's own state takes a new version. Once a file has passed the
 * Team Lead it belongs to QA and delivery: replacing it silently would erase
 * the lead's sign-off (awaiting_pm_qa) or leave a stale delivery row in the
 * Sales queue (approved, delivered). Those come back through a revision
 * (§15), which returns the slot to changes_requested. Pure, like mayUploadTo,
 * so the workspace button and the upload API give the same answer.
 */
export function uploadBlockedReason(slotStatus: string): string | null {
  switch (slotStatus) {
    case 'awaiting_pm_qa':
      return 'This deliverable is with the Project Manager for review. Wait for the decision before uploading again.';
    case 'approved':
    case 'delivered':
      return 'This deliverable has been approved. Open a revision to replace it.';
    case 'cancelled':
      return 'This deliverable was cancelled.';
    default:
      return null;
  }
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

/** References on an assignment: for whoever does the work or plans it (§7). Pure, like mayUploadTo. */
export function mayAttachToAssignment(
  actor: Actor,
  assignment: { assigneeId: number; departmentId: number },
): boolean {
  if (!actor.isActive) return false;
  return assignment.assigneeId === actor.id
    || actor.leadDepartmentIds.includes(assignment.departmentId)
    || can(actor, 'planning.viewAllDepartments');
}

/**
 * The page-side half of canAttachToProject, pure like mayUploadTo: the
 * project page and the workspace offer "Attach files" only where the upload
 * route would take the file — theirs to work on (a share reads, §23), in an
 * open month, and not held, cancelled or completed (§18).
 */
export function mayAttachToProject(
  project: { owned: boolean; monthOpen: boolean; status: string },
): boolean {
  return project.owned && project.monthOpen && workBlockedReason(project.status) === null;
}

/**
 * Attachments are looser than deliverables: anyone who can see the project may
 * attach to it (§3). Pinning one to an assignment is for the people who plan
 * or do that work (§7); to a revision, for anyone the revision is visible to
 * (§15, §16) — the Design lead cannot add references to the video note.
 * A project on hold, cancelled or completed takes no new references either
 * (§18), as with deliverables: mayAttachToProject hides the button, this is
 * the rule.
 *
 * The PO document (`kind: 'po'`, §3) is stricter: it hangs off the project
 * itself, never an assignment or revision, and is filed by the people who
 * own the order — Sales or the Project Manager (`projects.edit`) — not by
 * an executive who can merely see the project. Reading it follows the same
 * project rule as every file (decideFileAccess).
 */
export async function canAttachToProject(
  actor: Actor,
  projectId: number,
  parent: { assignmentId?: number; revisionId?: number; kind?: 'po' | 'reference' } = {},
): Promise<{ allowed: boolean; reason?: string }> {
  const db = getDb();
  const visible = await isProjectVisible(db, actor, projectId);
  if (!visible) return { allowed: false, reason: 'No such project.' };
  if (await isProjectMonthClosed(db, projectId)) return { allowed: false, reason: MONTH_CLOSED_MESSAGE };
  const [project] = await db.execute<{ status: string }>(sql`
    SELECT status FROM projects WHERE id = ${projectId}
  `);
  const blocked = workBlockedReason(project?.status ?? '');
  if (blocked) return { allowed: false, reason: blocked };

  if (parent.kind === 'po') {
    if (parent.assignmentId !== undefined || parent.revisionId !== undefined) {
      return { allowed: false, reason: 'A PO document belongs to the project, not to an assignment or revision.' };
    }
    if (!can(actor, 'projects.edit')) {
      return { allowed: false, reason: 'Only Sales or the Project Manager may file the PO document.' };
    }
  }

  if (parent.assignmentId !== undefined && parent.revisionId !== undefined) {
    return { allowed: false, reason: 'Attach to an assignment or a revision, not both.' };
  }
  if (parent.assignmentId !== undefined) {
    const [a] = await db.execute<{ assignee_id: number; department_id: number }>(sql`
      SELECT a.assignee_id, pd.department_id FROM assignments a
      JOIN project_departments pd ON pd.id = a.project_department_id
      WHERE a.id = ${parent.assignmentId} AND a.project_id = ${projectId}
    `);
    if (!a) return { allowed: false, reason: 'No such assignment.' };
    const mine = mayAttachToAssignment(actor, {
      assigneeId: Number(a.assignee_id), departmentId: Number(a.department_id),
    });
    if (!mine) return { allowed: false, reason: 'That assignment is not yours to add references to.' };
  }
  if (parent.revisionId !== undefined) {
    const [r] = await db.execute<{ ok: number }>(sql`
      SELECT 1 AS ok FROM revisions
      WHERE revisions.id = ${parent.revisionId} AND revisions.project_id = ${projectId}
        AND ${revisionScope(actor)}
    `);
    if (!r) return { allowed: false, reason: 'No such revision.' };
  }
  return { allowed: true };
}
