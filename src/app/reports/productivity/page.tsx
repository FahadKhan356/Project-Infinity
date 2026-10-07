import Link from 'next/link';
import { requireActor } from '@/lib/auth/dal';
import { AccessDenied } from '@/components/access-denied';
import { AppShell } from '@/components/app-shell';
import { formatMoney, formatMonth } from '@/lib/projects/intake';
import { parsePeriod, periodValue, shiftPeriod, type Period } from '@/lib/reports/monthly';
import {
  canViewProductivity, loadProductivityReport, rate, type PerformanceFigures,
} from '@/lib/reports/productivity';
import { formatMinutes } from '@/lib/time/format';
import { statusLabel } from '@/lib/workspace/format';

const th = 'px-3 py-2.5 font-medium';
const thNum = 'px-3 py-2.5 font-medium text-right';
const td = 'px-3 py-2.5';
const tdNum = 'px-3 py-2.5 text-right tabular-nums whitespace-nowrap';
const table = 'w-full text-sm';
const wrap = 'mt-3 overflow-x-auto rounded-lg border border-border bg-surface';
const head = 'border-b border-border text-left text-xs uppercase tracking-wide text-muted';

const href = (p: Period) => `/reports/productivity?period=${periodValue(p)}`;
const hours = (m: number) => (m === 0 ? '—' : formatMinutes(m));

/**
 * Employee productivity, team performance and profitability (brief §29), by
 * month. A plain GET page like /reports; every figure is scoped to the teams
 * the viewer may see.
 */
export default async function ProductivityPage(props: PageProps<'/reports/productivity'>) {
  const actor = await requireActor();
  if (!canViewProductivity(actor)) {
    return <AppShell actor={actor}><AccessDenied what="productivity reports" /></AppShell>;
  }
  const params = await props.searchParams;
  const period = parsePeriod(Array.isArray(params.period) ? params.period[0] : params.period);
  const report = (await loadProductivityReport(actor, period))!;

  return (
    <AppShell actor={actor}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Productivity — {formatMonth(period.year, period.month)}
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted">
            Read from what the portal records: hours logged, files uploaded and the QA decisions on
            them. {report.allTeams ? 'Every team.' : 'Your teams only.'} A figure belongs to the month
            it happened in.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Link href={href(shiftPeriod(period, -1))}
            className="rounded-md border border-border px-2.5 py-1.5 text-muted hover:text-foreground">← Previous</Link>
          <form method="get" action="/reports/productivity" className="flex items-center gap-2">
            <input type="month" name="period" defaultValue={periodValue(period)} aria-label="Month"
              className="rounded-md border border-border bg-background px-2.5 py-1 text-sm outline-none focus:border-accent" />
            <button type="submit" className="rounded-md border border-border px-2.5 py-1.5 text-muted hover:text-foreground">Show</button>
          </form>
          <Link href={href(shiftPeriod(period, 1))}
            className="rounded-md border border-border px-2.5 py-1.5 text-muted hover:text-foreground">Next →</Link>
        </div>
      </div>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Team performance</h2>
        <div className={wrap}>
          <table className={table}>
            <thead className={head}>
              <tr>
                <th className={th}>Team</th>
                <th className={thNum}>People</th>
                <FigureHeads />
              </tr>
            </thead>
            <tbody>
              {report.teams.map((t) => (
                <tr key={t.departmentId} className="border-b border-border last:border-0">
                  <td className={`${td} font-medium`}>{t.name}</td>
                  <td className={tdNum}>{t.members}</td>
                  <FigureCells f={t} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">People</h2>
        <p className="mt-1 text-xs text-muted">
          Approved files are credited to whoever uploaded the version that cleared QA.
        </p>
        <div className={wrap}>
          <table className={table}>
            <thead className={head}>
              <tr>
                <th className={th}>Person</th>
                <FigureHeads />
              </tr>
            </thead>
            <tbody>
              {report.people.length === 0 ? (
                <tr><td className={`${td} text-muted`} colSpan={9}>Nobody in these teams yet.</td></tr>
              ) : report.people.map((p) => (
                <tr key={p.userId} className="border-b border-border last:border-0">
                  <td className={td}>
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-muted">{p.teams || statusLabel(p.role)}</div>
                  </td>
                  <FigureCells f={p} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {report.profitability ? (
        <section className="mt-8">
          <h2 className="text-sm font-semibold">Profitability</h2>
          <p className="mt-1 max-w-prose text-xs text-muted">
            Projects filed in {formatMonth(period.year, period.month)}, with every hour logged on them so far.
            Each hour is costed at its person’s rate on the day it was worked. Hours logged by someone
            with no rate are marked, because the cost leaves them out. Visible only to roles that see pricing.
          </p>
          <div className={wrap}>
            <table className={table}>
              <thead className={head}>
                <tr>
                  <th className={th}>Project</th>
                  <th className={th}>Status</th>
                  <th className={thNum}>Price</th>
                  <th className={thNum}>Estimated</th>
                  <th className={thNum}>Logged</th>
                  <th className={thNum}>Per hour</th>
                  <th className={thNum}>Cost</th>
                  <th className={thNum}>Margin</th>
                  <th className={thNum}>Approved</th>
                </tr>
              </thead>
              <tbody>
                {report.profitability.length === 0 ? (
                  <tr><td className={`${td} text-muted`} colSpan={9}>No projects filed this month.</td></tr>
                ) : report.profitability.map((r) => (
                  <tr key={r.projectId} className="border-b border-border last:border-0">
                    <td className={td}>
                      <Link href={`/projects/${r.projectId}`} className="font-medium hover:underline">{r.title}</Link>
                      <div className="text-xs text-muted"><span className="font-mono">{r.projectCode}</span> · {r.clientName}</div>
                    </td>
                    <td className={`${td} text-muted`}>{statusLabel(r.status)}</td>
                    <td className={tdNum}>{formatMoney(r.priceAmount, r.currency)}</td>
                    <td className={tdNum}>{hours(r.estimatedMinutes)}</td>
                    <td className={tdNum}>
                      {hours(r.loggedMinutes)}
                      {r.estimatedMinutes > 0 && r.loggedMinutes > r.estimatedMinutes ? (
                        <div className="text-xs text-red-600 dark:text-red-400">over estimate</div>
                      ) : null}
                    </td>
                    <td className={tdNum}>{r.valuePerHour === null ? '—' : formatMoney(r.valuePerHour, r.currency)}</td>
                    <td className={tdNum}>
                      {r.loggedMinutes === 0 ? '—' : formatMoney(r.cost, r.currency)}
                      {r.unratedMinutes > 0 ? (
                        <div className="text-xs text-amber-700 dark:text-amber-400">{formatMinutes(r.unratedMinutes)} without a rate</div>
                      ) : null}
                    </td>
                    <td className={`${tdNum} ${r.margin !== null && r.margin < 0 ? 'text-red-600 dark:text-red-400' : ''}`}>
                      {r.margin === null || r.loggedMinutes === 0 ? '—' : formatMoney(r.margin, r.currency)}
                      {r.margin !== null && r.priceAmount && r.loggedMinutes > 0 ? (
                        <div className="text-xs text-muted">{Math.round((r.margin / r.priceAmount) * 100)}%</div>
                      ) : null}
                    </td>
                    <td className={tdNum}>{r.approved}/{r.deliverables}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </AppShell>
  );
}

function FigureHeads() {
  return (
    <>
      <th className={thNum}>Hours</th>
      <th className={thNum}>Uploads</th>
      <th className={thNum}>Approved</th>
      <th className={thNum} title="Approved without being sent back">First pass</th>
      <th className={thNum} title="Approved by the slot's due date">On time</th>
      <th className={thNum} title="QA decisions on their files, and how many sent it back">Sent back</th>
      <th className={thNum} title="Finished assignments with an estimate">Est. vs actual</th>
    </>
  );
}

function FigureCells({ f }: { f: PerformanceFigures }) {
  return (
    <>
      <td className={tdNum}>{hours(f.minutes)}</td>
      <td className={tdNum}>{f.uploads}</td>
      <td className={tdNum}>{f.approved}</td>
      <td className={tdNum}>{rate(f.firstPass, f.approved)}</td>
      <td className={tdNum}>{rate(f.onTime, f.withDueDate)}</td>
      <td className={tdNum}>{f.reviews === 0 ? '—' : `${f.sentBack} of ${f.reviews}`}</td>
      <td className={tdNum}>
        {f.finishedWithEstimate === 0 ? '—' : `${formatMinutes(f.estimatedMinutes)} / ${formatMinutes(f.actualMinutes)}`}
      </td>
    </>
  );
}
