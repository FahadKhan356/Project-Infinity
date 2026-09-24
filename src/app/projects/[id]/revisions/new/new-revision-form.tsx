'use client';

import { useActionState } from 'react';
import { openRevision, type RevisionFormState } from '@/app/revisions/actions';

const initial: RevisionFormState = {};
const field =
  'mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent';

interface Props {
  projectId: number;
  nextNumber: number;
  deliverables: { id: number; label: string; status: string; preselected: boolean }[];
}

/** The §15 form: title, the client's words, details, which files, priority, deadline. */
export function NewRevisionForm({ projectId, nextNumber, deliverables }: Props) {
  const [state, formAction, pending] = useActionState(openRevision, initial);

  return (
    <form action={formAction} className="rounded-lg border border-border bg-surface p-6">
      <input type="hidden" name="projectId" value={projectId} />

      <label className="block text-sm font-medium" htmlFor="title">Revision #{String(nextNumber).padStart(2, '0')} — title</label>
      <input id="title" name="title" required className={field} placeholder="Opening scene and logo placement" />

      <label className="mt-4 block text-sm font-medium" htmlFor="clientFeedback">Client feedback</label>
      <textarea id="clientFeedback" name="clientFeedback" required rows={4} className={field}
        placeholder="In the client’s own words." />

      <label className="mt-4 block text-sm font-medium" htmlFor="details">Revision details</label>
      <textarea id="details" name="details" rows={3} className={field}
        placeholder="What the team should actually change." />

      <fieldset className="mt-4">
        <legend className="text-sm font-medium">Deliverables this is about</legend>
        <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
          {deliverables.map((d) => (
            <label key={d.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
              <input type="checkbox" name="deliverableId" value={d.id} defaultChecked={d.preselected} />
              <span>{d.label}</span>
              <span className="ml-auto text-xs text-muted">{d.status.replace(/_/g, ' ')}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="block text-sm font-medium" htmlFor="priority">Priority</label>
          <select id="priority" name="priority" defaultValue="normal" className={field}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium" htmlFor="deadline">Deadline</label>
          <input id="deadline" name="deadline" type="date" className={field} />
        </div>
      </div>

      {state.error ? (
        <p role="alert" className="mt-4 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}

      <button type="submit" disabled={pending}
        className="mt-6 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
        {pending ? 'Opening…' : 'Open revision'}
      </button>
    </form>
  );
}
