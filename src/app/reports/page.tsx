import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireActor } from '@/lib/auth/dal';
import { AccessDenied } from '@/components/access-denied';
import { AppShell } from '@/components/app-shell';
import { can } from '@/lib/authz';
import { formatMonth } from '@/lib/projects/intake';
import {
  canViewReports, loadClientReport, loadPortfolioReport, parsePeriod, periodValue, shiftPeriod,
  type Period, type PortfolioReport,
} from '@/lib/reports/monthly';
import { canViewProductivity } from '@/lib/reports/productivity';
import { BucketCells, BucketHeads, ClientView, DepartmentTable, Headline, Legend, money, td, tdNum, th, thNum } from './client-view';


function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}


function reportHref(period: Period, clientId: number | null): string {
  const q = new URLSearchParams({ period: periodValue(period) });
  if (clientId !== null) q.set('client', String(clientId));
  return `/reports?${q}`;
}

function exportHref(period: Period, clientId: number | null): string {
  return reportHref(period, clientId).replace('/reports?', '/reports/export?');
}

/**
 * Reports (brief §5, §39). A plain GET page: `?period=2026-09` for the month
 * across every client this person can see, `&client=12` for one client's
 * month — the §39 report with the §33 detail beneath it. Every figure is
 * scoped, so two people opening the same URL may see different numbers.
 */
export default async function ReportsPage(props: PageProps<'/reports'>) {
  const actor = await requireActor();
  if (!canViewReports(actor)) {
    return (
      <AppShell actor={actor}>
        <AccessDenied what="reports" />
      </AppShell>
    );
  }

  const params = await props.searchParams;
  const period = parsePeriod(one(params.period));
  const rawClient = one(params.client);
  const clientId = rawClient ? Number(rawClient) : null;
  if (clientId !== null && !(Number.isInteger(clientId) && clientId > 0)) notFound();

  const canExport = can(actor, 'reports.export');
  const client = clientId !== null ? await loadClientReport(actor, clientId, period) : null;
  if (clientId !== null && !client) notFound();
  const portfolio = client ? null : await loadPortfolioReport(actor, period);

  return (
    <AppShell actor={actor}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          {client ? (
            <p className="text-xs text-muted">
              <Link href={reportHref(period, null)} className="hover:underline">Reports</Link>
              {' / '}
              <Link href={`/clients/${client.client.id}`} className="hover:underline">{client.client.name}</Link>
            </p>
          ) : null}
          <h1 className="text-lg font-semibold tracking-tight">
            {client ? `${client.client.name} — ` : 'Monthly report — '}
            {formatMonth(period.year, period.month)}
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted">
            {client
              ? 'What was ordered and delivered for this client in the month. '
              : 'Work filed in the month, by client and by team. '}
            Figures cover only the projects you can open.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Link href={reportHref(shiftPeriod(period, -1), clientId)}
            className="rounded-md border border-border px-2.5 py-1.5 text-muted hover:text-foreground">
            ← Previous
          </Link>
          <form method="get" action="/reports" className="flex items-center gap-2">
            {clientId !== null ? <input type="hidden" name="client" value={clientId} /> : null}
            <input type="month" name="period" defaultValue={periodValue(period)} aria-label="Month"
              className="rounded-md border border-border bg-background px-2.5 py-1 text-sm outline-none focus:border-accent" />
            <button type="submit" className="rounded-md border border-border px-2.5 py-1.5 text-muted hover:text-foreground">
              Show
            </button>
          </form>
          <Link href={reportHref(shiftPeriod(period, 1), clientId)}
            className="rounded-md border border-border px-2.5 py-1.5 text-muted hover:text-foreground">
            Next →
          </Link>
          {canViewProductivity(actor) ? (
            <Link href={`/reports/productivity?period=${periodValue(period)}`}
              className="rounded-md border border-border px-2.5 py-1.5 text-muted hover:text-foreground">
              Productivity
            </Link>
          ) : null}
          {canExport ? (
            <a href={exportHref(period, clientId)} className="rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-white">
              Export CSV
            </a>
          ) : null}
        </div>
      </div>

      {client ? <ClientView report={client} /> : <PortfolioView report={portfolio!} />}
    </AppShell>
  );
}

function PortfolioView({ report }: { report: PortfolioReport }) {
  const { rows, totals, showPricing, period } = report;
  if (rows.length === 0) {
    return (
      <p className="mt-6 rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">
        No work filed for {formatMonth(period.year, period.month)} that you can see.
      </p>
    );
  }
  return (
    <>
      <Headline counts={totals} />
      <section className="mt-8">
        <h2 className="text-sm font-semibold">By client</h2>
        <div className="mt-3 overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className={th}>Client</th>
                <th className={thNum}>Projects</th>
                <BucketHeads />
                <th className={th}>Departments</th>
                {showPricing ? <th className={thNum}>Order value</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.clientId} className="border-b border-border">
                  <td className={td}>
                    <Link href={reportHref(period, r.clientId)} className="font-medium hover:underline">
                      {r.clientName}
                    </Link>
                  </td>
                  <td className={tdNum}>{r.projects}</td>
                  <BucketCells r={r} />
                  <td className={`${td} text-muted`}>{r.departments.join(', ') || '—'}</td>
                  {showPricing ? <td className={tdNum}>{money(r.value)}</td> : null}
                </tr>
              ))}
              <tr className="bg-background font-medium">
                <td className={td}>Total</td>
                <td className={tdNum}>{totals.projects}</td>
                <BucketCells r={totals} />
                <td className={`${td} text-muted`}>{totals.departments.join(', ') || '—'}</td>
                {showPricing ? <td className={tdNum}>{money(totals.value)}</td> : null}
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <DepartmentTable rows={report.departments} />
      <Legend />
    </>
  );
}

