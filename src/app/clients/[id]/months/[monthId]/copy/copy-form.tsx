'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { copyClientMonth, type ClientFormState } from '@/app/clients/actions';
import { PriceWithCurrencyField } from '@/components/currency-switcher';
import type { CopyPlan } from '@/lib/months/copy';

const initial: ClientFormState = {};
const field =
  'mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent';
const card = 'rounded-lg border border-border bg-surface p-5';

/**
 * "Copy August → September" (brief §38). Every project in the source month
 * is listed, ticked, with the parts Sales may change laid out as fields.
 * Untick a project to leave it behind; untick a team to drop it from the
 * copy. Files and deliverables are not on offer — only the orders are.
 *
 * The target month is chosen outside the copy form: changing it reloads
 * the page with `?to=`, so the plan — suggested deadlines, the month's
 * status — is built for the month actually chosen, and the copy form
 * submits exactly that month.
 */
export function CopyMonthForm({
  plan, canSetPricing, monthError = null,
}: {
  plan: CopyPlan;
  canSetPricing: boolean;
  /** Why the `?to=` asked for was not taken; the plan is then for the default month. */
  monthError?: string | null;
}) {
  const [state, formAction, pending] = useActionState(copyClientMonth, initial);
  const router = useRouter();
  const targetClosed = plan.target.status === 'closed';
  const pagePath = `/clients/${plan.clientId}/months/${plan.source.id}/copy`;

  return (
    <div className="space-y-4">
      <form method="get" action={pagePath} className={card}>
        <label className="block text-sm font-medium" htmlFor="to">Copy into</label>
        <div className="flex flex-wrap items-end gap-2">
          {/* Browsers that render type="month" as plain text hold the value to the pattern. */}
          <input id="to" name="to" type="month" required defaultValue={plan.target.value}
            min="2020-01" max="2100-12" pattern="[0-9]{4}-[0-9]{2}" title="A month as YYYY-MM"
            className={`${field} max-w-xs`}
            onChange={(e) => {
              const value = e.currentTarget.value;
              if (/^\d{4}-\d{2}$/.test(value) && value !== plan.target.value) router.replace(`${pagePath}?to=${value}`);
            }} />
          <button type="submit" className="rounded-md border border-border px-3 py-2 text-sm font-medium">
            Change month
          </button>
        </div>
        {monthError ? (
          <p role="alert" className="mt-1.5 text-xs text-red-600 dark:text-red-400">{monthError}</p>
        ) : null}
        <p className="mt-1.5 text-xs text-muted">
          {plan.target.status === null
            ? `${plan.target.label} will be opened for ${plan.clientName} as part of the copy.`
            : targetClosed
              ? `${plan.target.label} is closed. Reopen it, or choose another month.`
              : `${plan.target.label} is already open; the copies are added to it.`}
          {' '}Deadlines below are suggested for {plan.target.label}.
        </p>
      </form>

    <form action={formAction} className="space-y-4">
      <input type="hidden" name="clientId" value={plan.clientId} />
      <input type="hidden" name="fromMonthId" value={plan.source.id} />
      <input type="hidden" name="period" value={plan.target.value} />

      {plan.projects.length === 0 ? (
        <p className={`${card} text-sm text-muted`}>
          Nothing visible to you in {plan.source.label} to copy.
        </p>
      ) : (
        plan.projects.map((p) => (
          <section key={p.id} className={card}>
            <label className="flex items-start gap-3">
              <input type="checkbox" name="project" value={p.id} defaultChecked className="mt-1" />
              <span>
                <span className="text-sm font-medium">{p.title}</span>
                <span className="ml-2 font-mono text-xs text-muted">{p.projectCode}</span>
                {p.projectType ? <span className="ml-2 text-xs text-muted">{p.projectType}</span> : null}
                <span className="mt-0.5 block text-xs text-muted">
                  Objective, description, PO, priority and QA policy are copied as they are.
                </span>
              </span>
            </label>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium" htmlFor={`title_${p.id}`}>Project name</label>
                <input id={`title_${p.id}`} name={`title_${p.id}`} defaultValue={p.title} className={field} />
              </div>

              <div className="sm:col-span-2">
                <span className="block text-xs font-medium">Teams and deliverables</span>
                <ul className="mt-1.5 grid gap-2 sm:grid-cols-2">
                  {plan.availableDepartments.map((dept) => {
                    const onSource = p.departments.find((d) => d.departmentId === dept.id) ?? null;
                    return (
                      <li key={dept.id} className={`flex items-center gap-2 ${onSource ? '' : 'text-muted'}`}>
                        <input type="checkbox" name={`dept_${p.id}`} value={dept.id} defaultChecked={onSource !== null}
                          id={`dept_${p.id}_${dept.id}`} />
                        <label htmlFor={`dept_${p.id}_${dept.id}`} className="w-28 text-sm">
                          {dept.name}{onSource ? '' : <span className="ml-1 text-xs">(add)</span>}
                        </label>
                        <input type="number" min={0} max={500} name={`planned_${p.id}_${dept.id}`}
                          defaultValue={onSource?.plannedDeliverables ?? 0} aria-label={`${dept.name} deliverables`}
                          className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm tabular-nums" />
                      </li>
                    );
                  })}
                </ul>
              </div>

              <div>
                <label className="block text-xs font-medium" htmlFor={`deadline_${p.id}`}>Deadline</label>
                <input id={`deadline_${p.id}`} name={`deadline_${p.id}`} type="date"
                  defaultValue={p.suggestedDeadline ?? ''} className={field} />
                {p.deadline ? (
                  <p className="mt-1 text-xs text-muted">Was {p.deadline}; moved forward by the same gap.</p>
                ) : null}
              </div>

              {canSetPricing ? (
                <div>
                  <PriceWithCurrencyField
                    amountId={`price_${p.id}`}
                    amountName={`price_${p.id}`}
                    currencyName={`currency_${p.id}`}
                    label="Price"
                    defaultAmount={p.priceAmount ?? ''}
                    defaultCurrency={p.priceCurrency}
                    compact
                  />
                </div>
              ) : null}

              <div className="sm:col-span-2">
                <label className="block text-xs font-medium" htmlFor={`requirements_${p.id}`}>Requirements</label>
                <textarea id={`requirements_${p.id}`} name={`requirements_${p.id}`} rows={3}
                  defaultValue={p.requirements ?? ''} className={field} />
              </div>
              <div>
                <label className="block text-xs font-medium" htmlFor={`clientNotes_${p.id}`}>Client notes</label>
                <textarea id={`clientNotes_${p.id}`} name={`clientNotes_${p.id}`} rows={2}
                  defaultValue={p.clientNotes ?? ''} className={field} />
              </div>
              <div>
                <label className="block text-xs font-medium" htmlFor={`internalNotes_${p.id}`}>Internal notes</label>
                <textarea id={`internalNotes_${p.id}`} name={`internalNotes_${p.id}`} rows={2}
                  defaultValue={p.internalNotes ?? ''} className={field} />
              </div>
            </div>
          </section>
        ))
      )}

      {state.error ? (
        <p role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending || plan.projects.length === 0 || targetClosed}
          className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
          {pending ? 'Copying…' : `Copy into ${plan.target.label}`}
        </button>
        <span className="text-xs text-muted">
          Each copy is a new project with a new code, filed as new for the Project Manager.
        </span>
      </div>
      <p className="text-xs text-muted">
        Something new this month that was not in {plan.source.label}?{' '}
        <Link href={`/projects/new?client=${plan.clientId}`} className="underline">File a new project</Link> for it
        after the copy.
      </p>
    </form>
    </div>
  );
}
