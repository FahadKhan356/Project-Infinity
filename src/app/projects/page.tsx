import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { can, projectScope } from '@/lib/authz';
import { formatMoney, formatMonth } from '@/lib/projects/intake';

export default async function ProjectsPage() {
  const actor = await requireActor();
  const showPricing = can(actor, 'pricing.view');

  const rows = await getDb().execute<{
    id: number; project_code: string; title: string; status: string; priority: string;
    deadline: string | null; client_name: string; period_year: number; period_month: number;
    teams: string | null; price_amount: string | null; price_currency: string;
    total: number; approved: number;
  }>(sql`
    SELECT p.id, p.project_code, p.title, p.status, p.priority, p.deadline,
           c.name AS client_name, cm.period_year, cm.period_month,
           ${showPricing ? sql`p.price_amount` : sql`NULL::numeric`} AS price_amount,
           p.price_currency,
           (SELECT string_agg(d.name, ', ' ORDER BY d.sort_order)
              FROM project_departments pd JOIN departments d ON d.id = pd.department_id
             WHERE pd.project_id = p.id) AS teams,
           prog.total, prog.approved
    FROM projects p
    JOIN clients c        ON c.id = p.client_id
    JOIN client_months cm ON cm.id = p.client_month_id
    JOIN v_project_progress prog ON prog.project_id = p.id
    WHERE ${projectScope(actor, 'p')}
    ORDER BY p.created_at DESC
  `);

  return (
    <AppShell actor={actor}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-muted">{rows.length} project(s) visible to you</p>
        </div>
        {can(actor, 'projects.create') ? (
          <Link href="/projects/new" className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white">
            New project
          </Link>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="mt-6 rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">
          Nothing here yet.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Project</th>
                <th className="px-4 py-2.5 font-medium">Client</th>
                <th className="px-4 py-2.5 font-medium">Month</th>
                <th className="px-4 py-2.5 font-medium">Teams</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium text-right">Progress</th>
                <th className="px-4 py-2.5 font-medium">Deadline</th>
                {showPricing ? <th className="px-4 py-2.5 font-medium text-right">Price</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5">
                    <Link href={`/projects/${p.id}`} className="font-medium hover:underline">{p.title}</Link>
                    <div className="font-mono text-xs text-muted">{p.project_code}</div>
                  </td>
                  <td className="px-4 py-2.5 text-muted">{p.client_name}</td>
                  <td className="px-4 py-2.5 text-muted">
                    {formatMonth(Number(p.period_year), Number(p.period_month))}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{p.teams ?? '—'}</td>
                  <td className="px-4 py-2.5">{p.status.replace(/_/g, ' ')}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted">
                    {Number(p.approved)}/{Number(p.total)}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{p.deadline ?? '—'}</td>
                  {showPricing ? (
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {formatMoney(p.price_amount, p.price_currency)}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
