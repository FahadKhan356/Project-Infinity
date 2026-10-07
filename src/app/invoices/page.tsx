import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { requireActor } from '@/lib/auth/dal';
import { AccessDenied } from '@/components/access-denied';
import { AppShell } from '@/components/app-shell';
import { can, clientScope } from '@/lib/authz';
import { canManageInvoices, listInvoices, readyToInvoice, type InvoiceStatus } from '@/lib/invoices/invoices';
import { formatMoney, formatMonth } from '@/lib/projects/intake';
import { BlankDraftForm, DraftAllForm, DraftMonthButton } from './invoice-forms';
import { statusBadge } from './status-badge';

const STATUSES: { value: InvoiceStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' }, { value: 'draft', label: 'Drafts' }, { value: 'issued', label: 'Unpaid' },
  { value: 'paid', label: 'Paid' }, { value: 'void', label: 'Void' },
];


/** Invoices (brief §29): what is ready to bill, drafts to review, and the ledger. */
export default async function InvoicesPage(props: PageProps<'/invoices'>) {
  const actor = await requireActor();
  if (!canManageInvoices(actor)) return <AppShell actor={actor}><AccessDenied what="invoices" /></AppShell>;
  const { status: raw } = await props.searchParams;
  const status = STATUSES.some((s) => s.value === raw) && raw !== 'all' ? (raw as InvoiceStatus) : undefined;

  const [ready, invoices, clients] = await Promise.all([
    readyToInvoice(actor),
    listInvoices(actor, { status }),
    getDb().execute<{ id: number; name: string }>(sql`
      SELECT c.id, c.name FROM clients c WHERE ${clientScope(actor, 'c')} ORDER BY c.name`),
  ]);
  const now = new Date();
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const defaultPeriod = `${lastMonth.getUTCFullYear()}-${String(lastMonth.getUTCMonth() + 1).padStart(2, '0')}`;
  const outstanding = invoices.filter((i) => i.status === 'issued');

  return (
    <AppShell actor={actor}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Invoices</h1>
          <p className="mt-1 max-w-prose text-sm text-muted">
            Drafted from each month’s priced projects, so nothing is re-typed. A project is billed once. Issuing
            numbers and freezes an invoice; print it to PDF from its page.
          </p>
        </div>
        {can(actor, 'invoices.configure') ? (
          <Link href="/invoices/settings" className="rounded-md border border-border px-3 py-1.5 text-sm">Billing settings</Link>
        ) : null}
      </div>

      <section className="mt-6 rounded-lg border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold">Ready to invoice</h2>
        {ready.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Every priced project is on an invoice.</p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <tbody>
              {ready.map((r) => (
                <tr key={r.clientMonthId} className="border-t border-border first:border-0">
                  <td className="py-2"><Link href={`/clients/${r.clientId}`} className="font-medium hover:underline">{r.clientName}</Link></td>
                  <td className="py-2 text-muted">{formatMonth(r.period.year, r.period.month)}</td>
                  <td className="py-2 text-muted">{r.projects} project{r.projects === 1 ? '' : 's'}</td>
                  <td className="py-2 text-right tabular-nums">{formatMoney(r.amount, r.currency)}</td>
                  <td className="py-2 pl-3 text-right"><DraftMonthButton clientMonthId={r.clientMonthId} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-4 flex flex-wrap gap-6 border-t border-border pt-4">
          <DraftAllForm defaultPeriod={defaultPeriod} />
          <BlankDraftForm clients={clients.map((c) => ({ id: Number(c.id), name: c.name }))} />
        </div>
      </section>

      <section className="mt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <nav className="flex gap-1 text-sm" aria-label="Filter by status">
            {STATUSES.map((s) => (
              <Link key={s.value} href={s.value === 'all' ? '/invoices' : `/invoices?status=${s.value}`}
                className={`rounded-md px-2.5 py-1 ${(status ?? 'all') === s.value ? 'bg-surface font-medium' : 'text-muted hover:text-foreground'}`}>
                {s.label}
              </Link>
            ))}
          </nav>
          {outstanding.length > 0 && !status ? (
            <span className="text-sm text-muted">{outstanding.length} unpaid</span>
          ) : null}
        </div>
        {invoices.length === 0 ? (
          <p className="mt-3 rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">No invoices here.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <tr><th className="px-4 py-2.5 font-medium">Invoice</th><th className="px-4 py-2.5 font-medium">Client</th>
                  <th className="px-4 py-2.5 font-medium">Issued</th><th className="px-4 py-2.5 font-medium">Due</th>
                  <th className="px-4 py-2.5 text-right font-medium">Total</th><th className="px-4 py-2.5 font-medium">Status</th></tr>
              </thead>
              <tbody>
                {invoices.map((i) => {
                  const badge = statusBadge(i.status, i.overdue);
                  return (
                    <tr key={i.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5">
                        <Link href={`/invoices/${i.id}`} className="font-mono text-xs font-medium hover:underline">{i.invoiceNo ?? 'Draft'}</Link>
                        {i.period ? <div className="text-xs text-muted">{formatMonth(i.period.year, i.period.month)}</div> : null}
                      </td>
                      <td className="px-4 py-2.5">{i.clientName}</td>
                      <td className="px-4 py-2.5 text-muted">{i.issueDate ?? '—'}</td>
                      <td className="px-4 py-2.5 text-muted">{i.dueDate ?? '—'}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">{formatMoney(i.total, i.currency)}</td>
                      <td className="px-4 py-2.5"><span className={`rounded px-1.5 py-0.5 text-xs ${badge.className}`}>{badge.label}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </AppShell>
  );
}
