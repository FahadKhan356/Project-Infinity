import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { revisionScope } from '@/lib/authz';

export interface RevisionDeliverable {
  id: number;
  name: string;
  status: string;
  department: string;
  departmentId: number;
  projectDepartmentId: number;
  assigneeId: number | null;
  assignee: string | null;
  /** The current version on the slot, whether or not it answers this revision. */
  currentVersionNo: number | null;
}

export interface RevisionSummary {
  id: number;
  revisionNo: number;
  title: string;
  status: string;
  priority: string;
  deadline: string | null;
  clientFeedback: string;
  createdBy: string;
  createdAt: string;
  projectId: number;
  projectCode: string;
  projectTitle: string;
  /** Where the project stands (§18): held or cancelled, it takes no references or hand-offs. */
  projectStatus: string;
  clientName: string;
  deliverables: RevisionDeliverable[];
}

export interface RevisionVersion {
  id: number;
  deliverableId: number;
  deliverableName: string;
  versionNo: number;
  originalFilename: string;
  downloadUrl: string;
  uploadedBy: string;
  uploadedAt: string;
  /** The slot's current QA state when this is the current version. */
  isCurrent: boolean;
  /** Every QA decision on this version, oldest first (brief §19: "particularly important for revisions"). */
  reviews: RevisionVersionReview[];
}

export interface RevisionVersionReview {
  stage: 'team_lead' | 'project_manager';
  decision: 'approved' | 'changes_requested' | 'rejected';
  reviewer: string;
  comments: string | null;
  /** ISO-8601, UTC. */
  at: string;
}

export interface RevisionComment {
  id: number;
  authorId: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface RevisionDetail extends RevisionSummary {
  details: string | null;
  closedAt: string | null;
  /** Versions uploaded in answer to this revision, newest first. */
  versions: RevisionVersion[];
  /** Oldest first. */
  comments: RevisionComment[];
}

const iso = (column: ReturnType<typeof sql.raw>) =>
  sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

const summaryColumns = sql`
  r.id, r.revision_no, r.title, r.status, r.priority, r.client_feedback,
  to_char(r.deadline, 'YYYY-MM-DD') AS deadline,
  ${iso(sql.raw('r.created_at'))} AS created_at, cu.full_name AS created_by,
  p.id AS project_id, p.project_code, p.title AS project_title, p.status AS project_status,
  c.name AS client_name,
  COALESCE((
    SELECT json_agg(json_build_object(
             'id', d.id, 'name', d.name, 'status', d.status,
             'department', dept.name, 'departmentId', pd.department_id,
             'projectDepartmentId', pd.id,
             'assigneeId', a.assignee_id, 'assignee', au.full_name,
             'currentVersionNo', (SELECT v.version_no FROM deliverable_versions v
                                   WHERE v.deliverable_id = d.id AND v.is_current))
           ORDER BY pd.id, d.sequence_no)
    FROM revision_deliverables rd
    JOIN deliverables d          ON d.id = rd.deliverable_id
    JOIN project_departments pd  ON pd.id = d.project_department_id
    JOIN departments dept        ON dept.id = pd.department_id
    LEFT JOIN assignments a      ON a.id = d.assignment_id
    LEFT JOIN users au           ON au.id = a.assignee_id
    WHERE rd.revision_id = r.id
  ), '[]'::json) AS deliverables
`;

type SummaryRow = {
  id: number; revision_no: number; title: string; status: string; priority: string;
  client_feedback: string; deadline: string | null; created_at: string; created_by: string;
  project_id: number; project_code: string; project_title: string; project_status: string;
  client_name: string;
  deliverables: {
    id: number; name: string; status: string; department: string; departmentId: number;
    projectDepartmentId: number; assigneeId: number | null; assignee: string | null;
    currentVersionNo: number | null;
  }[];
};

function toSummary(r: SummaryRow): RevisionSummary {
  return {
    id: Number(r.id),
    revisionNo: Number(r.revision_no),
    title: r.title,
    status: r.status,
    priority: r.priority,
    deadline: r.deadline,
    clientFeedback: r.client_feedback,
    createdBy: r.created_by,
    createdAt: r.created_at,
    projectId: Number(r.project_id),
    projectCode: r.project_code,
    projectTitle: r.project_title,
    projectStatus: r.project_status,
    clientName: r.client_name,
    deliverables: (r.deliverables ?? []).map((d) => ({
      id: Number(d.id),
      name: d.name,
      status: d.status,
      department: d.department,
      departmentId: Number(d.departmentId),
      projectDepartmentId: Number(d.projectDepartmentId),
      assigneeId: d.assigneeId === null ? null : Number(d.assigneeId),
      assignee: d.assignee,
      currentVersionNo: d.currentVersionNo === null ? null : Number(d.currentVersionNo),
    })),
  };
}

/**
 * Revisions this person may see (brief §16), open ones unless asked otherwise.
 * A read-only list: a project shared with a Sales rep (§23) shows its
 * revisions here, as its workspace does; acting on one still needs the
 * default scope (lib/revisions/revisions).
 */
export async function revisionList(
  actor: Actor,
  options: { includeClosed?: boolean; projectId?: number } = {},
): Promise<RevisionSummary[]> {
  const rows = await getDb().execute<SummaryRow>(sql`
    SELECT ${summaryColumns}
    FROM revisions r
    JOIN projects p ON p.id = r.project_id
    JOIN clients c  ON c.id = p.client_id
    JOIN users cu   ON cu.id = r.created_by
    WHERE ${revisionScope(actor, 'r', { shared: true })}
      AND ${options.includeClosed ? sql`true` : sql`r.status NOT IN ('closed', 'cancelled')`}
      AND ${options.projectId === undefined ? sql`true` : sql`r.project_id = ${options.projectId}`}
    ORDER BY
      CASE r.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      r.deadline NULLS LAST, r.created_at DESC
  `);
  return rows.map(toSummary);
}

/**
 * null when the revision is outside the actor's scope — indistinguishable
 * from absent. The page it feeds is a read, so a share counts (§23); the
 * page gates its controls on the default scope.
 */
export async function loadRevision(actor: Actor, revisionId: number): Promise<RevisionDetail | null> {
  const db = getDb();
  const rows = await db.execute<SummaryRow & { details: string | null; closed_at: string | null }>(sql`
    SELECT ${summaryColumns}, r.details, ${iso(sql.raw('r.closed_at'))} AS closed_at
    FROM revisions r
    JOIN projects p ON p.id = r.project_id
    JOIN clients c  ON c.id = p.client_id
    JOIN users cu   ON cu.id = r.created_by
    WHERE r.id = ${revisionId} AND ${revisionScope(actor, 'r', { shared: true })}
  `);
  const row = rows[0];
  if (!row) return null;

  const [versions, comments] = await Promise.all([
    db.execute<{
      id: number; deliverable_id: number; deliverable_name: string; version_no: number;
      original_filename: string; storage_key: string; uploaded_by: string; uploaded_at: string; is_current: boolean;
      reviews: RevisionVersionReview[] | null;
    }>(sql`
      SELECT v.id, v.deliverable_id, d.name AS deliverable_name, v.version_no,
             f.original_filename, f.storage_key::text AS storage_key, u.full_name AS uploaded_by,
             ${iso(sql.raw('v.uploaded_at'))} AS uploaded_at, v.is_current,
             COALESCE((
               SELECT json_agg(json_build_object(
                        'stage', q.stage, 'decision', q.decision, 'reviewer', qu.full_name,
                        'comments', q.comments, 'at', ${iso(sql.raw('q.reviewed_at'))})
                      ORDER BY q.reviewed_at, q.id)
               FROM qa_reviews q JOIN users qu ON qu.id = q.reviewer_id
               WHERE q.deliverable_version_id = v.id
             ), '[]'::json) AS reviews
      FROM deliverable_versions v
      JOIN deliverables d ON d.id = v.deliverable_id
      JOIN files f        ON f.id = v.file_id
      JOIN users u        ON u.id = v.uploaded_by
      WHERE v.revision_id = ${revisionId}
      ORDER BY v.uploaded_at DESC, v.id DESC
    `),
    db.execute<{ id: number; author_id: number; author: string; body: string; created_at: string }>(sql`
      SELECT c.id, c.author_id, u.full_name AS author, c.body, ${iso(sql.raw('c.created_at'))} AS created_at
      FROM comments c JOIN users u ON u.id = c.author_id
      WHERE c.revision_id = ${revisionId}
      ORDER BY c.created_at, c.id
    `),
  ]);

  return {
    ...toSummary(row),
    details: row.details,
    closedAt: row.closed_at,
    versions: versions.map((v) => ({
      id: Number(v.id),
      deliverableId: Number(v.deliverable_id),
      deliverableName: v.deliverable_name,
      versionNo: Number(v.version_no),
      originalFilename: v.original_filename,
      downloadUrl: `/api/files/${v.storage_key}`,
      uploadedBy: v.uploaded_by,
      uploadedAt: v.uploaded_at,
      isCurrent: v.is_current === true,
      reviews: (v.reviews ?? []).map((r) => ({
        stage: r.stage, decision: r.decision, reviewer: r.reviewer, comments: r.comments, at: r.at,
      })),
    })),
    comments: comments.map((c) => ({
      id: Number(c.id),
      authorId: Number(c.author_id),
      author: c.author,
      body: c.body,
      createdAt: c.created_at,
    })),
  };
}
