import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { isProjectVisible } from '@/lib/authz/queries';
import { mayUploadTo } from '@/lib/files/access';
import { isProjectMonthClosed } from '@/lib/months/lifecycle';

/**
 * The shared project workspace (brief §9, §10).
 *
 * Everyone assigned to a project sees the same workspace: every team on it,
 * who is doing what, each deliverable slot with its versions, and the
 * conversation. Pricing is not part of this shape at all — it is a field of
 * the project record, gated separately — so nothing here can leak it.
 */
export interface WorkspaceVersion {
  id: number;
  versionNo: number;
  originalFilename: string;
  mimeType: string | null;
  sizeBytes: number;
  uploadedById: number;
  uploadedBy: string;
  uploadedAt: string;
  notes: string | null;
  isDeleted: boolean;
  downloadUrl: string;
}

export interface WorkspaceReview {
  stage: 'team_lead' | 'project_manager';
  decision: 'approved' | 'changes_requested' | 'rejected';
  comments: string | null;
  reviewer: string;
  reviewedAt: string;
  versionNo: number;
}

export interface WorkspaceDeliverable {
  id: number;
  sequenceNo: number;
  name: string;
  description: string | null;
  status: string;
  dueDate: string | null;
  assignmentId: number | null;
  assigneeId: number | null;
  assignee: string | null;
  /** Whether the current actor may add a version to this slot. */
  canUpload: boolean;
  currentVersion: WorkspaceVersion | null;
  /** Newest first. */
  versions: WorkspaceVersion[];
  /** The most recent QA decision on any version — the feedback §26 sends back. */
  lastReview: WorkspaceReview | null;
  /** The client revision this slot is currently being reworked for, if any (§15–17). */
  openRevision: WorkspaceOpenRevision | null;
}

export interface WorkspaceOpenRevision {
  id: number;
  revisionNo: number;
  title: string;
  clientFeedback: string;
  priority: string;
  deadline: string | null;
  status: string;
}

export interface WorkspaceRevision {
  id: number;
  revisionNo: number;
  title: string;
  status: string;
  priority: string;
  deadline: string | null;
  deliverableNames: string[];
}

export interface WorkspaceAssignment {
  id: number;
  title: string;
  assigneeId: number;
  assignee: string;
  instructions: string | null;
  startDate: string | null;
  endDate: string | null;
  priority: string;
  status: string;
  isMine: boolean;
  total: number;
  approved: number;
  uploaded: number;
}

export interface WorkspaceMember {
  id: number;
  name: string;
}

export interface WorkspaceTeam {
  projectDepartmentId: number;
  departmentId: number;
  department: string;
  teamLeadId: number | null;
  teamLead: string | null;
  plannedDeliverables: number;
  /** Everyone holding an assignment on this team. */
  members: WorkspaceMember[];
  assignments: WorkspaceAssignment[];
  deliverables: WorkspaceDeliverable[];
}

export interface WorkspaceComment {
  id: number;
  authorId: number;
  author: string;
  body: string;
  createdAt: string;
  deliverableId: number | null;
  deliverableName: string | null;
}

export interface Workspace {
  projectId: number;
  /**
   * True when the project's month is archived (brief §36). Nothing here can
   * be changed until it is reopened, so no button offers to.
   */
  monthClosed: boolean;
  teams: WorkspaceTeam[];
  /** Oldest first, so the thread reads top to bottom. */
  comments: WorkspaceComment[];
  /** Every revision on the project, newest first (§9 "view project revisions"). */
  revisions: WorkspaceRevision[];
}

/** ISO-8601 in UTC, so the browser can render it in the viewer's zone. */
const iso = (column: ReturnType<typeof sql.raw>) =>
  sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

/** null when the project is outside the actor's scope — indistinguishable from absent. */
export async function loadWorkspace(actor: Actor, projectId: number): Promise<Workspace | null> {
  const db = getDb();
  if (!(await isProjectVisible(db, actor, projectId))) return null;
  const monthClosed = await isProjectMonthClosed(db, projectId);

  const [teamRows, assignmentRows, deliverableRows, versionRows, reviewRows, commentRows, revisionRows] = await Promise.all([
    db.execute<{
      id: number; department_id: number; department: string;
      team_lead_id: number | null; team_lead: string | null; planned: number;
    }>(sql`
      SELECT pd.id, pd.department_id, d.name AS department, pd.team_lead_id,
             tl.full_name AS team_lead, pd.planned_deliverables AS planned
      FROM project_departments pd
      JOIN departments d ON d.id = pd.department_id
      LEFT JOIN users tl ON tl.id = pd.team_lead_id
      WHERE pd.project_id = ${projectId}
      ORDER BY d.sort_order
    `),
    db.execute<{
      id: number; project_department_id: number; title: string; assignee_id: number; assignee: string;
      instructions: string | null; start_date: string | null; end_date: string | null;
      priority: string; status: string; total: number; approved: number; uploaded: number;
    }>(sql`
      SELECT a.id, a.project_department_id, a.title, a.assignee_id, u.full_name AS assignee,
             a.instructions,
             to_char(a.start_date, 'YYYY-MM-DD') AS start_date,
             to_char(a.end_date, 'YYYY-MM-DD')   AS end_date,
             a.priority, a.status,
             prog.total, prog.approved, prog.started AS uploaded
      FROM assignments a
      JOIN users u ON u.id = a.assignee_id
      JOIN v_assignment_progress prog ON prog.assignment_id = a.id
      WHERE a.project_id = ${projectId}
      ORDER BY a.created_at
    `),
    db.execute<{
      id: number; project_department_id: number; department_id: number; assignment_id: number | null;
      assignee_id: number | null; assignee: string | null; sequence_no: number; name: string;
      description: string | null; status: string; due_date: string | null;
    }>(sql`
      SELECT dv.id, dv.project_department_id, pd.department_id, dv.assignment_id,
             a.assignee_id, u.full_name AS assignee,
             dv.sequence_no, dv.name, dv.description, dv.status,
             to_char(dv.due_date, 'YYYY-MM-DD') AS due_date
      FROM deliverables dv
      JOIN project_departments pd ON pd.id = dv.project_department_id
      LEFT JOIN assignments a ON a.id = dv.assignment_id
      LEFT JOIN users u       ON u.id = a.assignee_id
      WHERE dv.project_id = ${projectId} AND dv.status <> 'cancelled'
      ORDER BY dv.project_department_id, dv.sequence_no
    `),
    db.execute<{
      id: number; deliverable_id: number; version_no: number; is_current: boolean;
      original_filename: string; mime_type: string | null; size_bytes: string;
      storage_key: string; uploaded_by_id: number; uploaded_by: string; uploaded_at: string;
      notes: string | null; deleted: boolean;
    }>(sql`
      SELECT v.id, v.deliverable_id, v.version_no, v.is_current,
             f.original_filename, f.mime_type, f.size_bytes::text AS size_bytes,
             f.storage_key::text AS storage_key,
             v.uploaded_by AS uploaded_by_id, u.full_name AS uploaded_by,
             ${iso(sql.raw('v.uploaded_at'))} AS uploaded_at,
             v.notes, (f.deleted_at IS NOT NULL) AS deleted
      FROM deliverable_versions v
      JOIN deliverables dv ON dv.id = v.deliverable_id
      JOIN files f         ON f.id = v.file_id
      JOIN users u         ON u.id = v.uploaded_by
      WHERE dv.project_id = ${projectId}
      ORDER BY v.deliverable_id, v.version_no DESC
    `),
    db.execute<{
      deliverable_id: number; stage: WorkspaceReview['stage']; decision: WorkspaceReview['decision'];
      comments: string | null; reviewer: string; reviewed_at: string; version_no: number;
    }>(sql`
      SELECT DISTINCT ON (v.deliverable_id)
             v.deliverable_id, q.stage, q.decision, q.comments, u.full_name AS reviewer,
             ${iso(sql.raw('q.reviewed_at'))} AS reviewed_at, v.version_no
      FROM qa_reviews q
      JOIN deliverable_versions v ON v.id = q.deliverable_version_id
      JOIN deliverables dv        ON dv.id = v.deliverable_id
      JOIN users u                ON u.id = q.reviewer_id
      WHERE dv.project_id = ${projectId}
      ORDER BY v.deliverable_id, q.reviewed_at DESC, q.id DESC
    `),
    db.execute<{
      id: number; author_id: number; author: string; body: string; created_at: string;
      deliverable_id: number | null; deliverable_name: string | null;
    }>(sql`
      SELECT c.id, c.author_id, u.full_name AS author, c.body,
             ${iso(sql.raw('c.created_at'))} AS created_at,
             c.deliverable_id, dv.name AS deliverable_name
      FROM comments c
      JOIN users u ON u.id = c.author_id
      LEFT JOIN deliverables dv ON dv.id = c.deliverable_id
      LEFT JOIN assignments a   ON a.id = c.assignment_id
      WHERE c.project_id = ${projectId}
         OR dv.project_id = ${projectId}
         OR a.project_id = ${projectId}
      ORDER BY c.created_at, c.id
    `),
    db.execute<{
      id: number; revision_no: number; title: string; status: string; priority: string;
      deadline: string | null; client_feedback: string; deliverable_ids: number[]; deliverable_names: string[];
    }>(sql`
      SELECT r.id, r.revision_no, r.title, r.status, r.priority, r.client_feedback,
             to_char(r.deadline, 'YYYY-MM-DD') AS deadline,
             COALESCE((SELECT array_agg(rd.deliverable_id ORDER BY rd.deliverable_id)
                         FROM revision_deliverables rd WHERE rd.revision_id = r.id), '{}') AS deliverable_ids,
             COALESCE((SELECT array_agg(d.name ORDER BY d.project_department_id, d.sequence_no)
                         FROM revision_deliverables rd JOIN deliverables d ON d.id = rd.deliverable_id
                        WHERE rd.revision_id = r.id), '{}') AS deliverable_names
      FROM revisions r
      WHERE r.project_id = ${projectId}
      ORDER BY r.revision_no DESC
    `),
  ]);

  // The revision a slot is being reworked for: the newest one touching it
  // that is still open.
  const openBySlot = new Map<number, WorkspaceOpenRevision>();
  for (const r of [...revisionRows].reverse()) {
    if (r.status === 'closed' || r.status === 'cancelled' || r.status === 'delivered') continue;
    for (const slotId of r.deliverable_ids ?? []) {
      openBySlot.set(Number(slotId), {
        id: Number(r.id),
        revisionNo: Number(r.revision_no),
        title: r.title,
        clientFeedback: r.client_feedback,
        priority: r.priority,
        deadline: r.deadline,
        status: r.status,
      });
    }
  }

  const versionsBySlot = new Map<number, WorkspaceVersion[]>();
  for (const v of versionRows) {
    const list = versionsBySlot.get(Number(v.deliverable_id)) ?? [];
    list.push({
      id: Number(v.id),
      versionNo: Number(v.version_no),
      originalFilename: v.original_filename,
      mimeType: v.mime_type,
      sizeBytes: Number(v.size_bytes),
      uploadedById: Number(v.uploaded_by_id),
      uploadedBy: v.uploaded_by,
      uploadedAt: v.uploaded_at,
      notes: v.notes,
      isDeleted: v.deleted === true,
      downloadUrl: `/api/files/${v.storage_key}`,
    });
    versionsBySlot.set(Number(v.deliverable_id), list);
  }

  const reviewBySlot = new Map<number, WorkspaceReview>();
  for (const r of reviewRows) {
    reviewBySlot.set(Number(r.deliverable_id), {
      stage: r.stage,
      decision: r.decision,
      comments: r.comments,
      reviewer: r.reviewer,
      reviewedAt: r.reviewed_at,
      versionNo: Number(r.version_no),
    });
  }

  const teams: WorkspaceTeam[] = teamRows.map((t) => {
    const teamId = Number(t.id);
    const departmentId = Number(t.department_id);

    const assignments = assignmentRows
      .filter((a) => Number(a.project_department_id) === teamId)
      .map((a) => ({
        id: Number(a.id),
        title: a.title,
        assigneeId: Number(a.assignee_id),
        assignee: a.assignee,
        instructions: a.instructions,
        startDate: a.start_date,
        endDate: a.end_date,
        priority: a.priority,
        status: a.status,
        isMine: Number(a.assignee_id) === actor.id,
        total: Number(a.total),
        approved: Number(a.approved),
        uploaded: Number(a.uploaded),
      }));

    const members = new Map<number, WorkspaceMember>();
    for (const a of assignments) members.set(a.assigneeId, { id: a.assigneeId, name: a.assignee });

    const deliverables = deliverableRows
      .filter((d) => Number(d.project_department_id) === teamId)
      .map((d) => {
        const versions = versionsBySlot.get(Number(d.id)) ?? [];
        const assigneeId = d.assignee_id === null ? null : Number(d.assignee_id);
        return {
          id: Number(d.id),
          sequenceNo: Number(d.sequence_no),
          name: d.name,
          description: d.description,
          status: d.status,
          dueDate: d.due_date,
          assignmentId: d.assignment_id === null ? null : Number(d.assignment_id),
          assigneeId,
          assignee: d.assignee,
          canUpload: !monthClosed && mayUploadTo(actor, { assigneeId, departmentId }),
          currentVersion: versions[0] ?? null,
          versions,
          lastReview: reviewBySlot.get(Number(d.id)) ?? null,
          openRevision: openBySlot.get(Number(d.id)) ?? null,
        };
      });

    return {
      projectDepartmentId: teamId,
      departmentId,
      department: t.department,
      teamLeadId: t.team_lead_id === null ? null : Number(t.team_lead_id),
      teamLead: t.team_lead,
      plannedDeliverables: Number(t.planned),
      members: [...members.values()].sort((a, b) => a.name.localeCompare(b.name)),
      assignments,
      deliverables,
    };
  });

  return {
    projectId,
    monthClosed,
    teams,
    comments: commentRows.map((c) => ({
      id: Number(c.id),
      authorId: Number(c.author_id),
      author: c.author,
      body: c.body,
      createdAt: c.created_at,
      deliverableId: c.deliverable_id === null ? null : Number(c.deliverable_id),
      deliverableName: c.deliverable_name,
    })),
    revisions: revisionRows.map((r) => ({
      id: Number(r.id),
      revisionNo: Number(r.revision_no),
      title: r.title,
      status: r.status,
      priority: r.priority,
      deadline: r.deadline,
      deliverableNames: r.deliverable_names ?? [],
    })),
  };
}
