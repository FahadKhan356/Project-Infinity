import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { requireActor } from '@/lib/auth/dal';
import { AccessDenied } from '@/components/access-denied';
import { AppShell } from '@/components/app-shell';
import { can, projectScope } from '@/lib/authz';
import { formatMoney, formatMonth } from '@/lib/projects/intake';

/**
 * The Project Manager's intake queue.
 *
 * The brief calls this the "Project Closure Report" (§4, §5), but what it
 * holds is newly filed projects awaiting routing. The name is flagged as an
 * open question in docs/phase-1a-plan.md; the heading below says both so the
 * client recognises it either way.
 */
export default async function TriagePage() {
  const actor = await requireActor();
  if (!can(actor, 'projects.triage')) {
    return (
      <AppShell actor={actor}>
        <AccessDenied what="project triage" />
      </AppShell>
    );
  }

  const showPricing = can(actor, 'pricing.view');

  const rows = await getDb().execute<{
    id: number; project_code: string; title: string; status: string; priority: string;
    deadline: string | null; client_name: string; period_year: number; period_month: number;
    sales_owner: string | null; price_amount: string | null; price_currency: string;
    teams: string | null; unassigned: number; created_at: Date;
  }>(sql`
    SELECT p.id, p.project_code, p.title, p.status, p.priority, p.deadline, p.created_at,
           c.name AS client_name, cm.period_year, cm.period_month,
           so.full_name AS sales_owner, p.price_currency,
           ${showPricing ? sql`p.price_amount` : sql`NULL::numeric`} AS price_amount,
           (SELECT string_agg(d.name, ', ' ORDER BY d.sort_order)
              FROM project_departments pd JOIN departments d ON d.id = pd.department_id
             WHERE pd.project_id = p.id) AS teams,
           (SELECT count(*) FROM project_departments pd
             WHERE pd.project_id = p.id AND pd.team_lead_id IS NULL)::int AS unassigned
    FROM projects p
    JOIN clients c        ON c.id = p.client_id
    JOIN client_months cm ON cm.id = p.client_month_id
    LEFT JOIN users so    ON so.id = p.sales_owner_id
    WHERE p.status IN ('new', 'awaiting_assignment') AND ${projectScope(actor, 'p')}
    ORDER BY
      CASE p.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      p.deadline NULLS LAST,
      p.created_at
  `);

  return (
    <AppShell actor={actor}>
      <h1 className="text-lg font-semibold tracking-tight">Project intake</h1>
      <p className="mt-1 max-w-prose text-sm text-muted">
        Newly filed projects waiting to be routed to a team. The brief calls this the
        Project Closure Report. {rows.length} waiting.
      </p>

      {rows.length === 0 ? (
        <p className="mt-6 rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">
          Nothing waiting. Newly filed projects appear here.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Project</th>
                <th className="px-4 py-2.5 font-medium">Client</th>
                <th className="px-4 py-2.5 font-medium">Month</th>
                <th className="px-4 py-2.5 font-medium">Teams requested</th>
                <th className="px-4 py-2.5 font-medium">Priority</th>
                <th className="px-4 py-2.5 font-medium">Deadline</th>
                <th className="px-4 py-2.5 font-medium">Filed by</th>
                {showPricing ? <th className="px-4 py-2.5 font-medium text-right">Price</th> : null}
                <th className="px-4 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5">
                    <Link href={`/projects/${p.id}#triage`} className="font-medium hover:underline">
                      {p.title}
                    </Link>
                    <div className="font-mono text-xs text-muted">{p.project_code}</div>
                  </td>
                  <td className="px-4 py-2.5 text-muted">{p.client_name}</td>
                  <td className="px-4 py-2.5 text-muted">
                    {formatMonth(Number(p.period_year), Number(p.period_month))}
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {p.teams ?? '—'}
                    {Number(p.unassigned) > 0 ? (
                      <span className="ml-2 text-xs text-accent">
                        {Number(p.unassigned)} without a lead
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 capitalize">{p.priority}</td>
                  <td className="px-4 py-2.5 text-muted">{p.deadline ?? '—'}</td>
                  <td className="px-4 py-2.5 text-muted">{p.sales_owner ?? '—'}</td>
                  {showPricing ? (
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {formatMoney(p.price_amount, p.price_currency)}
                    </td>
                  ) : null}
                  <td className="px-4 py-2.5 text-right">
                    <Link href={`/projects/${p.id}#triage`}
                      className="rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-white">
                      Route
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
