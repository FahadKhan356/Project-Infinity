import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireClientActor } from '@/lib/auth/dal';
import { InvoiceDocument } from '@/components/invoice-document';
import { PrintButton } from '@/components/print-button';
import { billingSettings, getClientInvoice } from '@/lib/invoices/invoices';

export default async function PortalInvoicePage(props: PageProps<'/portal/invoices/[id]'>) {
  const actor = await requireClientActor();
  const { id } = await props.params;
  const invoice = Number.isInteger(Number(id)) ? await getClientInvoice(actor, Number(id)) : null;
  if (!invoice) notFound();
  return (
    <div className="min-h-svh bg-white py-8 print:py-0">
      <div className="mx-auto mb-2 max-w-3xl px-4 print:hidden">
        <Link href="/portal/invoices" className="text-sm text-gray-600 hover:underline">← Invoices</Link>
      </div>
      <PrintButton />
      <InvoiceDocument invoice={invoice} settings={await billingSettings()} />
    </div>
  );
}
