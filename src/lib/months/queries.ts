import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { projectScope } from '@/lib/authz';

export interface MonthSummary {
  id: number;
  year: number;
  month: number;
  status: 'open' | 'closed';
  closedAt: string | null;
  closedBy: string | null;
  /** Projects visible to this actor, so the numbers match the list beneath. */
  projects: number;
  deliverables: number;
  completed: number;
  inQa: number;
  inRevision: number;
  pending: number;
  departments: string[];
}

/**
 * One line per month of a client's history — the §39 report in its simplest
 * form: how much was ordered, how much is done, what is still moving, and
 * which teams were involved. Scoped, so an Executive's numbers cover only
 * the projects they can open.
 */
export async function monthSummaries(actor: Actor, clientId: number): Promise<MonthSummary[]> {
  const rows = await getDb().execute<{
    id: number; period_year: number; period_month: number; status: 'open' | 'closed';
    closed_at: string | null; closed_by: string | null;
    projects: number; deliverables: number; completed: number; in_qa: number; in_revision: number;
    pending: number; departments: string[] | null;
  }>(sql`
    WITH visible AS (
      SELECT p.id, p.client_month_id, p.status
      FROM projects p
      WHERE p.client_id = ${clientId} AND ${projectScope(actor, 'p')}
    ),
    slots AS (
      SELECT v.client_month_id,
             count(d.id)::int AS deliverables,
             count(*) FILTER (WHERE d.status = 'delivered')::int AS completed,
             count(*) FILTER (WHERE d.status IN ('awaiting_lead_qa','awaiting_pm_qa'))::int AS in_qa,
             count(*) FILTER (WHERE d.status NOT IN ('approved','delivered'))::int AS pending
      FROM visible v
      LEFT JOIN deliverables d ON d.project_id = v.id AND d.status <> 'cancelled'
      GROUP BY v.client_month_id
    )
    SELECT cm.id, cm.period_year, cm.period_month, cm.status,
           to_char(cm.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS closed_at,
           closer.full_name AS closed_by,
           (SELECT count(*)::int FROM visible v WHERE v.client_month_id = cm.id) AS projects,
           COALESCE(s.deliverables, 0) AS deliverables,
           COALESCE(s.completed, 0) AS completed,
           COALESCE(s.in_qa, 0) AS in_qa,
           (SELECT count(*)::int FROM visible v
             WHERE v.client_month_id = cm.id AND v.status = 'revision_required') AS in_revision,
           COALESCE(s.pending, 0) AS pending,
           (SELECT array_agg(DISTINCT dep.name ORDER BY dep.name)
              FROM visible v
              JOIN project_departments pd ON pd.project_id = v.id
              JOIN departments dep ON dep.id = pd.department_id
             WHERE v.client_month_id = cm.id) AS departments
    FROM client_months cm
    LEFT JOIN slots s ON s.client_month_id = cm.id
    LEFT JOIN users closer ON closer.id = cm.closed_by
    WHERE cm.client_id = ${clientId}
    ORDER BY cm.period_year DESC, cm.period_month DESC
  `);

  return rows.map((r) => ({
    id: Number(r.id),
    year: Number(r.period_year),
    month: Number(r.period_month),
    status: r.status,
    closedAt: r.closed_at,
    closedBy: r.closed_by,
    projects: Number(r.projects),
    deliverables: Number(r.deliverables),
    completed: Number(r.completed),
    inQa: Number(r.in_qa),
    inRevision: Number(r.in_revision),
    pending: Number(r.pending),
    departments: r.departments ?? [],
  }));
}
