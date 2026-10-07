import Link from 'next/link';
import { requireClientActor } from '@/lib/auth/dal';
import { clientInvoices } from '@/lib/invoices/invoices';
import { portalClientName } from '@/lib/portal/portal';
import { formatMoney } from '@/lib/projects/intake';
import { PortalShell } from '../portal-shell';

/** A client's issued invoices, to view and print (brief §29). Drafts never appear. */
export default async function PortalInvoicesPage() {
  const actor = await requireClientActor();
  const [invoices, clientName] = await Promise.all([clientInvoices(actor), portalClientName(actor)]);
  return (
    <PortalShell actor={actor} clientName={clientName}>
      <Link href="/portal" className="text-sm text-muted hover:text-foreground">← All projects</Link>
      <h1 className="mt-2 text-lg font-semibold tracking-tight">Invoices</h1>
      {invoices.length === 0 ? (
        <p className="mt-4 rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">No invoices yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-border rounded-lg border border-border bg-surface text-sm">
          {invoices.map((i) => (
            <li key={i.id}>
              <Link href={`/portal/invoices/${i.id}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-background">
                <span><span className="font-mono text-xs font-medium">{i.invoiceNo}</span>
                  <span className="ml-2 text-muted">issued {i.issueDate}</span></span>
                <span className="flex items-center gap-3">
                  <span className="tabular-nums">{formatMoney(i.total, i.currency)}</span>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${i.status === 'paid'
                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                    : i.overdue ? 'bg-red-500/10 text-red-600' : 'bg-accent/10 text-accent'}`}>
                    {i.status === 'paid' ? 'Paid' : i.overdue ? `Overdue since ${i.dueDate}` : `Due ${i.dueDate}`}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PortalShell>
  );
}
