'use client';

import { useActionState, useEffect, useRef } from 'react';
import { deleteTimeAction, logTimeAction, type TimeFormState } from './actions';

const initial: TimeFormState = {};
const field =
  'mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent';

export function LogTimeForm({ assignments, today, minDate }: {
  assignments: { id: number; label: string }[];
  today: string;
  minDate: string;
}) {
  const [state, action, pending] = useActionState(logTimeAction, initial);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    // Keep the assignment and date, clear the rest, ready for the next entry.
    if (state.saved && form.current) {
      (form.current.elements.namedItem('hours') as HTMLInputElement).value = '';
      (form.current.elements.namedItem('note') as HTMLInputElement).value = '';
    }
  }, [state.saved]);

  if (assignments.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">
        You have no assignments to log time against. Time is recorded on work your Team Lead has assigned to you.
      </p>
    );
  }

  return (
    <form ref={form} action={action} className="rounded-lg border border-border bg-surface p-5">
      <div className="grid gap-4 sm:grid-cols-[1fr_10rem_7rem]">
        <div>
          <label className="block text-sm font-medium" htmlFor="assignmentId">Assignment</label>
          <select id="assignmentId" name="assignmentId" required className={field}>
            {assignments.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium" htmlFor="workDate">Day</label>
          <input id="workDate" name="workDate" type="date" required defaultValue={today}
            min={minDate} max={today} className={field} />
        </div>
        <div>
          <label className="block text-sm font-medium" htmlFor="hours">Hours</label>
          <input id="hours" name="hours" required inputMode="decimal" placeholder="1.5" className={field} />
        </div>
      </div>
      <label className="mt-4 block text-sm font-medium" htmlFor="note">Note</label>
      <input id="note" name="note" maxLength={500} placeholder="optional — what you worked on" className={field} />
      {state.error ? (
        <p role="alert" className="mt-4 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{state.error}</p>
      ) : state.notice ? (
        <p role="status" className="mt-4 rounded-md bg-accent/10 px-3 py-2 text-sm">{state.notice}</p>
      ) : null}
      <button type="submit" disabled={pending}
        className="mt-4 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
        {pending ? 'Saving…' : 'Log time'}
      </button>
    </form>
  );
}

export function DeleteEntryButton({ entryId }: { entryId: number }) {
  const [state, action, pending] = useActionState(deleteTimeAction, initial);
  return (
    <form action={action} className="inline">
      <input type="hidden" name="entryId" value={entryId} />
      <button type="submit" disabled={pending} className="text-xs text-muted hover:text-red-600 disabled:opacity-60">
        {pending ? 'Removing…' : 'Remove'}
      </button>
      {state.error ? <span role="alert" className="ml-2 text-xs text-red-600">{state.error}</span> : null}
    </form>
  );
}
