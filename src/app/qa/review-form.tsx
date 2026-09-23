'use client';

import { useActionState } from 'react';
import { submitReview, type QaFormState } from './actions';

const initial: QaFormState = {};
const field =
  'mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent';

/**
 * Three decisions, one comment box (brief §12). The decision travels as the
 * value of the button that was pressed, so there is nothing to select first.
 */
export function ReviewForm({ deliverableId, stage }: { deliverableId: number; stage: 'team_lead' | 'project_manager' }) {
  const [state, formAction, pending] = useActionState(submitReview, initial);

  if (state.notice) {
    return <p role="status" className="rounded-md bg-accent/10 px-3 py-2 text-sm">{state.notice}</p>;
  }

  return (
    <form action={formAction}>
      <input type="hidden" name="deliverableId" value={deliverableId} />
      <label className="block text-xs font-medium text-muted" htmlFor={`comments-${deliverableId}`}>
        QA comments {stage === 'project_manager' ? '(the team and Sales will see these)' : '(the executive will see these)'}
      </label>
      <textarea id={`comments-${deliverableId}`} name="comments" rows={2} className={field}
        placeholder="What is wrong, or what to keep doing." />

      {state.error ? (
        <p role="alert" className="mt-2 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="submit" name="decision" value="approved" disabled={pending}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60">
          {pending ? 'Saving…' : 'Approve'}
        </button>
        <button type="submit" name="decision" value="changes_requested" disabled={pending}
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium disabled:opacity-60">
          Request changes
        </button>
        <button type="submit" name="decision" value="rejected" disabled={pending}
          className="rounded-md border border-red-500/40 px-3 py-1.5 text-sm font-medium text-red-600 disabled:opacity-60 dark:text-red-400">
          Reject
        </button>
      </div>
    </form>
  );
}
