import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';

/**
 * What "workload" means here (the brief asks for it in §6 and §21 but never
 * defines it, and there is no time tracking in Phase 1):
 *
 *   open slots  — deliverables assigned to this person that are neither
 *                 approved, delivered nor cancelled, across every project
 *   in QA       — of those, the ones sitting in someone's review queue
 *   due soon    — open slots with a due date inside the next seven days
 *
 * It is a count of committed work, not an estimate of hours. If the client
 * wants capacity in hours, that needs an estimate field on the assignment —
 * flagged in docs/phase-1a-plan.md.
 */
export interface MemberWorkload {
  userId: number;
  fullName: string;
  isLead: boolean;
  openSlots: number;
  inQa: number;
  dueSoon: number;
  activeAssignments: number;
  onThisTeam: number;
}

export async function teamWorkload(departmentId: number): Promise<MemberWorkload[]> {
  const rows = await getDb().execute<{
    user_id: number; full_name: string; is_lead: boolean;
    open_slots: number; in_qa: number; due_soon: number;
    active_assignments: number; on_this_team: number;
  }>(sql`
    SELECT u.id AS user_id, u.full_name, dm.is_lead,
           COALESCE(w.open_slots, 0)         AS open_slots,
           COALESCE(w.in_qa, 0)              AS in_qa,
           COALESCE(w.due_soon, 0)           AS due_soon,
           COALESCE(a.active_assignments, 0) AS active_assignments,
           COALESCE(t.on_this_team, 0)       AS on_this_team
    FROM department_members dm
    JOIN users u ON u.id = dm.user_id AND u.is_active
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS open_slots,
             count(*) FILTER (WHERE d.status IN ('awaiting_lead_qa','awaiting_pm_qa'))::int AS in_qa,
             count(*) FILTER (WHERE d.due_date IS NOT NULL
                                AND d.due_date <= current_date + 7)::int AS due_soon
      FROM deliverables d
      JOIN assignments asg ON asg.id = d.assignment_id
      JOIN projects p      ON p.id = d.project_id
      WHERE asg.assignee_id = u.id
        AND d.status NOT IN ('approved','delivered','cancelled')
        AND p.status NOT IN ('completed','cancelled')
    ) w ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS active_assignments
      FROM assignments asg
      JOIN projects p ON p.id = asg.project_id
      WHERE asg.assignee_id = u.id
        AND asg.status NOT IN ('completed','cancelled')
        AND p.status NOT IN ('completed','cancelled')
    ) a ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS on_this_team
      FROM deliverables d
      JOIN assignments asg ON asg.id = d.assignment_id
      JOIN project_departments pd ON pd.id = asg.project_department_id
      WHERE asg.assignee_id = u.id
        AND pd.department_id = ${departmentId}
        AND d.status NOT IN ('approved','delivered','cancelled')
    ) t ON true
    WHERE dm.department_id = ${departmentId}
    ORDER BY dm.is_lead DESC, u.full_name
  `);

  return rows.map((r) => ({
    userId: Number(r.user_id),
    fullName: r.full_name,
    isLead: r.is_lead === true,
    openSlots: Number(r.open_slots),
    inQa: Number(r.in_qa),
    dueSoon: Number(r.due_soon),
    activeAssignments: Number(r.active_assignments),
    onThisTeam: Number(r.on_this_team),
  }));
}
