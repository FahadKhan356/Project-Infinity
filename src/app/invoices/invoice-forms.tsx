'use client';

import { useActionState, useState } from 'react';
import {
  deleteDraftAction, draftAllAction, draftBlankAction, draftMonthAction, markPaidAction, saveDraftAction,
  saveSettingsAction, voidAction, type InvoiceFormState,
} from './actions';

const initial: InvoiceFormState = {};
const field = 'mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-accent';

function Result({ state }: { state: InvoiceFormState }) {
  if (state.error) return <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{state.error}</p>;
  if (state.notice) return <p role="status" className="mt-2 text-sm text-muted">{state.notice}</p>;
  return null;
}

export function DraftMonthButton({ clientMonthId }: { clientMonthId: number }) {
  const [state, action, pending] = useActionState(draftMonthAction, initial);
  return (
    <form action={action}>
      <input type="hidden" name="clientMonthId" value={clientMonthId} />
      <button type="submit" disabled={pending} className="rounded-md border border-border px-2.5 py-1 text-xs disabled:opacity-60">
        {pending ? 'Drafting…' : 'Draft invoice'}
      </button>
      <Result state={state} />
    </form>
  );
}

export function DraftAllForm({ defaultPeriod }: { defaultPeriod: string }) {
  const [state, action, pending] = useActionState(draftAllAction, initial);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <div>
        <label className="block text-xs font-medium" htmlFor="draft-period">Draft every client for</label>
        <input id="draft-period" type="month" name="period" defaultValue={defaultPeriod} required className={field} />
      </div>
      <button type="submit" disabled={pending} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60">
        {pending ? 'Drafting…' : 'Draft all'}
      </button>
      <div className="basis-full"><Result state={state} /></div>
    </form>
  );
}

export function BlankDraftForm({ clients }: { clients: { id: number; name: string }[] }) {
  const [state, action, pending] = useActionState(draftBlankAction, initial);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <div>
        <label className="block text-xs font-medium" htmlFor="blank-client">Or a blank invoice for</label>
        <select id="blank-client" name="clientId" required defaultValue="" className={field}>
          <option value="" disabled>Choose a client…</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <button type="submit" disabled={pending} className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-60">
        New draft
      </button>
      <div className="basis-full"><Result state={state} /></div>
    </form>
  );
}

interface Line { id?: number; key: string; description: string; quantity: number; unitPrice: number; projectCode?: string | null }

export function DraftEditor({ invoiceId, lines: initialLines, vatRate, currency, notes }: {
  invoiceId: number;
  lines: { id: number; description: string; quantity: number; unitPrice: number; projectCode: string | null }[];
  vatRate: number;
  currency: string;
  notes: string | null;
}) {
  const [state, action, pending] = useActionState(saveDraftAction, initial);
  const [delState, delAction, deleting] = useActionState(deleteDraftAction, initial);
  const [lines, setLines] = useState<Line[]>(initialLines.map((l) => ({ ...l, key: `l${l.id}` })));
  const [rate, setRate] = useState(vatRate);
  const update = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const subtotal = lines.reduce((s, l) => s + Math.round(l.quantity * l.unitPrice * 100) / 100, 0);
  const vat = Math.round(subtotal * rate) / 100;
  const money = (n: number) => `${currency} ${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div>
      <form action={action} className="rounded-lg border border-border bg-surface p-4">
        <input type="hidden" name="invoiceId" value={invoiceId} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr><th className="py-2 font-medium">Description</th><th className="w-24 py-2 font-medium">Qty</th>
                <th className="w-36 py-2 font-medium">Unit price</th><th className="w-32 py-2 text-right font-medium">Amount</th><th className="w-8" /></tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key} className="align-top">
                  <td className="py-1 pr-2">
                    <input type="hidden" name="lineId" value={l.id ?? ''} />
                    <input name="description" value={l.description} aria-label="Description" required
                      onChange={(e) => update(l.key, { description: e.target.value })} className={field} />
                    {l.projectCode ? <span className="text-xs text-muted">from {l.projectCode}</span> : null}
                  </td>
                  <td className="py-1 pr-2"><input name="quantity" type="number" min="0.01" step="0.01" value={l.quantity} aria-label="Quantity"
                    onChange={(e) => update(l.key, { quantity: Number(e.target.value) })} className={field} /></td>
                  <td className="py-1 pr-2"><input name="unitPrice" type="number" min="0" step="0.01" value={l.unitPrice} aria-label="Unit price"
                    onChange={(e) => update(l.key, { unitPrice: Number(e.target.value) })} className={field} /></td>
                  <td className="py-2 text-right tabular-nums">{money(Math.round(l.quantity * l.unitPrice * 100) / 100)}</td>
                  <td className="py-1 text-right">
                    <button type="button" aria-label="Remove line" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                      className="px-1 text-muted hover:text-red-600">×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="button" className="mt-2 text-sm text-accent hover:underline"
          onClick={() => setLines((ls) => [...ls, { key: `n${Date.now()}`, description: '', quantity: 1, unitPrice: 0 }])}>
          + Add a line
        </button>

        <div className="mt-4 grid gap-3 sm:grid-cols-[8rem_8rem_1fr]">
          <div>
            <label className="block text-xs font-medium" htmlFor="vatRate">VAT %</label>
            <input id="vatRate" name="vatRate" type="number" min="0" max="100" step="0.01" value={rate}
              onChange={(e) => setRate(Number(e.target.value))} className={field} />
          </div>
          <div>
            <label className="block text-xs font-medium" htmlFor="currency">Currency</label>
            <input id="currency" name="currency" defaultValue={currency} maxLength={3} className={field} />
          </div>
          <div>
            <label className="block text-xs font-medium" htmlFor="notes">Note on the invoice</label>
            <input id="notes" name="notes" defaultValue={notes ?? ''} className={field} />
          </div>
        </div>
        <dl className="mt-4 ml-auto w-64 space-y-1 text-sm tabular-nums">
          <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd>{money(subtotal)}</dd></div>
          <div className="flex justify-between"><dt className="text-muted">VAT {rate}%</dt><dd>{money(vat)}</dd></div>
          <div className="flex justify-between font-semibold"><dt>Total</dt><dd>{money(Math.round((subtotal + vat) * 100) / 100)}</dd></div>
        </dl>
        <Result state={state} />
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="submit" name="intent" value="save" disabled={pending}
            className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-60">Save draft</button>
          <button type="submit" name="intent" value="issue" disabled={pending}
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
            {pending ? 'Working…' : 'Save and issue'}
          </button>
        </div>
        <p className="mt-2 text-xs text-muted">Issuing gives the invoice its number and freezes it. After that it can only be voided.</p>
      </form>
      <form action={delAction} className="mt-3">
        <input type="hidden" name="invoiceId" value={invoiceId} />
        <button type="submit" disabled={deleting} className="text-xs text-muted hover:text-red-600">Delete this draft</button>
        <Result state={delState} />
      </form>
    </div>
  );
}

export function IssuedControls({ invoiceId, status, today }: { invoiceId: number; status: 'issued' | 'paid'; today: string }) {
  const [paidState, paidAction, paying] = useActionState(markPaidAction, initial);
  const [voidState, voidAct, voiding] = useActionState(voidAction, initial);
  return (
    <div className="flex flex-wrap items-start gap-6">
      {status === 'issued' ? (
        <form action={paidAction} className="flex items-end gap-2">
          <input type="hidden" name="invoiceId" value={invoiceId} />
          <div>
            <label className="block text-xs font-medium" htmlFor="paidOn">Paid on</label>
            <input id="paidOn" name="paidOn" type="date" defaultValue={today} className={field} />
          </div>
          <button type="submit" disabled={paying} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white">Mark paid</button>
          <Result state={paidState} />
        </form>
      ) : null}
      <details>
        <summary className="cursor-pointer text-sm text-muted hover:text-red-600">Void…</summary>
        <form action={voidAct} className="mt-2 flex items-end gap-2">
          <input type="hidden" name="invoiceId" value={invoiceId} />
          <input name="reason" required placeholder="Why?" aria-label="Reason" className={field} />
          <button type="submit" disabled={voiding} className="rounded-md border border-border px-3 py-1.5 text-sm">Void</button>
        </form>
        <Result state={voidState} />
      </details>
    </div>
  );
}

export function SettingsForm({ s }: { s: {
  companyName: string; companyAddress: string | null; taxRegistration: string | null; defaultVatRate: number;
  paymentTermsDays: number; paymentDetails: string | null; footerNote: string | null;
} }) {
  const [state, action, pending] = useActionState(saveSettingsAction, initial);
  return (
    <form action={action} className="max-w-xl space-y-3 rounded-lg border border-border bg-surface p-5">
      <div><label className="block text-xs font-medium" htmlFor="companyName">Company name</label>
        <input id="companyName" name="companyName" defaultValue={s.companyName} required className={field} /></div>
      <div><label className="block text-xs font-medium" htmlFor="companyAddress">Address</label>
        <textarea id="companyAddress" name="companyAddress" rows={3} defaultValue={s.companyAddress ?? ''} className={field} /></div>
      <div><label className="block text-xs font-medium" htmlFor="taxRegistration">Tax registration number (TRN)</label>
        <input id="taxRegistration" name="taxRegistration" defaultValue={s.taxRegistration ?? ''} className={field} /></div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="block text-xs font-medium" htmlFor="defaultVatRate">Default VAT %</label>
          <input id="defaultVatRate" name="defaultVatRate" type="number" min="0" max="100" step="0.01" defaultValue={s.defaultVatRate} className={field} /></div>
        <div><label className="block text-xs font-medium" htmlFor="paymentTermsDays">Payment terms (days)</label>
          <input id="paymentTermsDays" name="paymentTermsDays" type="number" min="0" max="365" defaultValue={s.paymentTermsDays} className={field} /></div>
      </div>
      <div><label className="block text-xs font-medium" htmlFor="paymentDetails">Payment details (bank, IBAN)</label>
        <textarea id="paymentDetails" name="paymentDetails" rows={3} defaultValue={s.paymentDetails ?? ''} className={field} /></div>
      <div><label className="block text-xs font-medium" htmlFor="footerNote">Footer note</label>
        <input id="footerNote" name="footerNote" defaultValue={s.footerNote ?? ''} className={field} /></div>
      <Result state={state} />
      <button type="submit" disabled={pending} className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white">Save</button>
    </form>
  );
}
