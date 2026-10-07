import { notFound } from 'next/navigation';
import { requireActor } from '@/lib/auth/dal';
import { InvoiceDocument } from '@/components/invoice-document';
import { PrintButton } from '@/components/print-button';
import { billingSettings, getInvoice } from '@/lib/invoices/invoices';

/** The invoice alone, for printing or saving as PDF. Drafts have no printable form. */
export default async function InvoicePrintPage(props: PageProps<'/invoices/[id]/print'>) {
  const actor = await requireActor();
  const { id } = await props.params;
  const invoice = Number.isInteger(Number(id)) ? await getInvoice(actor, Number(id)) : null;
  if (!invoice || invoice.status === 'draft') notFound();
  return (
    <div className="min-h-svh bg-white py-8 print:py-0">
      <PrintButton />
      <InvoiceDocument invoice={invoice} settings={await billingSettings()} />
    </div>
  );
}
