'use client';

import { useActionState } from 'react';
import { commentOnRevision, endRevision, handRevision, type RevisionFormState } from '../actions';

const initial: RevisionFormState = {};
const field =
  'mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-accent';

function Feedback({ state }: { state: RevisionFormState }) {
  if (state.error) {
    return (
      <p role="alert" className="mt-2 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
        {state.error}
      </p>
    );
  }
  if (state.notice) {
    return <p role="status" className="mt-2 rounded-md bg-accent/10 px-3 py-2 text-xs">{state.notice}</p>;
  }
  return null;
}

/** A Team Lead picks who reworks one slot (brief §17). */
export function HandOffForm({
  revisionId, deliverableId, members, currentAssigneeId,
}: {
  revisionId: number;
  deliverableId: number;
  members: { id: number; name: string }[];
  currentAssigneeId: number | null;
}) {
  const [state, formAction, pending] = useActionState(handRevision, initial);
  return (
    <form action={formAction} className="text-sm">
      <input type="hidden" name="revisionId" value={revisionId} />
      <input type="hidden" name="deliverableId" value={deliverableId} />
      <label className="block text-xs font-medium text-muted" htmlFor={`assignee-${deliverableId}`}>Hand to</label>
      <div className="flex gap-2">
        <select id={`assignee-${deliverableId}`} name="assigneeId" className={field}
          defaultValue={currentAssigneeId ?? ''}>
          <option value="" disabled>Choose…</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <button type="submit" disabled={pending}
          className="mt-1 shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60">
          {pending ? 'Saving…' : 'Assign'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

/** Sales or the PM ends the revision. */
export function EndRevisionForm({ revisionId }: { revisionId: number }) {
  const [state, formAction, pending] = useActionState(endRevision, initial);
  return (
    <form action={formAction} className="text-sm">
      <input type="hidden" name="revisionId" value={revisionId} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" name="outcome" value="closed" disabled={pending}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60">
          {pending ? 'Saving…' : 'Close — client satisfied'}
        </button>
        <button type="submit" name="outcome" value="cancelled" disabled={pending}
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium disabled:opacity-60">
          Cancel revision
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function RevisionCommentForm({ revisionId }: { revisionId: number }) {
  const [state, formAction, pending] = useActionState(commentOnRevision, initial);
  return (
    <form action={formAction} className="mt-3 rounded-lg border border-border bg-surface p-4">
      <input type="hidden" name="revisionId" value={revisionId} />
      <label className="block text-sm font-medium" htmlFor="revisionComment">Add a comment</label>
      <textarea id="revisionComment" name="body" rows={3} required maxLength={4000} className={field}
        placeholder="Questions about the feedback, what was changed…" />
      <Feedback state={state} />
      <button type="submit" disabled={pending}
        className="mt-3 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
        {pending ? 'Posting…' : 'Post comment'}
      </button>
    </form>
  );
}
