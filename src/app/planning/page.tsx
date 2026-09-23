import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { can } from '@/lib/authz';
import { formatMonth } from '@/lib/projects/intake';

/**
 * What a Team Lead has been handed (brief §6).
 *
 * M4 delivers the queue: the work routed to the teams this person leads, and
 * nothing from any other team. M5 turns it into the planning board with
 * members, dates and workload.
 */
export default async function PlanningPage() {
  const actor = await requireActor();
  const seesEverything = can(actor, 'planning.viewAllDepartments');

  const rows = await getDb().execute<{
    team_id: number; project_id: number; project_code: string; title: string; status: string; priority: string;
    deadline: string | null; client_name: string; period_year: number; period_month: number;
    department: string; team_lead: string | null; planned: number; slots: number; approved: number;
  }>(sql`
    SELECT pd.id AS team_id, p.id AS project_id, p.project_code, p.title, p.status, p.priority, p.deadline,
           c.name AS client_name, cm.period_year, cm.period_month,
           d.name AS department, tl.full_name AS team_lead,
           pd.planned_deliverables AS planned,
           (SELECT count(*) FROM deliverables dv
             WHERE dv.project_department_id = pd.id AND dv.status <> 'cancelled')::int AS slots,
           (SELECT count(*) FROM deliverables dv
             WHERE dv.project_department_id = pd.id AND dv.status IN ('approved','delivered'))::int AS approved
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

  return (
    <AppShell actor={actor}>
      <h1 className="text-lg font-semibold tracking-tight">Planning</h1>
      <p className="mt-1 max-w-prose text-sm text-muted">
        {seesEverything
          ? 'Work routed to every team.'
          : 'Work routed to the teams you lead. You do not see other teams’ rows.'}
      </p>

      {rows.length === 0 ? (
        <p className="mt-6 rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">
          Nothing routed to you yet. The Project Manager assigns work from the intake queue.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Project</th>
                <th className="px-4 py-2.5 font-medium">Client</th>
                <th className="px-4 py-2.5 font-medium">Month</th>
                <th className="px-4 py-2.5 font-medium">Team</th>
                {seesEverything ? <th className="px-4 py-2.5 font-medium">Lead</th> : null}
                <th className="px-4 py-2.5 font-medium text-right">Planned</th>
                <th className="px-4 py-2.5 font-medium text-right">Progress</th>
                <th className="px-4 py-2.5 font-medium">Deadline</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.team_id}-${i}`} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5">
                    <Link href={`/planning/${r.team_id}`} className="font-medium hover:underline">
                      {r.title}
                    </Link>
                    <div className="font-mono text-xs text-muted">{r.project_code}</div>
                  </td>
                  <td className="px-4 py-2.5 text-muted">{r.client_name}</td>
                  <td className="px-4 py-2.5 text-muted">
                    {formatMonth(Number(r.period_year), Number(r.period_month))}
                  </td>
                  <td className="px-4 py-2.5">
                    <Link href={`/planning/${r.team_id}`} className="hover:underline">{r.department}</Link>
                  </td>
                  {seesEverything ? (
                    <td className="px-4 py-2.5 text-muted">{r.team_lead ?? 'not assigned'}</td>
                  ) : null}
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted">{Number(r.planned)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted">
                    {Number(r.approved)}/{Number(r.slots)}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{r.deadline ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-xs text-muted">
        Open a row to see the team’s workload and assign work.
      </p>
    </AppShell>
  );
}
