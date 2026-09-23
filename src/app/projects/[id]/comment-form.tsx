'use client';

import { useActionState } from 'react';
import { postComment, type ProjectFormState } from '../actions';

const initial: ProjectFormState = {};
const field =
  'mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent';

interface Props {
  projectId: number;
  /** Slots a comment can be pinned to; empty hides the picker. */
  deliverables: { id: number; label: string }[];
}

export function CommentForm({ projectId, deliverables }: Props) {
  const [state, formAction, pending] = useActionState(postComment, initial);

  return (
    <form action={formAction} className="mt-4 rounded-lg border border-border bg-surface p-4">
      <input type="hidden" name="projectId" value={projectId} />

      <label className="block text-sm font-medium" htmlFor="commentBody">Add a comment</label>
      <textarea id="commentBody" name="body" rows={3} required maxLength={4000} className={field}
        placeholder="A note for everyone on this project…" />

      {deliverables.length > 0 ? (
        <div className="mt-3">
          <label className="block text-xs font-medium text-muted" htmlFor="commentDeliverable">
            About a specific deliverable (optional)
          </label>
          <select id="commentDeliverable" name="deliverableId" defaultValue="" className={field}>
            <option value="">The whole project</option>
            {deliverables.map((d) => (
              <option key={d.id} value={d.id}>{d.label}</option>
            ))}
          </select>
        </div>
      ) : null}

      {state.error ? (
        <p role="alert" className="mt-3 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}

      <button type="submit" disabled={pending}
        className="mt-3 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
        {pending ? 'Posting…' : 'Post comment'}
      </button>
    </form>
  );
}
