'use client';

import { useActionState } from 'react';
import { submitDeliveryUpdate, type DeliveryFormState } from './actions';

const initial: DeliveryFormState = {};
const field =
  'mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-accent';

const LABELS: Record<string, string> = {
  pending_delivery: 'Pending delivery',
  delivered: 'Delivered',
  client_feedback_received: 'Client feedback received',
  revision_required: 'Revision required',
  completed: 'Completed',
};

interface Props {
  deliveryId: number;
  /** Where the delivery stands now. */
  status: string;
  /** The statuses this delivery may move to from where it is. */
  next: string[];
  notes: string | null;
  clientFeedback: string | null;
}

export function DeliveryForm({ deliveryId, status, next, notes, clientFeedback }: Props) {
  const [state, formAction, pending] = useActionState(submitDeliveryUpdate, initial);

  if (next.length === 0) {
    return (
      <p className="text-xs text-muted">
        {status === 'revision_required'
          ? 'Being revised. The reworked file will arrive here as a new delivery once it clears QA; a revision ended before then gives this one back its delivered state.'
          : 'Completed. Nothing further to record.'}
      </p>
    );
  }

  return (
    <form action={formAction} className="text-sm">
      <input type="hidden" name="deliveryId" value={deliveryId} />

      <label className="block text-xs font-medium text-muted" htmlFor={`status-${deliveryId}`}>Mark as</label>
      <select id={`status-${deliveryId}`} name="status" defaultValue={next[0]} className={field}>
        {next.map((s) => (
          <option key={s} value={s}>{LABELS[s] ?? s}</option>
        ))}
      </select>

      <label className="mt-2 block text-xs font-medium text-muted" htmlFor={`feedback-${deliveryId}`}>
        Client feedback
      </label>
      <textarea id={`feedback-${deliveryId}`} name="clientFeedback" rows={2} defaultValue={clientFeedback ?? ''}
        className={field} placeholder="What the client said, in their words." />

      <label className="mt-2 block text-xs font-medium text-muted" htmlFor={`notes-${deliveryId}`}>Notes</label>
      <input id={`notes-${deliveryId}`} name="notes" defaultValue={notes ?? ''} className={field}
        placeholder="How and where it was sent" />

      {state.error ? (
        <p role="alert" className="mt-2 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      {state.notice ? (
        <p role="status" className="mt-2 rounded-md bg-accent/10 px-3 py-2 text-xs">{state.notice}</p>
      ) : null}

      <button type="submit" disabled={pending}
        className="mt-3 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60">
        {pending ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}
