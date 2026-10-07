import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { can, projectScope } from '@/lib/authz';

/**
 * The PM's overall planning view (brief §6): every production team on one
 * page — who leads it, who is in it, how loaded each person is, and what
 * each person is on right now, with dates, progress and project status.
 *
 * Workload is workload.ts's definition, copied filter for filter, so this
 * page and /planning/[teamId] agree to the slot: open slots are deliverables
 * neither approved, delivered nor cancelled on projects neither completed
 * nor cancelled, counted across every project and regardless of the
 * assignment's own status.
 *
 * An assignment is listed under the department it was made on, beside the
 * member it was given to — the lead's "projects assigned to their team". A
 * member's open-slot count still spans every project they hold. An
 * assignment whose holder has since left that department is not listed
 * here (the board row above still shows it).
 *
 * Scope: the PM sees every active production department; a Team Lead only
 * the departments they lead (actor.leadDepartmentIds, the same list
 * canPlanTeam and projectScope use). Anyone else gets an empty roster.
 */
export interface RosterAssignment {
  assignmentId: number;
  /** The project_departments row: where /planning/[teamId] leads. */
  teamId: number;
  projectId: number;
  projectCode: string;
  projectTitle: string;
  clientName: string;
  projectStatus: string;
  deadline: string | null;
  title: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  total: number;
  approved: number;
}

export interface RosterMember {
  userId: number;
  fullName: string;
  isLead: boolean;
  openSlots: number;
  inQa: number;
  dueSoon: number;
  assignments: RosterAssignment[];
}

export interface DepartmentRoster {
  departmentId: number;
  name: string;
  leads: { userId: number; fullName: string }[];
  members: RosterMember[];
  /** Sum of the members' open slots. */
  openSlots: number;
  /** Sum of the members' listed assignments. */
  activeAssignments: number;
}

export async function planningRoster(actor: Actor): Promise<DepartmentRoster[]> {
  if (!actor.isActive) return [];
  const seesAll = can(actor, 'planning.viewAllDepartments');
  if (!seesAll && actor.leadDepartmentIds.length === 0) return [];
  const db = getDb();

  const deptFilter = seesAll
    ? sql``
    : sql`AND d.id IN (${sql.join(actor.leadDepartmentIds.map((id) => sql`${id}`), sql`, `)})`;

  // Departments, members and workload in one grouped query. The inner
  // `department_members JOIN users` is parenthesised on purpose: an empty
  // department must still arrive (as one row with user_id NULL) and an
  // inactive member must not.
  const memberRows = await db.execute<{
    department_id: number; department: string;
    user_id: number | null; full_name: string | null; is_lead: boolean | null;
    open_slots: number; in_qa: number; due_soon: number;
  }>(sql`
    SELECT d.id AS department_id, d.name AS department,
           u.id AS user_id, u.full_name, dm.is_lead,
           COALESCE(w.open_slots, 0) AS open_slots,
           COALESCE(w.in_qa, 0)      AS in_qa,
           COALESCE(w.due_soon, 0)   AS due_soon
    FROM departments d
    LEFT JOIN (department_members dm JOIN users u ON u.id = dm.user_id AND u.is_active)
      ON dm.department_id = d.id
    LEFT JOIN (
      SELECT asg.assignee_id,
             count(*)::int AS open_slots,
             count(*) FILTER (WHERE dv.status IN ('awaiting_lead_qa','awaiting_pm_qa'))::int AS in_qa,
             count(*) FILTER (WHERE dv.due_date IS NOT NULL
                                AND dv.due_date <= current_date + 7)::int AS due_soon
      FROM deliverables dv
      JOIN assignments asg ON asg.id = dv.assignment_id
      JOIN projects p      ON p.id = dv.project_id
      WHERE dv.status NOT IN ('approved','delivered','cancelled')
        AND p.status NOT IN ('completed','cancelled')
      GROUP BY asg.assignee_id
    ) w ON w.assignee_id = u.id
    WHERE d.is_production AND d.is_active ${deptFilter}
    ORDER BY d.sort_order, dm.is_lead DESC NULLS LAST, u.full_name
  `);

  const departments = new Map<number, DepartmentRoster>();
  const members = new Map<string, RosterMember>();
  for (const r of memberRows) {
    const departmentId = Number(r.department_id);
    let dept = departments.get(departmentId);
    if (!dept) {
      dept = { departmentId, name: r.department, leads: [], members: [], openSlots: 0, activeAssignments: 0 };
      departments.set(departmentId, dept);
    }
    if (r.user_id === null) continue;
    const member: RosterMember = {
      userId: Number(r.user_id),
      fullName: r.full_name ?? '',
      isLead: r.is_lead === true,
      openSlots: Number(r.open_slots),
      inQa: Number(r.in_qa),
      dueSoon: Number(r.due_soon),
      assignments: [],
    };
    dept.members.push(member);
    dept.openSlots += member.openSlots;
    if (member.isLead) dept.leads.push({ userId: member.userId, fullName: member.fullName });
    members.set(`${departmentId}:${member.userId}`, member);
  }
  if (departments.size === 0) return [];

  // Every active assignment on those departments, with its progress.
  const idList = sql.join([...departments.keys()].map((id) => sql`${id}`), sql`, `);
  const assignmentRows = await db.execute<{
    assignment_id: number; assignee_id: number; department_id: number; team_id: number;
    title: string; status: string; start_date: string | null; end_date: string | null;
    project_id: number; project_code: string; project_title: string; project_status: string;
    deadline: string | null; client_name: string; total: number; approved: number;
  }>(sql`
    SELECT a.id AS assignment_id, a.assignee_id, pd.department_id, pd.id AS team_id,
           a.title, a.status,
           to_char(a.start_date, 'YYYY-MM-DD') AS start_date,
           to_char(a.end_date, 'YYYY-MM-DD')   AS end_date,
           p.id AS project_id, p.project_code, p.title AS project_title, p.status AS project_status,
           to_char(p.deadline, 'YYYY-MM-DD') AS deadline, c.name AS client_name,
           prog.total::int AS total, prog.approved::int AS approved
    FROM assignments a
    JOIN project_departments pd    ON pd.id = a.project_department_id
    JOIN projects p                ON p.id = a.project_id
    JOIN clients c                 ON c.id = p.client_id
    JOIN v_assignment_progress prog ON prog.assignment_id = a.id
    WHERE a.status NOT IN ('completed','cancelled')
      AND p.status NOT IN ('completed','cancelled')
      AND pd.department_id IN (${idList})
      AND ${projectScope(actor, 'p')}
    ORDER BY a.end_date NULLS LAST, a.start_date NULLS LAST, a.id
  `);

  for (const r of assignmentRows) {
    const departmentId = Number(r.department_id);
    const member = members.get(`${departmentId}:${Number(r.assignee_id)}`);
    // The holder has left this department (or is inactive): not on this roster.
    if (!member) continue;
    member.assignments.push({
      assignmentId: Number(r.assignment_id),
      teamId: Number(r.team_id),
      projectId: Number(r.project_id),
      projectCode: r.project_code,
      projectTitle: r.project_title,
      clientName: r.client_name,
      projectStatus: r.project_status,
      deadline: r.deadline,
      title: r.title,
      status: r.status,
      startDate: r.start_date,
      endDate: r.end_date,
      total: Number(r.total),
      approved: Number(r.approved),
    });
    departments.get(departmentId)!.activeAssignments += 1;
  }

  return [...departments.values()];
}
