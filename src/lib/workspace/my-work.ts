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
  /** Revisions touching this assignment's slots that are still open (§8 "revision status"). */
  openRevisions: number;
  latestRevisionNo: number | null;
  latestRevisionStatus: string | null;
  /** The project's comment thread (§8 "comments"). */
  commentCount: number;
  /** ISO-8601, UTC. */
  lastCommentAt: string | null;
  /** The planned dates hold today (§21 "today's assignments"). */
  isToday: boolean;
  /** The deliverable slots themselves, in sequence (§8 "deliverables"): what is owed, not only how many. */
  slots: WorkSlot[];
}

export interface WorkSlot {
  id: number;
  name: string;
  description: string | null;
  status: string;
}

export interface MyWork {
  /** Assignments still open on projects still open. */
  current: WorkItem[];
  /** The subset of `current` whose start–end window holds today. */
  today: WorkItem[];
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
    open_revisions: number; latest_revision_no: number | null; latest_revision_status: string | null;
    comment_count: number; last_comment_at: string | null;
    is_today: boolean; is_current: boolean;
    slots: { id: number; name: string; description: string | null; status: string }[];
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
           COALESCE(rv.open_revisions, 0) AS open_revisions,
           rv.latest_revision_no, rv.latest_revision_status,
           COALESCE(cm.comment_count, 0) AS comment_count, cm.last_comment_at,
           COALESCE(s.slots, '[]'::json) AS slots,
           (a.start_date IS NOT NULL AND a.start_date <= current_date
              AND (a.end_date IS NULL OR a.end_date >= current_date)) AS is_today,
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
             count(*) FILTER (WHERE dv.status = 'changes_requested')::int AS changes_requested,
             -- The slots by name (§8 "deliverables"), so the list says what
             -- is owed without opening the project.
             json_agg(json_build_object('id', dv.id, 'name', dv.name, 'description', dv.description,
                                        'status', dv.status) ORDER BY dv.sequence_no) AS slots
      FROM deliverables dv
      WHERE dv.assignment_id = a.id AND dv.status <> 'cancelled'
    ) s ON true
    -- Revisions touching this assignment's slots (§8 "revision status"):
    -- how many are open, and where the newest one stands.
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE r.status IN ('new','assigned','in_progress','awaiting_qa'))::int AS open_revisions,
             (array_agg(r.revision_no ORDER BY r.revision_no DESC))[1] AS latest_revision_no,
             (array_agg(r.status::text ORDER BY r.revision_no DESC))[1] AS latest_revision_status
      FROM revisions r
      WHERE r.project_id = p.id
        AND EXISTS (
          SELECT 1 FROM revision_deliverables rd
          JOIN deliverables x ON x.id = rd.deliverable_id
          WHERE rd.revision_id = r.id AND x.assignment_id = a.id
        )
    ) rv ON true
    -- The conversation on this project (§8 "comments").
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS comment_count,
             to_char(max(c.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_comment_at
      FROM comments c
      LEFT JOIN deliverables cd ON cd.id = c.deliverable_id
      LEFT JOIN assignments ca  ON ca.id = c.assignment_id
      -- A thread on one upload (§10, §19) belongs to that slot's project too.
      LEFT JOIN deliverable_versions cv ON cv.id = c.version_id
      LEFT JOIN deliverables cvd        ON cvd.id = cv.deliverable_id
      WHERE c.project_id = p.id OR cd.project_id = p.id OR ca.project_id = p.id OR cvd.project_id = p.id
    ) cm ON true
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
      openRevisions: Number(r.open_revisions),
      latestRevisionNo: r.latest_revision_no === null ? null : Number(r.latest_revision_no),
      latestRevisionStatus: r.latest_revision_status,
      commentCount: Number(r.comment_count),
      lastCommentAt: r.last_comment_at,
      isToday: r.is_today === true,
      slots: (r.slots ?? []).map((s) => ({
        id: Number(s.id), name: s.name, description: s.description, status: s.status,
      })),
    },
    isCurrent: r.is_current === true,
  }));

  const current = items.filter((x) => x.isCurrent).map((x) => x.item);
  return {
    current,
    // §21 "Today's assignments": the current work whose planned dates hold today.
    today: current.filter((x) => x.isToday),
    previous: items.filter((x) => !x.isCurrent).map((x) => x.item),
  };
}
