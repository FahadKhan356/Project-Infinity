import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { can, projectScope, revisionScope } from '@/lib/authz';
import { upcomingDeadlines, type Deadline } from '@/lib/notifications/inbox';
import { teamWorkload, type MemberWorkload } from '@/lib/planning/workload';

/**
 * Per-role dashboards (brief §21). Every number is produced by composing
 * `projectScope`, so the same function serves every role and the counts a
 * Team Lead sees are the counts over the projects they can open — never a
 * second, looser rule.
 */
export interface DashboardCounts {
  total: number;
  active: number;
  new: number;
  awaitingAssignment: number;
  planned: number;
  inProgress: number;
  /** Active projects with at least one slot in someone's QA queue. */
  inQa: number;
  inRevision: number;
  /** Active projects with an approved file not yet delivered. */
  awaitingDelivery: number;
  delivered: number;
  completed: number;
  onHold: number;
  /** Past their deadline and not yet delivered. */
  delayed: number;
}

export interface DepartmentSummary {
  departmentId: number;
  name: string;
  activeProjects: number;
  openSlots: number;
  inQa: number;
  approved: number;
  reviews: number;
  rejected: number;
}

export interface DepartmentWorkload {
  departmentId: number;
  name: string;
  members: MemberWorkload[];
}

export interface IntakeRow {
  id: number;
  projectCode: string;
  title: string;
  clientName: string;
  createdAt: string;
}

export interface PlanningGap {
  projectDepartmentId: number;
  projectId: number;
  projectCode: string;
  title: string;
  department: string;
  plannedDeliverables: number;
}

export interface ExecutiveSummary {
  activeAssignments: number;
  currentProjects: number;
  pendingDeliverables: number;
  inQa: number;
  toRedo: number;
  completedDeliverables: number;
}

export interface Dashboard {
  counts: DashboardCounts;
  /** Only for those who may see pricing; null otherwise (brief §21, §23). */
  value: { currency: string; active: string; thisMonth: string } | null;
  departments: DepartmentSummary[];
  workload: DepartmentWorkload[];
  deadlines: Deadline[];
  intake: IntakeRow[];
  /** Deliverables waiting for this person's QA decision. */
  qaQueue: number;
  openRevisions: number;
  pendingDeliveries: number;
  planningGaps: PlanningGap[];
  executive: ExecutiveSummary | null;
}

export async function loadDashboard(actor: Actor): Promise<Dashboard> {
  const db = getDb();
  const scope = projectScope(actor, 'p');
  const seesAll = can(actor, 'projects.viewAll');
  const isLead = actor.leadDepartmentIds.length > 0 && !seesAll;
  const isExecutive = actor.role === 'executive';

  const [countRow] = await db.execute<Record<string, number>>(sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE p.status NOT IN ('completed','cancelled'))::int AS active,
           count(*) FILTER (WHERE p.status = 'new')::int AS new,
           count(*) FILTER (WHERE p.status = 'awaiting_assignment')::int AS awaiting_assignment,
           count(*) FILTER (WHERE p.status = 'planned')::int AS planned,
           count(*) FILTER (WHERE p.status = 'in_progress')::int AS in_progress,
           count(*) FILTER (WHERE p.status NOT IN ('completed','cancelled') AND prog.in_qa > 0)::int AS in_qa,
           count(*) FILTER (WHERE p.status = 'revision_required')::int AS in_revision,
           count(*) FILTER (WHERE p.status NOT IN ('completed','cancelled') AND EXISTS (
             SELECT 1 FROM deliveries dl WHERE dl.project_id = p.id AND dl.status = 'pending_delivery'))::int AS awaiting_delivery,
           count(*) FILTER (WHERE p.status = 'delivered')::int AS delivered,
           count(*) FILTER (WHERE p.status = 'completed')::int AS completed,
           count(*) FILTER (WHERE p.status = 'on_hold')::int AS on_hold,
           count(*) FILTER (WHERE p.deadline < current_date
             AND p.status NOT IN ('completed','cancelled','delivered'))::int AS delayed
    FROM projects p
    JOIN v_project_progress prog ON prog.project_id = p.id
    WHERE ${scope}
  `);
  const n = (key: string) => Number(countRow?.[key] ?? 0);
  const counts: DashboardCounts = {
    total: n('total'), active: n('active'), new: n('new'), awaitingAssignment: n('awaiting_assignment'),
    planned: n('planned'), inProgress: n('in_progress'), inQa: n('in_qa'), inRevision: n('in_revision'),
    awaitingDelivery: n('awaiting_delivery'), delivered: n('delivered'), completed: n('completed'),
    onHold: n('on_hold'), delayed: n('delayed'),
  };

  let value: Dashboard['value'] = null;
  if (can(actor, 'pricing.view')) {
    const [row] = await db.execute<{ currency: string | null; active: string | null; this_month: string | null }>(sql`
      SELECT max(p.price_currency) AS currency,
             COALESCE(sum(p.price_amount) FILTER (WHERE p.status NOT IN ('completed','cancelled')), 0)::text AS active,
             COALESCE(sum(p.price_amount) FILTER (
               WHERE cm.period_year = extract(year FROM current_date)::int
                 AND cm.period_month = extract(month FROM current_date)::int
                 AND p.status <> 'cancelled'), 0)::text AS this_month
      FROM projects p JOIN client_months cm ON cm.id = p.client_month_id
      WHERE ${scope}
    `);
    value = { currency: row?.currency ?? 'AED', active: row?.active ?? '0', thisMonth: row?.this_month ?? '0' };
  }

  const departmentFilter = isLead
    ? sql`AND d.id IN (${sql.join(actor.leadDepartmentIds.map((id) => sql`${id}`), sql`, `)})`
    : sql``;
  const departmentRows = isExecutive ? [] : await db.execute<{
    id: number; name: string; active_projects: number; open_slots: number; in_qa: number; approved: number;
    reviews: number; rejected: number;
  }>(sql`
    WITH visible AS (SELECT p.id, p.status FROM projects p WHERE ${scope})
    SELECT d.id, d.name,
           (SELECT count(DISTINCT pd.project_id)::int FROM project_departments pd
              JOIN visible v ON v.id = pd.project_id
             WHERE pd.department_id = d.id AND v.status NOT IN ('completed','cancelled')) AS active_projects,
           COALESCE(s.open_slots, 0) AS open_slots, COALESCE(s.in_qa, 0) AS in_qa, COALESCE(s.approved, 0) AS approved,
           COALESCE(q.reviews, 0) AS reviews, COALESCE(q.rejected, 0) AS rejected
    FROM departments d
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE dv.status NOT IN ('approved','delivered','cancelled'))::int AS open_slots,
             count(*) FILTER (WHERE dv.status IN ('awaiting_lead_qa','awaiting_pm_qa'))::int AS in_qa,
             count(*) FILTER (WHERE dv.status IN ('approved','delivered'))::int AS approved
      FROM deliverables dv
      JOIN project_departments pd ON pd.id = dv.project_department_id
      JOIN visible v ON v.id = dv.project_id
      WHERE pd.department_id = d.id
    ) s ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS reviews,
             count(*) FILTER (WHERE qr.decision <> 'approved')::int AS rejected
      FROM qa_reviews qr
      JOIN deliverable_versions ver ON ver.id = qr.deliverable_version_id
      JOIN deliverables dv ON dv.id = ver.deliverable_id
      JOIN project_departments pd ON pd.id = dv.project_department_id
      JOIN visible v ON v.id = dv.project_id
      WHERE pd.department_id = d.id
    ) q ON true
    WHERE d.is_production AND d.is_active ${departmentFilter}
    ORDER BY d.sort_order
  `);
  const departments: DepartmentSummary[] = departmentRows.map((r) => ({
    departmentId: Number(r.id), name: r.name, activeProjects: Number(r.active_projects),
    openSlots: Number(r.open_slots), inQa: Number(r.in_qa), approved: Number(r.approved),
    reviews: Number(r.reviews), rejected: Number(r.rejected),
  }));

  const workloadDepartments = isExecutive || actor.role === 'sales' ? [] : departments;
  // Teams with nobody in them have no workload to show.
  const workload: DepartmentWorkload[] = (await Promise.all(
    workloadDepartments.map(async (d) => ({
      departmentId: d.departmentId, name: d.name, members: await teamWorkload(d.departmentId),
    })),
  )).filter((w) => w.members.length > 0);

  const intake = isExecutive || isLead ? [] : (await db.execute<{
    id: number; project_code: string; title: string; client_name: string; created_at: string;
  }>(sql`
    SELECT p.id, p.project_code, p.title, c.name AS client_name,
           to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
    FROM projects p JOIN clients c ON c.id = p.client_id
    WHERE p.status = 'new' AND ${scope}
    ORDER BY p.created_at DESC LIMIT 8
  `)).map((r) => ({
    id: Number(r.id), projectCode: r.project_code, title: r.title, clientName: r.client_name, createdAt: r.created_at,
  }));

  let qaQueue = 0;
  if (can(actor, 'qa.reviewAsProjectManager')) {
    const [row] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM deliverables dv JOIN projects p ON p.id = dv.project_id
      WHERE dv.status = 'awaiting_pm_qa' AND ${scope}`);
    qaQueue = Number(row?.n ?? 0);
  } else if (actor.leadDepartmentIds.length > 0) {
    const [row] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM deliverables dv
      JOIN project_departments pd ON pd.id = dv.project_department_id
      JOIN projects p ON p.id = dv.project_id
      WHERE dv.status = 'awaiting_lead_qa' AND ${scope}
        AND pd.department_id IN (${sql.join(actor.leadDepartmentIds.map((id) => sql`${id}`), sql`, `)})`);
    qaQueue = Number(row?.n ?? 0);
  }

  const [revisionRow] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM revisions r
    WHERE r.status IN ('new','assigned','in_progress','awaiting_qa') AND ${revisionScope(actor, 'r')}
  `);
  const openRevisions = Number(revisionRow?.n ?? 0);

  let pendingDeliveries = 0;
  if (can(actor, 'delivery.manage') || seesAll) {
    const [row] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM deliveries dl JOIN projects p ON p.id = dl.project_id
      WHERE dl.status = 'pending_delivery' AND ${scope}`);
    pendingDeliveries = Number(row?.n ?? 0);
  }

  const planningGaps: PlanningGap[] = !isLead ? [] : (await db.execute<{
    id: number; project_id: number; project_code: string; title: string; department: string; planned: number;
  }>(sql`
    SELECT pd.id, p.id AS project_id, p.project_code, p.title, d.name AS department, pd.planned_deliverables AS planned
    FROM project_departments pd
    JOIN projects p ON p.id = pd.project_id
    JOIN departments d ON d.id = pd.department_id
    WHERE pd.department_id IN (${sql.join(actor.leadDepartmentIds.map((id) => sql`${id}`), sql`, `)})
      -- Routed to this team by the PM (§5); a project still in intake carries
      -- its department rows from Sales' form but is nobody's to plan yet.
      AND pd.team_lead_id IS NOT NULL
      AND p.status NOT IN ('new','awaiting_assignment','completed','cancelled','on_hold')
      AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.project_department_id = pd.id)
      AND ${scope}
    ORDER BY p.deadline NULLS LAST, p.created_at
  `)).map((r) => ({
    projectDepartmentId: Number(r.id), projectId: Number(r.project_id), projectCode: r.project_code,
    title: r.title, department: r.department, plannedDeliverables: Number(r.planned),
  }));

  let executive: ExecutiveSummary | null = null;
  if (isExecutive) {
    const [row] = await db.execute<Record<string, number>>(sql`
      SELECT (SELECT count(*)::int FROM assignments a JOIN projects p ON p.id = a.project_id
               WHERE a.assignee_id = ${actor.id} AND a.status NOT IN ('completed','cancelled')
                 AND p.status NOT IN ('completed','cancelled')) AS active_assignments,
             (SELECT count(DISTINCT a.project_id)::int FROM assignments a JOIN projects p ON p.id = a.project_id
               WHERE a.assignee_id = ${actor.id} AND a.status NOT IN ('completed','cancelled')
                 AND p.status NOT IN ('completed','cancelled')) AS current_projects,
             s.pending, s.in_qa, s.to_redo, s.completed
      FROM (
        SELECT count(*) FILTER (WHERE dv.status NOT IN ('approved','delivered','cancelled'))::int AS pending,
               count(*) FILTER (WHERE dv.status IN ('awaiting_lead_qa','awaiting_pm_qa'))::int AS in_qa,
               count(*) FILTER (WHERE dv.status = 'changes_requested')::int AS to_redo,
               count(*) FILTER (WHERE dv.status IN ('approved','delivered'))::int AS completed
        FROM deliverables dv JOIN assignments a ON a.id = dv.assignment_id
        WHERE a.assignee_id = ${actor.id}
      ) s
    `);
    executive = {
      activeAssignments: Number(row?.active_assignments ?? 0),
      currentProjects: Number(row?.current_projects ?? 0),
      pendingDeliverables: Number(row?.pending ?? 0),
      inQa: Number(row?.in_qa ?? 0),
      toRedo: Number(row?.to_redo ?? 0),
      completedDeliverables: Number(row?.completed ?? 0),
    };
  }

  const deadlines = await upcomingDeadlines(actor, 7);

  return {
    counts, value, departments, workload, deadlines, intake, qaQueue, openRevisions, pendingDeliveries,
    planningGaps, executive,
  };
}
