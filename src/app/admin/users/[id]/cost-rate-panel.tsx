'use client';

import { useActionState } from 'react';
import { deleteCostRate, saveCostRate, type CostFormState } from './cost-actions';

const initial: CostFormState = {};
const field =
  'mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent';

interface Rate { effectiveFrom: string; hourlyCost: number; currency: string; setBy: string }

/** Hourly cost history for one person. Only rendered for those who may see it. */
export function CostRatePanel({ userId, rates, today }: { userId: number; rates: Rate[]; today: string }) {
  const [state, action, pending] = useActionState(saveCostRate, initial);
  const [removeState, removeAction, removing] = useActionState(deleteCostRate, initial);
  const current = rates.find((r) => r.effectiveFrom <= today);

  return (
    <section className="mt-8 rounded-lg border border-border bg-surface p-6">
      <h2 className="text-sm font-semibold">Hourly cost</h2>
      <p className="mt-1 text-xs text-muted">
        Used to cost logged hours in the profitability report. Each hour is costed at the rate in force
        on the day it was worked. Visible to the CEO and COO only; the report shows project totals, never this rate.
      </p>
      <p className="mt-3 text-sm">
        {current
          ? <>Currently <span className="font-medium tabular-nums">{current.currency} {current.hourlyCost.toFixed(2)}</span> an hour, since {current.effectiveFrom}.</>
          : <span className="text-muted">No rate in force. Their hours are left out of project costs.</span>}
      </p>

      {rates.length > 0 ? (
        <ul className="mt-3 divide-y divide-border rounded-md border border-border text-sm">
          {rates.map((r) => (
            <li key={r.effectiveFrom} className="flex items-center justify-between px-3 py-2">
              <span>
                from {r.effectiveFrom}: <span className="tabular-nums">{r.currency} {r.hourlyCost.toFixed(2)}</span>
                <span className="text-xs text-muted"> · set by {r.setBy}</span>
              </span>
              <form action={removeAction}>
                <input type="hidden" name="userId" value={userId} />
                <input type="hidden" name="effectiveFrom" value={r.effectiveFrom} />
                <button type="submit" disabled={removing} className="text-xs text-muted hover:text-red-600">Remove</button>
              </form>
            </li>
          ))}
        </ul>
      ) : null}
      {removeState.error ? <p role="alert" className="mt-2 text-xs text-red-600">{removeState.error}</p> : null}

      <form action={action} className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_6rem_auto] sm:items-end">
        <input type="hidden" name="userId" value={userId} />
        <div>
          <label className="block text-xs font-medium" htmlFor="effectiveFrom">From</label>
          <input id="effectiveFrom" name="effectiveFrom" type="date" required defaultValue={today} className={field} />
        </div>
        <div>
          <label className="block text-xs font-medium" htmlFor="hourlyCost">Cost per hour</label>
          <input id="hourlyCost" name="hourlyCost" type="number" min={0} step="0.01" required className={field} />
        </div>
        <div>
          <label className="block text-xs font-medium" htmlFor="currency">Currency</label>
          <input id="currency" name="currency" defaultValue={current?.currency ?? 'AED'} maxLength={3} className={field} />
        </div>
        <button type="submit" disabled={pending}
          className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
          {pending ? 'Saving…' : 'Set rate'}
        </button>
      </form>
      {state.error ? <p role="alert" className="mt-3 text-sm text-red-600">{state.error}</p>
        : state.notice ? <p role="status" className="mt-3 text-sm text-muted">{state.notice}</p> : null}
    </section>
  );
}
