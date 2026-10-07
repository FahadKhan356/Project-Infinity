'use client';

import { useActionState } from 'react';
import { changeStatus, type ProjectFormState } from '../actions';

const initial: ProjectFormState = {};
const field =
  'mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent';

/**
 * On Hold and Cancelled (brief §18) — the two statuses a person decides.
 * Cancelling is final and withdraws unfinished work, so it asks for a reason
 * and a confirmation; holding is reversible and asks for neither.
 */
export function StatusPanel({ projectId, status }: { projectId: number; status: string }) {
  const [state, formAction, pending] = useActionState(changeStatus, initial);
  const held = status === 'on_hold';

  return (
    <details className="mt-6 rounded-lg border border-border bg-surface">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
        {held ? 'On hold — resume or cancel' : 'Hold or cancel this project'}
      </summary>
      <form action={formAction} className="border-t border-border p-4"
        onSubmit={(event) => {
          const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
          if (submitter?.value === 'cancel'
            && !window.confirm('Cancel this project? Every unfinished slot, assignment and revision is withdrawn. This cannot be undone.')) {
            event.preventDefault();
          }
        }}>
        <input type="hidden" name="projectId" value={projectId} />
        <label className="block text-sm font-medium" htmlFor="statusReason">Reason</label>
        <textarea id="statusReason" name="reason" rows={2} maxLength={1000} className={field}
          placeholder={held ? 'Why it can resume, or why it is being cancelled…' : 'Client paused the order, awaiting assets…'} />
        <p className="mt-1 text-xs text-muted">
          {held
            ? 'Resuming returns the project to where it was. Nothing new could be assigned or uploaded while it was held.'
            : 'While on hold nothing new can be assigned or uploaded; work already in QA can still be finished. A reason is required to cancel.'}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {held ? (
            <button type="submit" name="change" value="resume" disabled={pending}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60">
              Resume
            </button>
          ) : (
            <button type="submit" name="change" value="hold" disabled={pending}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-background disabled:opacity-60">
              Put on hold
            </button>
          )}
          <button type="submit" name="change" value="cancel" disabled={pending}
            className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950">
            Cancel project
          </button>
          {state.error ? <p role="alert" className="text-xs text-red-600 dark:text-red-400">{state.error}</p> : null}
          {state.notice ? <p role="status" className="text-xs text-muted">{state.notice}</p> : null}
        </div>
      </form>
    </details>
  );
}
