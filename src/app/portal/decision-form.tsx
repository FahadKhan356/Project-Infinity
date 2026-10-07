'use client';

import { useActionState, useState } from 'react';
import { decide, type DecisionState } from './actions';

const initial: DecisionState = {};

export function DecisionForm({ deliveryId }: { deliveryId: number }) {
  const [state, action, pending] = useActionState(decide, initial);
  const [asking, setAsking] = useState(false);

  if (state.notice) return <p role="status" className="mt-3 rounded-md bg-accent/10 px-3 py-2 text-sm">{state.notice}</p>;

  return (
    <form action={action} className="mt-3">
      <input type="hidden" name="deliveryId" value={deliveryId} />
      {asking ? (
        <>
          <label className="block text-sm font-medium" htmlFor={`fb-${deliveryId}`}>What should change?</label>
          <textarea id={`fb-${deliveryId}`} name="feedback" rows={3} required
            className="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent" />
        </>
      ) : null}
      {state.error ? <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{state.error}</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {asking ? (
          <>
            <button type="submit" name="decision" value="changes_requested" disabled={pending}
              className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
              {pending ? 'Sending…' : 'Send change request'}
            </button>
            <button type="button" onClick={() => setAsking(false)} className="rounded-md border border-border px-3 py-2 text-sm">
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="submit" name="decision" value="approved" disabled={pending}
              className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
              {pending ? 'Saving…' : 'Approve'}
            </button>
            <button type="button" onClick={() => setAsking(true)} className="rounded-md border border-border px-3 py-2 text-sm">
              Request changes
            </button>
          </>
        )}
      </div>
    </form>
  );
}
