import type { BillingSettings, InvoiceDetail } from '@/lib/invoices/invoices';
import { formatMoney } from '@/lib/projects/intake';

/**
 * The printable invoice: plain, black on white in print whatever the theme,
 * so "Print → Save as PDF" in any browser gives the document — offline.
 */
export function InvoiceDocument({ invoice, settings }: { invoice: InvoiceDetail; settings: BillingSettings }) {
  return (
    <article className="mx-auto max-w-3xl bg-white p-10 text-sm text-black print:p-0">
      <header className="flex flex-wrap justify-between gap-6">
        <div>
          <div className="text-xl font-semibold">{settings.companyName}</div>
          {settings.companyAddress ? <div className="mt-1 whitespace-pre-line text-gray-600">{settings.companyAddress}</div> : null}
          {settings.taxRegistration ? <div className="mt-1 text-gray-600">TRN {settings.taxRegistration}</div> : null}
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold tracking-tight">{invoice.vatRate > 0 ? 'Tax invoice' : 'Invoice'}</div>
          <div className="mt-1 font-mono">{invoice.invoiceNo}</div>
          <div className="mt-2 text-gray-600">Issued {invoice.issueDate}</div>
          <div className="text-gray-600">Due {invoice.dueDate}</div>
          {invoice.status === 'paid' ? <div className="mt-1 font-semibold">Paid {invoice.paidAt}</div> : null}
          {invoice.status === 'void' ? <div className="mt-1 font-semibold">VOID — {invoice.voidReason}</div> : null}
        </div>
      </header>
      <section className="mt-8">
        <div className="text-xs uppercase tracking-wide text-gray-500">Bill to</div>
        <div className="mt-1 font-medium">{invoice.client.companyName || invoice.client.name}</div>
        {invoice.client.companyName && invoice.client.companyName !== invoice.client.name
          ? <div className="text-gray-600">{invoice.client.name}</div> : null}
      </section>
      <table className="mt-8 w-full border-collapse">
        <thead>
          <tr className="border-b-2 border-black text-left text-xs uppercase tracking-wide">
            <th className="py-2 font-medium">Description</th><th className="py-2 text-right font-medium">Qty</th>
            <th className="py-2 text-right font-medium">Unit price</th><th className="py-2 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((l) => (
            <tr key={l.id} className="border-b border-gray-300">
              <td className="py-2 pr-4">{l.description}</td>
              <td className="py-2 text-right tabular-nums">{l.quantity}</td>
              <td className="whitespace-nowrap py-2 text-right tabular-nums">{formatMoney(l.unitPrice, invoice.currency)}</td>
              <td className="whitespace-nowrap py-2 text-right tabular-nums">{formatMoney(l.amount, invoice.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="mt-4 ml-auto w-72 space-y-1 tabular-nums">
        <div className="flex justify-between"><dt>Subtotal</dt><dd>{formatMoney(invoice.subtotal, invoice.currency)}</dd></div>
        <div className="flex justify-between"><dt>VAT {invoice.vatRate}%</dt><dd>{formatMoney(invoice.vatAmount, invoice.currency)}</dd></div>
        <div className="flex justify-between border-t-2 border-black pt-1 text-base font-semibold"><dt>Total</dt><dd>{formatMoney(invoice.total, invoice.currency)}</dd></div>
      </dl>
      {invoice.notes ? <p className="mt-8">{invoice.notes}</p> : null}
      {settings.paymentDetails ? (
        <section className="mt-8">
          <div className="text-xs uppercase tracking-wide text-gray-500">Payment details</div>
          <div className="mt-1 whitespace-pre-line">{settings.paymentDetails}</div>
        </section>
      ) : null}
      {settings.footerNote ? <footer className="mt-10 text-xs text-gray-500">{settings.footerNote}</footer> : null}
    </article>
  );
}
