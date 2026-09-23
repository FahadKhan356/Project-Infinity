'use client';

import { useActionState, useState } from 'react';
import { assignWork, type PlanningFormState } from '../actions';

const initial: PlanningFormState = {};
const field =
  'mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent';

interface Props {
  projectDepartmentId: number;
  members: { id: number; name: string; openSlots: number }[];
  defaultBaseName: string;
  remaining: number;
  deadline: string | null;
}

export function AssignPanel({
  projectDepartmentId, members, defaultBaseName, remaining, deadline,
}: Props) {
  const [state, formAction, pending] = useActionState(assignWork, initial);
  const [count, setCount] = useState(remaining > 0 ? remaining : 1);

  if (members.length === 0) {
    return (
      <section className="mt-8 rounded-lg border border-border bg-surface p-6">
        <h2 className="text-sm font-semibold">Assign work</h2>
        <p className="mt-2 text-sm text-muted">
          Nobody is on this team yet. An administrator adds members in Users.
        </p>
      </section>
    );
  }

  return (
    <section className="mt-8 rounded-lg border border-accent/40 bg-surface p-6">
      <h2 className="text-sm font-semibold">Assign work</h2>
      <p className="mt-1 max-w-prose text-xs text-muted">
        One assignment opens all of its deliverable slots at once — twenty designs is one
        decision, not twenty forms. Each slot tracks its own versions and QA.
      </p>

      <form action={formAction} className="mt-5">
        <input type="hidden" name="projectDepartmentId" value={projectDepartmentId} />

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium" htmlFor="title">Assignment</label>
            <input id="title" name="title" required className={field}
              placeholder="Edit and grade the hero cuts" />
          </div>
          <div>
            <label className="block text-sm font-medium" htmlFor="assigneeId">Executive</label>
            <select id="assigneeId" name="assigneeId" required className={field} defaultValue="">
              <option value="" disabled>Choose a team member…</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} — {m.openSlots} open
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <label className="block text-sm font-medium" htmlFor="startDate">Start</label>
            <input id="startDate" name="startDate" type="date" className={field} />
          </div>
          <div>
            <label className="block text-sm font-medium" htmlFor="endDate">End</label>
            <input id="endDate" name="endDate" type="date" defaultValue={deadline ?? ''} className={field} />
          </div>
          <div>
            <label className="block text-sm font-medium" htmlFor="priority">Priority</label>
            <select id="priority" name="priority" defaultValue="normal" className={field}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <label className="block text-sm font-medium" htmlFor="deliverableCount">Deliverables</label>
            <input id="deliverableCount" name="deliverableCount" type="number" min={0} max={100}
              value={count} onChange={(e) => setCount(Number(e.target.value))} className={field} />
            {remaining > 0 ? (
              <p className="mt-1 text-xs text-muted">{remaining} still unplanned for this team.</p>
            ) : null}
          </div>
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium" htmlFor="deliverableBaseName">Slot names</label>
            <input id="deliverableBaseName" name="deliverableBaseName"
              defaultValue={defaultBaseName} className={field} />
            <p className="mt-1 text-xs text-muted">
              Numbered per team, continuing from what already exists.
            </p>
          </div>
        </div>

        <label className="mt-4 block text-sm font-medium" htmlFor="deliverableDescription">
          What each deliverable is
        </label>
        <input id="deliverableDescription" name="deliverableDescription" className={field}
          placeholder="9:16, 20–30s, burned-in subtitles" />

        <label className="mt-4 block text-sm font-medium" htmlFor="instructions">
          Instructions and comments
        </label>
        <textarea id="instructions" name="instructions" rows={3} className={field} />

        {state.error ? (
          <p role="alert" className="mt-4 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
            {state.error}
          </p>
        ) : null}
        {state.notice ? (
          <p role="status" className="mt-4 rounded-md bg-accent/10 px-3 py-2 text-sm">{state.notice}</p>
        ) : null}

        <button type="submit" disabled={pending}
          className="mt-6 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
          {pending ? 'Assigning…' : `Assign${count > 0 ? ` with ${count} slot${count === 1 ? '' : 's'}` : ''}`}
        </button>
      </form>
    </section>
  );
}
