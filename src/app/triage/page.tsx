import Link from 'next/link';
import { requireActor } from '@/lib/auth/dal';
import { AccessDenied } from '@/components/access-denied';
import { AppShell } from '@/components/app-shell';
import { can } from '@/lib/authz';
import { formatMoney, formatMonth } from '@/lib/projects/intake';
import { intakeQueue } from '@/lib/projects/triage';
import { statusLabel } from '@/lib/workspace/format';

/**
 * The Project Manager's Project Closure Report (brief §4, §5) — the name the
 * client uses for the section where newly filed projects wait for routing,
 * and where projects under way that a team still holds up are listed
 * (lib/projects/triage). The page, the nav, the dashboard and the forms all
 * call it that; only the route (/triage) and the loader (intakeQueue) keep
 * the working name.
 */
export default async function TriagePage() {
  const actor = await requireActor();
  if (!can(actor, 'projects.triage')) {
    return (
      <AppShell actor={actor}>
        <AccessDenied what="the Project Closure Report" />
      </AppShell>
    );
  }

  const showPricing = can(actor, 'pricing.view');
  const rows = await intakeQueue(actor);

  return (
    <AppShell actor={actor}>
      <h1 className="text-lg font-semibold tracking-tight">Project Closure Report</h1>
      <p className="mt-1 max-w-prose text-sm text-muted">
        Newly filed projects waiting to be routed to a team, and projects already under way
        that a team still holds up: one without a lead, or one whose lead has planned nothing
        while the other teams’ work is done. A project cannot finish until every team has
        delivered or been dropped here. {rows.length} waiting.
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
                <th className="px-4 py-2.5 font-medium text-right">Deliverables</th>
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
                    <div className="font-mono text-xs text-muted">
                      {p.projectCode}
                      {/* Already under way: its status follows the work, not the routing. */}
                      {p.status === 'new' || p.status === 'awaiting_assignment'
                        ? null
                        : <span className="font-sans"> · {statusLabel(p.status)}</span>}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-muted">{p.clientName}</td>
                  <td className="px-4 py-2.5 text-muted">
                    {formatMonth(p.periodYear, p.periodMonth)}
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {p.teams ?? '—'}
                    {p.unassigned > 0 ? (
                      <span className="ml-2 text-xs text-accent">
                        {p.unassigned} without a lead
                      </span>
                    ) : null}
                    {p.unplanned > 0 && p.status !== 'new' && p.status !== 'awaiting_assignment' ? (
                      <span className="ml-2 text-xs text-accent">
                        {p.unplanned} with nothing planned
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted">{p.plannedTotal}</td>
                  <td className="px-4 py-2.5 capitalize">{p.priority}</td>
                  <td className="px-4 py-2.5 text-muted">{p.deadline ?? '—'}</td>
                  <td className="px-4 py-2.5 text-muted">{p.salesOwner ?? '—'}</td>
                  {showPricing ? (
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {formatMoney(p.priceAmount, p.priceCurrency)}
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
