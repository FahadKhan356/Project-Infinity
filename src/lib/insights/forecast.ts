import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { projectScope } from '@/lib/authz';
import { WINDOW_DAYS, forecastProject, type ProjectForecast, type TeamInput } from './forecast-core';

const LIVE = sql`('new','awaiting_assignment','planned','in_progress','qa','revision_required','approved','ready_for_delivery')`;

/**
 * Forecasts for the given live projects (or every live project the actor can
 * see), computed from one pass over the open work of every team involved.
 */
export async function forecasts(actor: Actor, projectIds?: number[]): Promise<Map<number, ProjectForecast & { projectCode: string; title: string }>> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const projects = await db.execute<{ id: number; project_code: string; title: string; deadline: string | null }>(sql`
    SELECT p.id, p.project_code, p.title, p.deadline::text AS deadline FROM projects p
    WHERE p.status IN ${LIVE} AND ${projectScope(actor, 'p')}
      ${projectIds ? (projectIds.length ? sql`AND p.id IN (${sql.join(projectIds.map((i) => sql`${i}`), sql`, `)})` : sql`AND FALSE`) : sql``}
  `);
  const result = new Map<number, ProjectForecast & { projectCode: string; title: string }>();
  if (projects.length === 0) return result;

  // Every open slot of every team, with its project's deadline: the queues.
  // Read across all projects on purpose — a team's queue includes work the
  // viewer cannot see — but only counts leave this function.
  const slots = await db.execute<{ project_id: number; department_id: number; deadline: string | null }>(sql`
    SELECT d.project_id, pd.department_id, p.deadline::text AS deadline
    FROM deliverables d
    JOIN project_departments pd ON pd.id = d.project_department_id
    JOIN projects p ON p.id = d.project_id
    WHERE d.status NOT IN ('approved','delivered','cancelled') AND p.status IN ${LIVE} AND p.status <> 'on_hold'
  `);
  const teams = await db.execute<{ project_id: number; department_id: number; name: string; planned: number; created: number }>(sql`
    SELECT pd.project_id, pd.department_id, dep.name, pd.planned_deliverables AS planned,
           (SELECT count(*) FROM deliverables d WHERE d.project_department_id = pd.id AND d.status <> 'cancelled')::int AS created
    FROM project_departments pd JOIN departments dep ON dep.id = pd.department_id
    WHERE pd.project_id IN (${sql.join(projects.map((p) => sql`${p.id}`), sql`, `)})
    ORDER BY dep.sort_order
  `);
  const pace = await db.execute<{ department_id: number; n: number }>(sql`
    SELECT pd.department_id, count(*)::int AS n
    FROM deliveries dl JOIN deliverables d ON d.id = dl.deliverable_id
    JOIN project_departments pd ON pd.id = d.project_department_id
    WHERE dl.approved_at > now() - make_interval(days => ${WINDOW_DAYS})
    GROUP BY pd.department_id
  `);
  const paceBy = new Map(pace.map((r) => [Number(r.department_id), Number(r.n)]));

  for (const p of projects) {
    const inputs: TeamInput[] = teams.filter((t) => Number(t.project_id) === Number(p.id)).map((t) => {
      const dept = Number(t.department_id);
      const own = slots.filter((s) => Number(s.project_id) === Number(p.id) && Number(s.department_id) === dept).length;
      const unopened = Math.max(0, Number(t.planned) - Number(t.created));
      const ahead = slots.filter((s) => Number(s.department_id) === dept && Number(s.project_id) !== Number(p.id)
        && s.deadline !== null && (p.deadline === null || s.deadline <= p.deadline)).length;
      return {
        departmentId: dept, name: t.name, remaining: own + unopened,
        ahead: ahead + own + unopened, approvedInWindow: paceBy.get(dept) ?? 0,
      };
    });
    result.set(Number(p.id), { ...forecastProject({ today, deadline: p.deadline, teams: inputs }), projectCode: p.project_code, title: p.title });
  }
  return result;
}
