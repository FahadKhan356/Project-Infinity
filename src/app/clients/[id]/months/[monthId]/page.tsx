import Link from 'next/link';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { can, clientScope } from '@/lib/authz';
import { formatMonth } from '@/lib/projects/intake';
import { loadClientReport, periodValue } from '@/lib/reports/monthly';
import { ClientView } from '@/app/reports/client-view';

/**
 * A client's month, opened from the client page (brief §33, §36): the
 * projects, every deliverable slot and version with its QA verdicts, final
 * approved files, revisions, comments, people and delivery dates of that
 * period. The same loader as /reports, but not
 * behind that page's gate — a Team Lead or Executive reads here whatever
 * they can open, which is what §33 asks for before next month's work starts.
 */
export default async function ClientMonthPage(props: PageProps<'/clients/[id]/months/[monthId]'>) {
  const actor = await requireActor();
  const { id, monthId } = await props.params;
  const clientId = Number(id);
  const clientMonthId = Number(monthId);
  if (!Number.isInteger(clientId) || !Number.isInteger(clientMonthId)) notFound();

  // The month row names the period; the client must be visible for it to
  // exist at all, so a guessed id reads like a missing one.
  const [month] = await getDb().execute<{ period_year: number; period_month: number }>(sql`
    SELECT cm.period_year, cm.period_month
    FROM client_months cm JOIN clients c ON c.id = cm.client_id
    WHERE cm.id = ${clientMonthId} AND cm.client_id = ${clientId}
      AND ${clientScope(actor, 'c', { shared: true })}
  `);
  if (!month) notFound();

  const period = { year: Number(month.period_year), month: Number(month.period_month) };
  const report = await loadClientReport(actor, clientId, period);
  if (!report) notFound();

  return (
    <AppShell actor={actor}>
      <p className="text-xs text-muted">
        <Link href="/clients" className="hover:underline">Clients</Link>
        {' / '}
        <Link href={`/clients/${clientId}`} className="hover:underline">{report.client.name}</Link>
      </p>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h1 className="text-lg font-semibold tracking-tight">
          {report.client.name} — {formatMonth(period.year, period.month)}
        </h1>
        {can(actor, 'reports.export') ? (
          <Link href={`/reports/export?period=${periodValue(period)}&client=${clientId}`}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface">
            Export CSV
          </Link>
        ) : null}
      </div>
      <ClientView report={report} />
    </AppShell>
  );
}
