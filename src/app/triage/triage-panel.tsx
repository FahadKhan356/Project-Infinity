'use client';

import { useActionState, useState } from 'react';
import { submitTriage, type TriageFormState } from './actions';

const initial: TriageFormState = {};
const field =
  'mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent';

export interface TriageDepartment {
  id: number;
  name: string;
  selected: boolean;
  teamLeadId: number | null;
  plannedDeliverables: number;
  hasWork: boolean;
  /** This team's QA route (brief §13): Team Lead only, or Team Lead then PM. */
  requiresPmQa: boolean;
  leads: { id: number; name: string }[];
}

interface Props {
  projectId: number;
  departments: TriageDepartment[];
  priority: string;
  deadline: string | null;
  internalNotes: string | null;
}

export function TriagePanel({
  projectId, departments, priority, deadline, internalNotes,
}: Props) {
  const [state, formAction, pending] = useActionState(submitTriage, initial);
  const [selected, setSelected] = useState<number[]>(
    departments.filter((d) => d.selected).map((d) => d.id),
  );

  const toggle = (id: number, on: boolean) =>
    setSelected((current) => (on ? [...current, id] : current.filter((d) => d !== id)));

  return (
    <section id="triage" className="mt-8 rounded-lg border border-accent/40 bg-surface p-6">
      <h2 className="text-sm font-semibold">Route this project</h2>
      <p className="mt-1 max-w-prose text-xs text-muted">
        Assign a Team Lead per team. A team without a lead keeps the project in the Project
        Closure Report, so partial routing is visible rather than looking scheduled. PM QA is
        set per team (brief §13): tick it where the Project Manager also signs off before delivery.
      </p>

      <form action={formAction} className="mt-5">
        <input type="hidden" name="projectId" value={projectId} />

        <ul className="space-y-3">
          {departments.map((d) => {
            const on = selected.includes(d.id);
            return (
              <li key={d.id} className="rounded-md border border-border px-3 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input type="checkbox" name="department" value={d.id} defaultChecked={d.selected}
                      onChange={(e) => toggle(d.id, e.target.checked)} />
                    {d.name}
                    {d.hasWork ? (
                      <span className="text-xs font-normal text-muted">has work — cannot be removed</span>
                    ) : null}
                  </label>

                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-2 text-xs text-muted">
                      deliverables
                      <input type="number" name={`planned_${d.id}`} min={0}
                        defaultValue={d.plannedDeliverables} disabled={!on}
                        className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm" />
                    </label>

                    <select name={`lead_${d.id}`} defaultValue={d.teamLeadId ?? ''} disabled={!on}
                      className="rounded-md border border-border bg-background px-2 py-1 text-sm">
                      <option value="">No lead yet…</option>
                      {d.leads.map((l) => (
                        <option key={l.id} value={l.id}>{l.name}</option>
                      ))}
                    </select>

                    <label className="flex items-center gap-2 text-xs text-muted"
                      title="This team’s approved files also go to the Project Manager before delivery">
                      <input type="checkbox" name={`pmqa_${d.id}`} defaultChecked={d.requiresPmQa} disabled={!on} />
                      PM QA
                    </label>
                  </div>
                </div>
                {on && d.leads.length === 0 ? (
                  <p className="mt-2 text-xs text-muted">
                    Nobody leads this team yet. An administrator can mark a Team Lead in Users.
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium" htmlFor="priority">Priority</label>
            <select id="priority" name="priority" defaultValue={priority} className={field}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium" htmlFor="deadline">Deadline</label>
            <input id="deadline" name="deadline" type="date" defaultValue={deadline ?? ''} className={field} />
          </div>
        </div>

        <label className="mt-4 block text-sm font-medium" htmlFor="internalNotes">Internal notes</label>
        <textarea id="internalNotes" name="internalNotes" rows={3}
          defaultValue={internalNotes ?? ''} className={field} />

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
          {pending ? 'Saving…' : 'Save routing'}
        </button>
      </form>
    </section>
  );
}
