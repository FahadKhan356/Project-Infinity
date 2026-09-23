import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { projectScope } from '@/lib/authz';

/**
 * One row of an Executive's work list (brief §8): everything they need to
 * decide what to open next, without opening it.
 */
export interface WorkItem {
  assignmentId: number;
  projectId: number;
  projectDepartmentId: number;
  projectCode: string;
  projectTitle: string;
  projectStatus: string;
  clientName: string;
  department: string;
  assignmentTitle: string;
  instructions: string | null;
  startDate: string | null;
  endDate: string | null;
  deadline: string | null;
  priority: string;
  status: string;
  total: number;
  approved: number;
  uploaded: number;
  inQa: number;
  changesRequested: number;
}

export interface MyWork {
  /** Assignments still open on projects still open. */
  current: WorkItem[];
  /** Everything else — kept for reference (§8 "Ongoing / Previous Projects"). */
  previous: WorkItem[];
}

/**
 * The assignments this person holds, split into current and previous.
 *
 * "Previous" is decided by either side closing: a finished assignment on a
 * live project, or a live assignment on a project that has been completed or
 * cancelled. Both are history to the person doing the work.
 */
export async function myWork(actor: Actor): Promise<MyWork> {
  const rows = await getDb().execute<{
    assignment_id: number; project_id: number; project_department_id: number;
    project_code: string; project_title: string; project_status: string; client_name: string;
    department: string; assignment_title: string; instructions: string | null;
    start_date: string | null; end_date: string | null; deadline: string | null;
    priority: string; status: string;
    total: number; approved: number; uploaded: number; in_qa: number; changes_requested: number;
    is_current: boolean;
  }>(sql`
    SELECT a.id AS assignment_id, p.id AS project_id, a.project_department_id,
           p.project_code, p.title AS project_title, p.status AS project_status,
           c.name AS client_name, d.name AS department,
           a.title AS assignment_title, a.instructions,
           to_char(a.start_date, 'YYYY-MM-DD') AS start_date,
           to_char(a.end_date, 'YYYY-MM-DD')   AS end_date,
           to_char(p.deadline, 'YYYY-MM-DD')   AS deadline,
           a.priority, a.status,
           COALESCE(s.total, 0) AS total, COALESCE(s.approved, 0) AS approved,
           COALESCE(s.uploaded, 0) AS uploaded, COALESCE(s.in_qa, 0) AS in_qa,
           COALESCE(s.changes_requested, 0) AS changes_requested,
           (a.status NOT IN ('completed','cancelled')
              AND p.status NOT IN ('completed','cancelled')) AS is_current
    FROM assignments a
    JOIN projects p            ON p.id = a.project_id
    JOIN clients c             ON c.id = p.client_id
    JOIN project_departments pd ON pd.id = a.project_department_id
    JOIN departments d         ON d.id = pd.department_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE dv.status IN ('approved','delivered'))::int AS approved,
             count(*) FILTER (WHERE dv.status <> 'pending')::int AS uploaded,
             count(*) FILTER (WHERE dv.status IN ('awaiting_lead_qa','awaiting_pm_qa'))::int AS in_qa,
             count(*) FILTER (WHERE dv.status = 'changes_requested')::int AS changes_requested
      FROM deliverables dv
      WHERE dv.assignment_id = a.id AND dv.status <> 'cancelled'
    ) s ON true
    WHERE a.assignee_id = ${actor.id}
      AND ${projectScope(actor, 'p')}
    ORDER BY
      CASE a.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      a.end_date NULLS LAST, p.deadline NULLS LAST, a.created_at DESC
  `);

  const items = rows.map((r) => ({
    item: {
      assignmentId: Number(r.assignment_id),
      projectId: Number(r.project_id),
      projectDepartmentId: Number(r.project_department_id),
      projectCode: r.project_code,
      projectTitle: r.project_title,
      projectStatus: r.project_status,
      clientName: r.client_name,
      department: r.department,
      assignmentTitle: r.assignment_title,
      instructions: r.instructions,
      startDate: r.start_date,
      endDate: r.end_date,
      deadline: r.deadline,
      priority: r.priority,
      status: r.status,
      total: Number(r.total),
      approved: Number(r.approved),
      uploaded: Number(r.uploaded),
      inQa: Number(r.in_qa),
      changesRequested: Number(r.changes_requested),
    },
    isCurrent: r.is_current === true,
  }));

  return {
    current: items.filter((x) => x.isCurrent).map((x) => x.item),
    previous: items.filter((x) => !x.isCurrent).map((x) => x.item),
  };
}
