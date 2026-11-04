'use client';

import { useActionState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { addOpportunity, changeStage, editOpportunity, markLost, type PipelineFormState } from './actions';
import { PriceWithCurrencyField } from '@/components/currency-switcher';
import { normalizeCurrency } from '@/lib/currency';

const initial: PipelineFormState = {};
const field =
  'mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-accent';
const STAGES = [
  { value: 'lead', label: 'Lead' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'proposal', label: 'Proposal sent' },
  { value: 'negotiation', label: 'Negotiation' },
];

function Message({ state }: { state: PipelineFormState }) {
  if (state.error) return <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{state.error}</p>;
  if (state.notice) return <p role="status" className="mt-2 text-xs text-muted">{state.notice}</p>;
  return null;
}

export function NewOpportunityForm({ clients, canCreateClients }: {
  clients: { id: number; label: string }[];
  canCreateClients: boolean;
}) {
  const [state, action, pending] = useActionState(addOpportunity, initial);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { if (state.saved) form.current?.reset(); }, [state.saved]);

  return (
    <details className="rounded-lg border border-border bg-surface">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">+ New opportunity</summary>
      <form ref={form} action={action} className="border-t border-border p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium" htmlFor="opp-client">Client or prospect</label>
            <select id="opp-client" name="clientId" required defaultValue="" className={field}>
              <option value="" disabled>Choose…</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            {canCreateClients ? (
              <p className="mt-1 text-xs text-muted">
                New name? <Link href="/clients/new?prospect=1" className="underline">Add them as a prospect</Link> first,
                so the deal and its history stay on one client record.
              </p>
            ) : null}
          </div>
          <div>
            <label className="block text-xs font-medium" htmlFor="opp-title">What is being discussed</label>
            <input id="opp-title" name="title" required placeholder="Monthly social content retainer" className={field} />
          </div>
          <div>
            <PriceWithCurrencyField
              amountId="opp-value"
              amountName="estimatedValue"
              currencyName="currency"
              label="Estimated value"
              defaultCurrency="USD"
              compact
            />
          </div>
          <div>
            <label className="block text-xs font-medium" htmlFor="opp-close">Expected to close</label>
            <input id="opp-close" name="expectedClose" type="date" className={field} />
          </div>
          <div>
            <label className="block text-xs font-medium" htmlFor="opp-stage">Stage</label>
            <select id="opp-stage" name="stage" defaultValue="lead" className={field}>
              {STAGES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium" htmlFor="opp-notes">Notes</label>
            <input id="opp-notes" name="notes" className={field} />
          </div>
        </div>
        <Message state={state} />
        <button type="submit" disabled={pending}
          className="mt-3 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60">
          {pending ? 'Adding…' : 'Add to pipeline'}
        </button>
      </form>
    </details>
  );
}

export function CardControls({ opportunity: o, canFile }: {
  opportunity: { id: number; stage: string; title: string; estimatedValue: number | null; currency?: string; expectedClose: string | null; notes: string | null };
  canFile: boolean;
}) {
  const [moveState, moveAction, moving] = useActionState(changeStage, initial);
  const [editState, editAction, editing] = useActionState(editOpportunity, initial);
  const [lostState, lostAction, losing] = useActionState(markLost, initial);

  return (
    <div className="mt-3 space-y-2 border-t border-border pt-2">
      <form action={moveAction} className="flex items-center gap-1.5">
        <input type="hidden" name="id" value={o.id} />
        <label className="sr-only" htmlFor={`stage-${o.id}`}>Stage</label>
        <select id={`stage-${o.id}`} name="stage" defaultValue={o.stage}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 py-1 text-xs">
          {STAGES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <button type="submit" disabled={moving} className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-60">
          Move
        </button>
      </form>
      <Message state={moveState} />
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {canFile ? (
          <Link href={`/projects/new?opportunity=${o.id}`} className="font-medium text-accent hover:underline">
            Won — file project →
          </Link>
        ) : null}
        <details>
          <summary className="cursor-pointer text-muted hover:text-foreground">Edit</summary>
          <form action={editAction} className="mt-2 space-y-1.5">
            <input type="hidden" name="id" value={o.id} />
            <input name="title" required defaultValue={o.title} aria-label="Title" className={field} />
            <div className="flex gap-1.5">
              <select name="currency" defaultValue={normalizeCurrency(o.currency)} aria-label="Currency"
                className="mt-1 w-20 rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-accent">
                <option value="USD">USD</option>
                <option value="PKR">PKR</option>
              </select>
              <input name="estimatedValue" type="number" min={0} step="0.01" aria-label="Estimated value"
                defaultValue={o.estimatedValue ?? ''} className={field} />
            </div>
            <input name="expectedClose" type="date" aria-label="Expected to close" defaultValue={o.expectedClose ?? ''} className={field} />
            <input name="notes" aria-label="Notes" defaultValue={o.notes ?? ''} className={field} />
            <button type="submit" disabled={editing} className="rounded-md border border-border px-2 py-1 text-xs">Save</button>
            <Message state={editState} />
          </form>
        </details>
        <details>
          <summary className="cursor-pointer text-muted hover:text-red-600">Lost</summary>
          <form action={lostAction} className="mt-2 space-y-1.5">
            <input type="hidden" name="id" value={o.id} />
            <input name="reason" required placeholder="Why? (price, timing, went elsewhere…)" aria-label="Reason" className={field} />
            <button type="submit" disabled={losing} className="rounded-md border border-border px-2 py-1 text-xs">Mark lost</button>
            <Message state={lostState} />
          </form>
        </details>
      </div>
    </div>
  );
}
