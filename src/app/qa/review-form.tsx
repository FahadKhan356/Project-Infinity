'use client';

import { useActionState } from 'react';
import { submitReview, type QaFormState } from './actions';

const initial: QaFormState = {};
const field =
  'mt-2 w-full rounded-lg border border-border/80 bg-background/90 px-3 py-2 text-xs text-foreground placeholder:text-muted/70 outline-none transition-all focus:border-accent focus:ring-1 focus:ring-accent';

/**
 * Three decisions, one comment box (brief §12). The decision travels as the
 * value of the button that was pressed, so there is nothing to select first.
 */
export function ReviewForm({ deliverableId, stage }: { deliverableId: number; stage: 'team_lead' | 'project_manager' }) {
  const [state, formAction, pending] = useActionState(submitReview, initial);

  if (state.notice) {
    return (
      <div role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-xs font-medium text-emerald-400">
        {state.notice}
      </div>
    );
  }

  return (
    <form action={formAction} className="flex h-full flex-col justify-between">
      <input type="hidden" name="deliverableId" value={deliverableId} />

      <div>
        <div className="flex items-center justify-between border-b border-border/60 pb-2.5">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/10 text-accent">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 2.5l6 2.5v5c0 4.2-2.8 7.3-6 8.5-3.2-1.2-6-4.3-6-8.5V5l6-2.5z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 10l1.5 1.5 3-3" />
              </svg>
            </span>
            <span className="text-xs font-semibold uppercase tracking-wider text-muted">QA Decision & Comments</span>
          </div>
        </div>

        <label className="mt-2.5 block text-xs text-muted" htmlFor={`comments-${deliverableId}`}>
          {stage === 'project_manager'
            ? 'Feedback notes (visible to production team & sales):'
            : 'Review feedback (visible to the assigned executive):'}
        </label>
        <textarea
          id={`comments-${deliverableId}`}
          name="comments"
          rows={3}
          className={field}
          placeholder="Specify approval confirmation, adjustment guidance, or reasons for rejection..."
        />

        {state.error ? (
          <p role="alert" className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-400">
            {state.error}
          </p>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 pt-2 border-t border-border/50">
        <button
          type="submit"
          name="decision"
          value="approved"
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-emerald-500 disabled:opacity-60"
        >
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.2" className="h-3.5 w-3.5" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 10l4 4 8-8" />
          </svg>
          <span>{pending ? 'Saving…' : 'Approve'}</span>
        </button>

        <button
          type="submit"
          name="decision"
          value="changes_requested"
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-2 text-xs font-semibold text-amber-400 transition-colors hover:bg-amber-500/20 disabled:opacity-60"
        >
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 10a6 6 0 1111.3 2.8M15.5 8.5v4.5H11" />
          </svg>
          <span>Request changes</span>
        </button>

        <button
          type="submit"
          name="decision"
          value="rejected"
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3.5 py-2 text-xs font-semibold text-rose-400 transition-colors hover:bg-rose-500/20 disabled:opacity-60"
        >
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 5l10 10M15 5l-10 10" />
          </svg>
          <span>Reject</span>
        </button>
      </div>
    </form>
  );
}
