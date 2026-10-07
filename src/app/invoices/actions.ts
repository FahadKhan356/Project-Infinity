'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { recordActivity } from '@/lib/auth/audit';
import { requireActor } from '@/lib/auth/dal';
import {
  InvoiceError, deleteDraft, draftAllForPeriod, draftBlank, draftFromMonth, issueInvoice, markPaid, saveDraft,
  updateBillingSettings, voidInvoice,
} from '@/lib/invoices/invoices';

export interface InvoiceFormState {
  error?: string;
  notice?: string;
}

const log = (actorId: number, action: string, entityId: number, metadata: Record<string, unknown> = {}) =>
  recordActivity({ actorId, action, entityType: 'invoice', entityId, metadata });

async function attempt(fn: () => Promise<InvoiceFormState | void>): Promise<InvoiceFormState> {
  try {
    return (await fn()) ?? {};
  } catch (error) {
    if (error instanceof InvoiceError) return { error: error.message };
    throw error;
  }
}

export async function draftMonthAction(_prev: InvoiceFormState, formData: FormData): Promise<InvoiceFormState> {
  const actor = await requireActor();
  let invoiceId = 0;
  const result = await attempt(async () => {
    invoiceId = (await draftFromMonth(actor, { clientMonthId: Number(formData.get('clientMonthId')) })).invoiceId;
  });
  if (result.error) return result;
  await log(actor.id, 'invoice.drafted', invoiceId);
  redirect(`/invoices/${invoiceId}`);
}

export async function draftAllAction(_prev: InvoiceFormState, formData: FormData): Promise<InvoiceFormState> {
  const actor = await requireActor();
  const match = /^(\d{4})-(\d{2})$/.exec(String(formData.get('period') ?? ''));
  if (!match) return { error: 'Choose a month.' };
  const r = await draftAllForPeriod(actor, { year: Number(match[1]), month: Number(match[2]) });
  for (const d of r.drafted) await log(actor.id, 'invoice.drafted', d.invoiceId, { automatic: true });
  revalidatePath('/invoices');
  const skipped = r.skipped.length ? ` Skipped: ${r.skipped.map((s) => `${s.clientName} (${s.reason})`).join('; ')}.` : '';
  return { notice: `${r.drafted.length} draft${r.drafted.length === 1 ? '' : 's'} created — review and issue each one.${skipped}` };
}

export async function draftBlankAction(_prev: InvoiceFormState, formData: FormData): Promise<InvoiceFormState> {
  const actor = await requireActor();
  let invoiceId = 0;
  const result = await attempt(async () => {
    invoiceId = (await draftBlank(actor, { clientId: Number(formData.get('clientId')) })).invoiceId;
  });
  if (result.error) return result;
  await log(actor.id, 'invoice.drafted', invoiceId);
  redirect(`/invoices/${invoiceId}`);
}

export async function saveDraftAction(_prev: InvoiceFormState, formData: FormData): Promise<InvoiceFormState> {
  const actor = await requireActor();
  const invoiceId = Number(formData.get('invoiceId'));
  const descriptions = formData.getAll('description').map(String);
  const quantities = formData.getAll('quantity').map(Number);
  const prices = formData.getAll('unitPrice').map(Number);
  const lineIds = formData.getAll('lineId').map(String);
  const lines = descriptions.map((description, i) => ({
    id: lineIds[i] ? Number(lineIds[i]) : undefined, description, quantity: quantities[i], unitPrice: prices[i],
  })).filter((l) => l.description.trim() !== '' || l.id !== undefined);
  const result = await attempt(() => saveDraft(actor, {
    invoiceId, lines, notes: String(formData.get('notes') ?? ''),
    vatRate: Number(formData.get('vatRate')), currency: String(formData.get('currency') ?? 'AED'),
  }));
  if (result.error) return result;
  if (formData.get('intent') === 'issue') {
    const issued = await attempt(async () => {
      const { invoiceNo } = await issueInvoice(actor, invoiceId);
      await log(actor.id, 'invoice.issued', invoiceId, { invoiceNo });
    });
    if (issued.error) return issued;
  }
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/invoices');
  return { notice: formData.get('intent') === 'issue' ? 'Issued.' : 'Saved.' };
}

export async function deleteDraftAction(_prev: InvoiceFormState, formData: FormData): Promise<InvoiceFormState> {
  const actor = await requireActor();
  const invoiceId = Number(formData.get('invoiceId'));
  const result = await attempt(() => deleteDraft(actor, invoiceId));
  if (result.error) return result;
  await log(actor.id, 'invoice.draft_deleted', invoiceId);
  redirect('/invoices');
}

export async function markPaidAction(_prev: InvoiceFormState, formData: FormData): Promise<InvoiceFormState> {
  const actor = await requireActor();
  const invoiceId = Number(formData.get('invoiceId'));
  const paidOn = String(formData.get('paidOn') ?? '');
  const result = await attempt(() => markPaid(actor, { invoiceId, paidOn }));
  if (result.error) return result;
  await log(actor.id, 'invoice.paid', invoiceId, { paidOn });
  revalidatePath(`/invoices/${invoiceId}`);
  return { notice: 'Marked paid.' };
}

export async function voidAction(_prev: InvoiceFormState, formData: FormData): Promise<InvoiceFormState> {
  const actor = await requireActor();
  const invoiceId = Number(formData.get('invoiceId'));
  const reason = String(formData.get('reason') ?? '');
  const result = await attempt(() => voidInvoice(actor, { invoiceId, reason }));
  if (result.error) return result;
  await log(actor.id, 'invoice.voided', invoiceId, { reason: reason.slice(0, 200) });
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/invoices');
  return { notice: 'Voided. Its projects can be invoiced again.' };
}

export async function saveSettingsAction(_prev: InvoiceFormState, formData: FormData): Promise<InvoiceFormState> {
  const actor = await requireActor();
  const text = (k: string) => String(formData.get(k) ?? '').trim() || null;
  const result = await attempt(() => updateBillingSettings(actor, {
    companyName: String(formData.get('companyName') ?? ''), companyAddress: text('companyAddress'),
    taxRegistration: text('taxRegistration'), defaultVatRate: Number(formData.get('defaultVatRate')),
    paymentTermsDays: Number(formData.get('paymentTermsDays')), paymentDetails: text('paymentDetails'),
    footerNote: text('footerNote'),
  }));
  if (result.error) return result;
  await recordActivity({ actorId: actor.id, action: 'billing.settings_changed', entityType: 'billing_settings', entityId: 1 });
  revalidatePath('/invoices/settings');
  return { notice: 'Saved. New drafts use these settings; issued invoices keep theirs.' };
}
