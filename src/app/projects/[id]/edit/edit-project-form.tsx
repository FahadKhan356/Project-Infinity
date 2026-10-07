'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { editProject, type ProjectFormState } from '../../actions';

const initial: ProjectFormState = {};
const field =
  'mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent';

interface Props {
  project: {
    id: number;
    title: string;
    projectType: string | null;
    objective: string | null;
    description: string | null;
    poReference: string | null;
    requirements: string | null;
    clientNotes: string | null;
    otherInfo: string | null;
    priceAmount: string | null;
    priceCurrency: string;
    recursMonthly: boolean;
  };
  /** The teams routed to the project, each with its own QA route (brief §13). */
  teams: { departmentId: number; name: string; requiresPmQa: boolean }[];
  canSetPricing: boolean;
}

export function EditProjectForm({ project: p, teams, canSetPricing }: Props) {
  const [state, formAction, pending] = useActionState(editProject, initial);

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="projectId" value={p.id} />
      <section className="rounded-lg border border-border bg-surface p-6">
        <label className="block text-sm font-medium" htmlFor="title">Project name</label>
        <input id="title" name="title" required defaultValue={p.title} className={field} />

        <label className="mt-4 block text-sm font-medium" htmlFor="projectType">Project / order type</label>
        <input id="projectType" name="projectType" defaultValue={p.projectType ?? ''} className={field} />

        <label className="mt-4 block text-sm font-medium" htmlFor="objective">Objective</label>
        <textarea id="objective" name="objective" rows={2} defaultValue={p.objective ?? ''} className={field} />

        <label className="mt-4 block text-sm font-medium" htmlFor="description">Description</label>
        <textarea id="description" name="description" rows={3} defaultValue={p.description ?? ''} className={field} />

        <label className="mt-4 block text-sm font-medium" htmlFor="poReference">PO reference</label>
        <input id="poReference" name="poReference" defaultValue={p.poReference ?? ''} className={field} />

        <label className="mt-4 block text-sm font-medium" htmlFor="requirements">Requirements</label>
        <textarea id="requirements" name="requirements" rows={4} defaultValue={p.requirements ?? ''} className={field} />

        <label className="mt-4 block text-sm font-medium" htmlFor="clientNotes">Client notes</label>
        <textarea id="clientNotes" name="clientNotes" rows={2} defaultValue={p.clientNotes ?? ''} className={field} />

        <label className="mt-4 block text-sm font-medium" htmlFor="otherInfo">Other relevant information</label>
        <textarea id="otherInfo" name="otherInfo" rows={3} defaultValue={p.otherInfo ?? ''} className={field} />

        {canSetPricing ? (
          <>
            <label className="mt-4 block text-sm font-medium" htmlFor="priceAmount">Price ({p.priceCurrency})</label>
            <input id="priceAmount" name="priceAmount" type="number" min={0} step="0.01"
              defaultValue={p.priceAmount ?? ''} className={field} />
            <p className="mt-1 text-xs text-muted">Visible only to management, Sales and the Project Manager.</p>
          </>
        ) : null}
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input type="checkbox" name="recursMonthly" defaultChecked={p.recursMonthly} />
          Repeats every month — copied into each new month automatically
        </label>
      </section>

      {teams.length > 0 ? (
        <section className="rounded-lg border border-border bg-surface p-6">
          <h2 className="text-sm font-semibold">Quality assurance</h2>
          <p className="mt-1 text-xs text-muted">
            Per team (brief §13): files pass the Team Lead only, or the Team Lead and then the
            Project Manager, before they reach the delivery queue.
          </p>
          <ul className="mt-3 space-y-2">
            {teams.map((t) => (
              <li key={t.departmentId}>
                {/* An unticked box is absent from the form; this marker says the team was listed. */}
                <input type="hidden" name="pmqaTeam" value={t.departmentId} />
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name={`pmqa_${t.departmentId}`} defaultChecked={t.requiresPmQa} />
                  {t.name}: PM QA required before delivery
                </label>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {state.error ? (
        <p role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}

      <p className="text-xs text-muted">
        The Project Manager, the team leads and anyone with work on the project are told which fields changed.
      </p>

      <div className="flex gap-3">
        <button type="submit" disabled={pending}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
          {pending ? 'Saving…' : 'Save changes'}
        </button>
        <Link href={`/projects/${p.id}`} className="rounded-md border border-border px-4 py-2 text-sm">
          Cancel
        </Link>
      </div>
    </form>
  );
}
