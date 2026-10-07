import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { can } from '@/lib/authz';

/**
 * One team-row of the planning overview (brief §6): a project's work as
 * routed to one department, with who holds it, when, and how far it is.
 */
export interface PlanningRow {
  teamId: number;
  projectId: number;
  projectCode: string;
  title: string;
  status: string;
  priority: string;
  deadline: string | null;
  clientName: string;
  periodYear: number;
  periodMonth: number;
  department: string;
  teamLead: string | null;
  planned: number;
  slots: number;
  approved: number;
  /** Every non-cancelled assignment holder, each once, alphabetically. */
  assignees: string | null;
  /** The span of the planned assignment dates: earliest start, latest end. */
  startsOn: string | null;
  endsOn: string | null;
}

/**
 * The planning board: every routed team-row for the Project Manager, and
 * for a Team Lead only the rows of the departments they lead that already
 * have a lead set. Cancelled assignments count for nothing here.
 */
export async function planningBoard(actor: Actor): Promise<PlanningRow[]> {
  if (!actor.isActive) return [];
  const seesEverything = can(actor, 'planning.viewAllDepartments');

  const rows = await getDb().execute<{
    team_id: number; project_id: number; project_code: string; title: string; status: string; priority: string;
    deadline: string | null; client_name: string; period_year: number; period_month: number;
    department: string; team_lead: string | null; planned: number; slots: number; approved: number;
    assignees: string | null; starts_on: string | null; ends_on: string | null;
  }>(sql`
    SELECT pd.id AS team_id, p.id AS project_id, p.project_code, p.title, p.status, p.priority,
           to_char(p.deadline, 'YYYY-MM-DD') AS deadline,
           c.name AS client_name, cm.period_year, cm.period_month,
           d.name AS department, tl.full_name AS team_lead,
           pd.planned_deliverables AS planned,
           (SELECT count(*) FROM deliverables dv
             WHERE dv.project_department_id = pd.id AND dv.status <> 'cancelled')::int AS slots,
           (SELECT count(*) FROM deliverables dv
             WHERE dv.project_department_id = pd.id AND dv.status IN ('approved','delivered'))::int AS approved,
           -- Who is on it and when (§6): the members assigned, and the span
           -- of their planned dates.
           (SELECT string_agg(DISTINCT u.full_name, ', ' ORDER BY u.full_name)
              FROM assignments a JOIN users u ON u.id = a.assignee_id
             WHERE a.project_department_id = pd.id AND a.status <> 'cancelled') AS assignees,
           (SELECT to_char(min(a.start_date), 'YYYY-MM-DD') FROM assignments a
             WHERE a.project_department_id = pd.id AND a.status <> 'cancelled') AS starts_on,
           (SELECT to_char(max(a.end_date), 'YYYY-MM-DD') FROM assignments a
             WHERE a.project_department_id = pd.id AND a.status <> 'cancelled') AS ends_on
    FROM project_departments pd
    JOIN projects p       ON p.id = pd.project_id
    JOIN clients c        ON c.id = p.client_id
    JOIN client_months cm ON cm.id = p.client_month_id
    JOIN departments d    ON d.id = pd.department_id
    LEFT JOIN users tl    ON tl.id = pd.team_lead_id
    WHERE p.status NOT IN ('completed','cancelled')
      AND ${seesEverything
        ? sql`true`
        // Scoped to the teams this person leads (§6 says "their team", not
        // "assigned to them", so a co-lead sees the same board). A row with no
        // lead yet is excluded: it is still unfinished routing and belongs in
        // the PM's intake queue, not on a planning board.
        : sql`pd.team_lead_id IS NOT NULL
              AND pd.department_id IN (
                SELECT dm.department_id FROM department_members dm
                WHERE dm.user_id = ${actor.id} AND dm.is_lead)`}
    ORDER BY
      CASE p.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      p.deadline NULLS LAST, d.sort_order
  `);

  return rows.map((r) => ({
    teamId: Number(r.team_id),
    projectId: Number(r.project_id),
    projectCode: r.project_code,
    title: r.title,
    status: r.status,
    priority: r.priority,
    deadline: r.deadline,
    clientName: r.client_name,
    periodYear: Number(r.period_year),
    periodMonth: Number(r.period_month),
    department: r.department,
    teamLead: r.team_lead,
    planned: Number(r.planned),
    slots: Number(r.slots),
    approved: Number(r.approved),
    assignees: r.assignees,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
  }));
}
