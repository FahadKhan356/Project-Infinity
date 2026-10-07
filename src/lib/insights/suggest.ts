import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { can } from '@/lib/authz';
import { rankCandidates, type Suggestion } from './suggest-core';

/** Ranked members of the team for one project's work. Only for those who assign it. */
export async function suggestAssignees(actor: Actor, projectDepartmentId: number): Promise<Suggestion[]> {
  const db = getDb();
  const [team] = await db.execute<{ department_id: number; client_id: number }>(sql`
    SELECT pd.department_id, p.client_id FROM project_departments pd JOIN projects p ON p.id = pd.project_id
    WHERE pd.id = ${projectDepartmentId}
  `);
  if (!team) return [];
  const departmentId = Number(team.department_id);
  if (!can(actor, 'planning.viewAllDepartments') && !actor.leadDepartmentIds.includes(departmentId)) return [];

  const rows = await db.execute<{
    id: number; full_name: string; open_slots: number; approved: number; first_pass: number;
    with_due: number; on_time: number; client_assignments: number;
  }>(sql`
    SELECT u.id, u.full_name,
      (SELECT count(*) FROM deliverables d JOIN assignments a ON a.id = d.assignment_id
        WHERE a.assignee_id = u.id AND d.status NOT IN ('approved','delivered','cancelled'))::int AS open_slots,
      (SELECT count(*) FROM deliveries dl JOIN deliverable_versions v ON v.id = dl.deliverable_version_id
        WHERE v.uploaded_by = u.id AND dl.approved_at > now() - interval '90 days')::int AS approved,
      (SELECT count(*) FROM deliveries dl JOIN deliverable_versions v ON v.id = dl.deliverable_version_id
        WHERE v.uploaded_by = u.id AND dl.approved_at > now() - interval '90 days'
          AND NOT EXISTS (SELECT 1 FROM qa_reviews q JOIN deliverable_versions v2 ON v2.id = q.deliverable_version_id
                          WHERE v2.deliverable_id = dl.deliverable_id AND q.decision <> 'approved'
                            AND q.reviewed_at <= dl.approved_at))::int AS first_pass,
      (SELECT count(*) FROM deliveries dl JOIN deliverable_versions v ON v.id = dl.deliverable_version_id
        JOIN deliverables d ON d.id = dl.deliverable_id
        WHERE v.uploaded_by = u.id AND dl.approved_at > now() - interval '90 days' AND d.due_date IS NOT NULL)::int AS with_due,
      (SELECT count(*) FROM deliveries dl JOIN deliverable_versions v ON v.id = dl.deliverable_version_id
        JOIN deliverables d ON d.id = dl.deliverable_id
        WHERE v.uploaded_by = u.id AND dl.approved_at > now() - interval '90 days'
          AND d.due_date IS NOT NULL AND dl.approved_at::date <= d.due_date)::int AS on_time,
      (SELECT count(*) FROM assignments a JOIN projects p ON p.id = a.project_id
        WHERE a.assignee_id = u.id AND p.client_id = ${team.client_id})::int AS client_assignments
    FROM department_members dm JOIN users u ON u.id = dm.user_id
    WHERE dm.department_id = ${departmentId} AND u.is_active
  `);
  return rankCandidates(rows.map((r) => ({
    userId: Number(r.id), name: r.full_name, openSlots: Number(r.open_slots), approved90: Number(r.approved),
    firstPass90: Number(r.first_pass), withDue90: Number(r.with_due), onTime90: Number(r.on_time),
    clientAssignments: Number(r.client_assignments),
  })));
}
