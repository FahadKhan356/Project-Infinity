import 'server-only';
import { sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { can, projectScope } from '@/lib/authz';
import type { QaStage } from './review';

export interface QaQueueItem {
  deliverableId: number;
  deliverableName: string;
  sequenceNo: number;
  description: string | null;
  dueDate: string | null;
  stage: QaStage;
  projectId: number;
  projectCode: string;
  projectTitle: string;
  priority: string;
  clientName: string;
  departmentId: number;
  department: string;
  assignee: string | null;
  versionId: number;
  versionNo: number;
  originalFilename: string;
  sizeBytes: number;
  downloadUrl: string;
  uploadedBy: string;
  uploadedAt: string;
  notes: string | null;
  /** How many times this slot has already been sent back. */
  previousRounds: number;
}

/**
 * What is waiting for this person's decision (brief §12, §13).
 *
 * A Team Lead sees `awaiting_lead_qa` slots in the teams they lead; a Project
 * Manager sees `awaiting_pm_qa` slots everywhere. Both are composed with
 * projectScope, so the queue can never show a project the page would refuse.
 */
export async function qaQueue(actor: Actor): Promise<QaQueueItem[]> {
  if (!actor.isActive) return [];

  const conditions: SQL[] = [];
  if (actor.leadDepartmentIds.length > 0) {
    const ids = sql.join(actor.leadDepartmentIds.map((id) => sql`${id}`), sql`, `);
    conditions.push(sql`(d.status = 'awaiting_lead_qa' AND pd.department_id IN (${ids}))`);
  }
  if (can(actor, 'qa.reviewAsProjectManager')) {
    conditions.push(sql`d.status = 'awaiting_pm_qa'`);
  }
  if (conditions.length === 0) return [];

  const rows = await getDb().execute<{
    deliverable_id: number; deliverable_name: string; sequence_no: number; description: string | null;
    due_date: string | null; status: string; project_id: number; project_code: string;
    project_title: string; priority: string; client_name: string; department_id: number;
    department: string; assignee: string | null; version_id: number; version_no: number;
    original_filename: string; size_bytes: string; storage_key: string; uploaded_by: string;
    uploaded_at: string; notes: string | null; previous_rounds: number;
  }>(sql`
    SELECT d.id AS deliverable_id, d.name AS deliverable_name, d.sequence_no, d.description,
           to_char(d.due_date, 'YYYY-MM-DD') AS due_date, d.status,
           p.id AS project_id, p.project_code, p.title AS project_title, p.priority,
           c.name AS client_name, pd.department_id, dept.name AS department,
           asg_u.full_name AS assignee,
           v.id AS version_id, v.version_no, f.original_filename, f.size_bytes::text AS size_bytes,
           f.storage_key::text AS storage_key, up.full_name AS uploaded_by,
           to_char(v.uploaded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS uploaded_at,
           v.notes,
           (SELECT count(*)::int FROM qa_reviews q
              JOIN deliverable_versions pv ON pv.id = q.deliverable_version_id
             WHERE pv.deliverable_id = d.id AND q.decision <> 'approved') AS previous_rounds
    FROM deliverables d
    JOIN project_departments pd ON pd.id = d.project_department_id
    JOIN departments dept       ON dept.id = pd.department_id
    JOIN projects p             ON p.id = d.project_id
    JOIN clients c              ON c.id = p.client_id
    JOIN deliverable_versions v ON v.deliverable_id = d.id AND v.is_current
    JOIN files f                ON f.id = v.file_id
    JOIN users up               ON up.id = v.uploaded_by
    LEFT JOIN assignments asg   ON asg.id = d.assignment_id
    LEFT JOIN users asg_u       ON asg_u.id = asg.assignee_id
    WHERE (${sql.join(conditions, sql` OR `)})
      AND ${projectScope(actor, 'p')}
    ORDER BY
      CASE p.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      d.due_date NULLS LAST, v.uploaded_at
  `);

  return rows.map((r) => ({
    deliverableId: Number(r.deliverable_id),
    deliverableName: r.deliverable_name,
    sequenceNo: Number(r.sequence_no),
    description: r.description,
    dueDate: r.due_date,
    stage: r.status === 'awaiting_pm_qa' ? 'project_manager' : 'team_lead',
    projectId: Number(r.project_id),
    projectCode: r.project_code,
    projectTitle: r.project_title,
    priority: r.priority,
    clientName: r.client_name,
    departmentId: Number(r.department_id),
    department: r.department,
    assignee: r.assignee,
    versionId: Number(r.version_id),
    versionNo: Number(r.version_no),
    originalFilename: r.original_filename,
    sizeBytes: Number(r.size_bytes),
    downloadUrl: `/api/files/${r.storage_key}`,
    uploadedBy: r.uploaded_by,
    uploadedAt: r.uploaded_at,
    notes: r.notes,
    previousRounds: Number(r.previous_rounds),
  }));
}
