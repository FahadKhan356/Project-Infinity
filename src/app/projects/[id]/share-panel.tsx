'use client';

import { useActionState } from 'react';
import { changeSharing, type ProjectFormState } from '../actions';

const initial: ProjectFormState = {};
const field =
  'mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-accent';

interface Props {
  projectId: number;
  viewers: { userId: number; fullName: string; isActive: boolean; grantedBy: string | null }[];
  candidates: { id: number; name: string }[];
}

/**
 * Sales reps this project is shared with (brief §23: "projects they
 * create/are authorized to view"). A share lets a rep read the project and
 * its client without the client being moved to them; it changes nothing else.
 * It is access, not the month's work, so it stays editable in a closed month.
 */
export function SharePanel({ projectId, viewers, candidates }: Props) {
  const [state, formAction, pending] = useActionState(changeSharing, initial);

  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold">Shared with</h2>
      <p className="mt-1 text-xs text-muted">
        Sales reps who may view this project and its client without owning them. They cannot change,
        deliver or bill either.
      </p>
      <div className="mt-3 rounded-lg border border-border bg-surface px-4 py-3 text-sm">
        {viewers.length === 0 ? (
          <p className="text-muted">
            Not shared. Its Sales owner and the owner of its client see it already.
          </p>
        ) : (
          <ul>
            {viewers.map((v) => (
              <li key={v.userId}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2 first:pt-0 last:border-0">
                <span>
                  {v.fullName}
                  {!v.isActive ? <span className="ml-2 text-xs text-muted">deactivated</span> : null}
                  {v.grantedBy ? <span className="ml-2 text-xs text-muted">shared by {v.grantedBy}</span> : null}
                </span>
                <form action={formAction}>
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="userId" value={v.userId} />
                  <button type="submit" name="change" value="unshare" disabled={pending}
                    className="text-xs text-muted underline-offset-2 hover:text-foreground hover:underline disabled:opacity-60">
                    Remove
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}

        {candidates.length > 0 ? (
          <form action={formAction} className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3">
            <input type="hidden" name="projectId" value={projectId} />
            <div className="min-w-48 flex-1">
              <label className="block text-xs font-medium text-muted" htmlFor="shareWith">Share with</label>
              <select id="shareWith" name="userId" defaultValue="" required className={field}>
                <option value="" disabled>Choose a Sales rep…</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <button type="submit" name="change" value="share" disabled={pending}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60">
              {pending ? 'Saving…' : 'Share'}
            </button>
          </form>
        ) : null}

        {state.error ? (
          <p role="alert" className="mt-2 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            {state.error}
          </p>
        ) : null}
        {state.notice ? (
          <p role="status" className="mt-2 rounded-md bg-accent/10 px-3 py-2 text-xs">{state.notice}</p>
        ) : null}
      </div>
    </section>
  );
}
