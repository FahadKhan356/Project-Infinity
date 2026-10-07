import Link from 'next/link';
import type { MonthBlock } from '@/lib/months/queries';
import { formatMoney, formatMonth } from '@/lib/projects/intake';
import { MonthControls } from './month-controls';

interface Props {
  clientId: number;
  block: MonthBlock;
  /** The §35 "Current month": tagged, and never tagged "open" as the previous ones are. */
  isCurrent: boolean;
  showPricing: boolean;
  showReports: boolean;
  canCopy: boolean;
  canClose: boolean;
  canReopen: boolean;
}

const tag = 'ml-2 rounded border border-border px-1.5 py-0.5 text-xs text-muted';
const th = 'px-4 py-2 text-xs font-medium text-muted';

/**
 * One month of a client's history (brief §35): its line, its controls, and
 * the table of the orders in it — project, team, status, progress. The
 * same card serves the current month on top, a month opened ahead, and
 * each month folded under "View previous months", where its status tag
 * (§36) is what tells them apart.
 */
export function MonthCard({
  clientId, block: { month: m, projects }, isCurrent, showPricing, showReports, canCopy, canClose, canReopen,
}: Props) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-2.5">
        <div>
          <h3 className="text-sm font-medium">
            {/* Opening a month shows everything delivered in it (§33). */}
            <Link href={`/clients/${clientId}/months/${m.id}`} className="hover:underline">
              {formatMonth(m.year, m.month)}
            </Link>
            {isCurrent ? <span className="ml-2 text-xs text-accent">current</span> : null}
            {m.status === 'closed' ? (
              <span className={tag}>
                {/* No closer means the nightly archive took it (§36). */}
                closed{m.closedBy ? ` by ${m.closedBy}` : ' automatically'}
              </span>
            ) : m.reopenedAt ? (
              <span className={tag}>
                {/* Management reopened it; the archive leaves it to be closed by hand (§36). */}
                reopened
              </span>
            ) : !isCurrent ? (
              /* A previous month still open says so, next to the closed ones (§36). */
              <span className={tag}>open</span>
            ) : null}
          </h3>
          <p className="mt-0.5 text-xs text-muted">
            {/* The list beneath keeps cancelled orders, marked, so the line says how many it holds apart. */}
            {m.projects} project{m.projects === 1 ? '' : 's'}
            {m.cancelled > 0 ? `, ${m.cancelled} cancelled` : ''}
            {m.deliverables > 0 ? (
              <>
                {' · '}<span className="tabular-nums">{m.completed}/{m.deliverables}</span> delivered
                {m.ready > 0 ? ` · ${m.ready} ready to deliver` : ''}
                {m.inQa > 0 ? ` · ${m.inQa} in QA` : ''}
                {m.inRevision > 0 ? ` · ${m.inRevision} in revision` : ''}
                {m.pending > 0 ? ` · ${m.pending} pending` : ''}
              </>
            ) : null}
            {m.departments.length > 0 ? ` · ${m.departments.join(', ')}` : ''}
          </p>
        </div>
        <div className="flex items-start gap-2">
          {showReports && m.projects > 0 ? (
            <Link href={`/reports?client=${clientId}&period=${m.year}-${String(m.month).padStart(2, '0')}`}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-background">
              Report
            </Link>
          ) : null}
          {canCopy && m.projects > 0 ? (
            <Link href={`/clients/${clientId}/months/${m.id}/copy`}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-background">
              Copy to next month →
            </Link>
          ) : null}
          <MonthControls clientMonthId={m.id} status={m.status} canClose={canClose} canReopen={canReopen} />
        </div>
      </div>

      {projects.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted">Nothing visible to you in this month.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th scope="col" className={th}>Project</th>
              <th scope="col" className={th}>Team</th>
              <th scope="col" className={th}>Status</th>
              <th scope="col" className={`${th} text-right`}>Progress</th>
              {showPricing ? <th scope="col" className={`${th} text-right`}>Price</th> : null}
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id} className="border-b border-border last:border-0">
                <td className="px-4 py-2.5">
                  <Link href={`/projects/${p.id}`}
                    className={`font-medium hover:underline${p.status === 'cancelled' ? ' text-muted line-through' : ''}`}>
                    {p.title}
                  </Link>
                  <div className="font-mono text-xs text-muted">{p.projectCode}</div>
                </td>
                <td className="px-4 py-2.5 text-muted">{p.teams ?? '—'}</td>
                <td className="px-4 py-2.5 text-muted">{p.status.replace(/_/g, ' ')}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted">
                  {/* Approved over all slots, and as the "70%" of §35; nothing while the order has no slots. */}
                  {p.percent === null ? '—' : (
                    <>
                      {p.approved}/{p.total}
                      <span className="text-muted/70"> · </span>
                      <span className="text-foreground">{p.percent}%</span>
                    </>
                  )}
                </td>
                {showPricing ? (
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {formatMoney(p.priceAmount, p.priceCurrency)}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
