import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { getInvoice } from '@/lib/invoices/invoices';
import { formatMoney, formatMonth } from '@/lib/projects/intake';
import { DraftEditor, IssuedControls } from '../invoice-forms';
import { statusBadge } from '../status-badge';

export default async function InvoicePage(props: PageProps<'/invoices/[id]'>) {
  const actor = await requireActor();
  const { id } = await props.params;
  const invoice = Number.isInteger(Number(id)) ? await getInvoice(actor, Number(id)) : null;
  if (!invoice) notFound();
  const badge = statusBadge(invoice.status, invoice.overdue);

  return (
    <AppShell actor={actor}>
      <Link href="/invoices" className="text-sm text-muted hover:text-foreground">← Invoices</Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            {invoice.invoiceNo ?? 'Draft invoice'} <span className={`ml-2 rounded px-1.5 py-0.5 align-middle text-xs ${badge.className}`}>{badge.label}</span>
          </h1>
          <p className="mt-1 text-sm text-muted">
            <Link href={`/clients/${invoice.clientId}`} className="hover:underline">{invoice.client.name}</Link>
            {invoice.period ? ` · ${formatMonth(invoice.period.year, invoice.period.month)}` : ''}
            {invoice.issueDate ? ` · issued ${invoice.issueDate}, due ${invoice.dueDate}` : ''}
            {invoice.paidAt ? ` · paid ${invoice.paidAt}` : ''}
          </p>
        </div>
        {invoice.status !== 'draft' ? (
          <Link href={`/invoices/${invoice.id}/print`} target="_blank"
            className="rounded-md border border-border px-3 py-1.5 text-sm">Print / PDF</Link>
        ) : null}
      </div>
      {invoice.status === 'void' ? (
        <p role="status" className="mt-4 rounded-md border border-border bg-surface px-4 py-3 text-sm">
          Voided: {invoice.voidReason}. Its projects can be invoiced again; the number stays used.
        </p>
      ) : null}

      <div className="mt-6">
        {invoice.status === 'draft' ? (
          <DraftEditor invoiceId={invoice.id} lines={invoice.lines} vatRate={invoice.vatRate}
            currency={invoice.currency} notes={invoice.notes} />
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-border bg-surface">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                  <tr><th className="px-4 py-2.5 font-medium">Description</th><th className="px-4 py-2.5 text-right font-medium">Qty</th>
                    <th className="px-4 py-2.5 text-right font-medium">Unit price</th><th className="px-4 py-2.5 text-right font-medium">Amount</th></tr>
                </thead>
                <tbody>
                  {invoice.lines.map((l) => (
                    <tr key={l.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5">
                        {l.projectId ? <Link href={`/projects/${l.projectId}`} className="hover:underline">{l.description}</Link> : l.description}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{l.quantity}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">{formatMoney(l.unitPrice, invoice.currency)}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">{formatMoney(l.amount, invoice.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="mt-3 ml-auto w-72 space-y-1 text-sm tabular-nums">
              <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd>{formatMoney(invoice.subtotal, invoice.currency)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">VAT {invoice.vatRate}%</dt><dd>{formatMoney(invoice.vatAmount, invoice.currency)}</dd></div>
              <div className="flex justify-between font-semibold"><dt>Total</dt><dd>{formatMoney(invoice.total, invoice.currency)}</dd></div>
            </dl>
            {invoice.status === 'issued' || invoice.status === 'paid' ? (
              <div className="mt-6 border-t border-border pt-4">
                <IssuedControls invoiceId={invoice.id} status={invoice.status} today={new Date().toISOString().slice(0, 10)} />
              </div>
            ) : null}
          </>
        )}
      </div>
    </AppShell>
  );
}
