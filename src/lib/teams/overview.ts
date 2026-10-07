import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { can, projectScope } from '@/lib/authz';
import { teamWorkload, type MemberWorkload } from '@/lib/planning/workload';

/**
 * Team Overview (brief §5, §6): every production team, who leads it, who is
 * in it, how loaded each person is, and what the team is working on. The PM
 * and management see every team; a Team Lead sees only the teams they lead.
 * No pricing here — this is a production view.
 *
 * "Active" means routed to the team by the PM (a lead is set) and not
 * completed or cancelled. A project still in intake carries department rows
 * from Sales' form but is not yet any team's work — the planning board's rule.
 */
export interface TeamProject {
  projectDepartmentId: number;
  projectId: number;
  projectCode: string;
  title: string;
  clientName: string;
  teamLead: string | null;
  status: string;
  /** This team's slots only. */
  approved: number;
  total: number;
  openSlots: number;
  inQa: number;
  overdueSlots: number;
  deadline: string | null;
  /** The span of this team's assignments on the project. */
  startDate: string | null;
  endDate: string | null;
}

export interface TeamOverview {
  departmentId: number;
  name: string;
  leads: { userId: number; fullName: string }[];
  members: MemberWorkload[];
  activeProjects: number;
  openSlots: number;
  inQa: number;
  overdueSlots: number;
  projects: TeamProject[];
}

export function canViewTeams(actor: Actor): boolean {
  if (!actor.isActive) return false;
  return can(actor, 'planning.viewAllDepartments') || actor.leadDepartmentIds.length > 0;
}

/** Null when the actor may not see the overview at all. */
export async function loadTeamOverview(actor: Actor): Promise<TeamOverview[] | null> {
  if (!canViewTeams(actor)) return null;
  const db = getDb();
  const seesAll = can(actor, 'planning.viewAllDepartments');
  const ids = sql.join(actor.leadDepartmentIds.map((id) => sql`${id}`), sql`, `);

  const departments = await db.execute<{ id: number; name: string }>(sql`
    SELECT d.id, d.name FROM departments d
    WHERE d.is_production AND d.is_active ${seesAll ? sql`` : sql`AND d.id IN (${ids})`}
    ORDER BY d.sort_order
  `);
  if (departments.length === 0) return [];
  const departmentIds = sql.join(departments.map((d) => sql`${Number(d.id)}`), sql`, `);

  const projectRows = await db.execute<{
    id: number; department_id: number; project_id: number; project_code: string; title: string;
    client_name: string; team_lead: string | null; status: string; deadline: string | null;
    total: number; approved: number; open_slots: number; in_qa: number; overdue: number;
    start_date: string | null; end_date: string | null;
  }>(sql`
    SELECT pd.id, pd.department_id, p.id AS project_id, p.project_code, p.title,
           c.name AS client_name, tl.full_name AS team_lead, p.status,
           to_char(p.deadline, 'YYYY-MM-DD') AS deadline,
           COALESCE(s.total, 0) AS total, COALESCE(s.approved, 0) AS approved,
           COALESCE(s.open_slots, 0) AS open_slots, COALESCE(s.in_qa, 0) AS in_qa,
           COALESCE(s.overdue, 0) AS overdue,
           (SELECT to_char(min(a.start_date), 'YYYY-MM-DD') FROM assignments a
             WHERE a.project_department_id = pd.id AND a.status <> 'cancelled') AS start_date,
           (SELECT to_char(max(a.end_date), 'YYYY-MM-DD') FROM assignments a
             WHERE a.project_department_id = pd.id AND a.status <> 'cancelled') AS end_date
    FROM project_departments pd
    JOIN projects p    ON p.id = pd.project_id
    JOIN clients c     ON c.id = p.client_id
    LEFT JOIN users tl ON tl.id = pd.team_lead_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE dv.status IN ('approved','delivered'))::int AS approved,
             count(*) FILTER (WHERE dv.status NOT IN ('approved','delivered'))::int AS open_slots,
             count(*) FILTER (WHERE dv.status IN ('awaiting_lead_qa','awaiting_pm_qa'))::int AS in_qa,
             count(*) FILTER (WHERE dv.status NOT IN ('approved','delivered')
                                AND dv.due_date < current_date)::int AS overdue
      FROM deliverables dv
      WHERE dv.project_department_id = pd.id AND dv.status <> 'cancelled'
    ) s ON true
    WHERE pd.department_id IN (${departmentIds})
      AND pd.team_lead_id IS NOT NULL
      AND p.status NOT IN ('completed','cancelled')
      AND ${projectScope(actor, 'p')}
    ORDER BY p.deadline NULLS LAST, p.project_code
  `);

  const members = await Promise.all(departments.map((d) => teamWorkload(Number(d.id))));

  return departments.map((d, i) => {
    const departmentId = Number(d.id);
    const projects: TeamProject[] = projectRows
      .filter((r) => Number(r.department_id) === departmentId)
      .map((r) => ({
        projectDepartmentId: Number(r.id),
        projectId: Number(r.project_id),
        projectCode: r.project_code,
        title: r.title,
        clientName: r.client_name,
        teamLead: r.team_lead,
        status: r.status,
        approved: Number(r.approved),
        total: Number(r.total),
        openSlots: Number(r.open_slots),
        inQa: Number(r.in_qa),
        overdueSlots: Number(r.overdue),
        deadline: r.deadline,
        startDate: r.start_date,
        endDate: r.end_date,
      }));
    const team = members[i];
    return {
      departmentId,
      name: d.name,
      leads: team.filter((m) => m.isLead).map((m) => ({ userId: m.userId, fullName: m.fullName })),
      members: team,
      activeProjects: projects.length,
      openSlots: projects.reduce((acc, p) => acc + p.openSlots, 0),
      inQa: projects.reduce((acc, p) => acc + p.inQa, 0),
      overdueSlots: projects.reduce((acc, p) => acc + p.overdueSlots, 0),
      projects,
    };
  });
}
