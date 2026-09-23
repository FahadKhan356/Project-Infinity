'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { createProject, type ProjectFormState } from '../actions';
import type { MonthOption } from '@/lib/projects/intake';

const initial: ProjectFormState = {};
const field =
  'mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent';
const card = 'rounded-lg border border-border bg-surface p-6';

interface Props {
  clients: { id: number; name: string; companyName: string | null }[];
  departments: { id: number; name: string }[];
  months: MonthOption[];
  canSetPricing: boolean;
  canCreateClients: boolean;
  preselectedClientId: number | null;
}

export function NewProjectForm({
  clients, departments, months, canSetPricing, canCreateClients, preselectedClientId,
}: Props) {
  const [state, formAction, pending] = useActionState(createProject, initial);
  const [selectedTeams, setSelectedTeams] = useState<number[]>([]);

  const toggleTeam = (id: number, on: boolean) =>
    setSelectedTeams((current) => (on ? [...current, id] : current.filter((t) => t !== id)));

  const currentMonth = months.find((m) => {
    const now = new Date();
    return m.year === now.getUTCFullYear() && m.month === now.getUTCMonth() + 1;
  });

  if (clients.length === 0) {
    return (
      <div className={card}>
        <p className="text-sm">
          There are no clients on record yet.{' '}
          {canCreateClients ? (
            <Link href="/clients/new" className="underline">Create the client first</Link>
          ) : (
            'Ask Sales to create the client record first.'
          )}
          .
        </p>
        <p className="mt-2 text-xs text-muted">
          Projects attach to a permanent client record, so the client always exists first.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-6">
      <section className={card}>
        <h2 className="text-sm font-semibold">Client and month</h2>

        <label className="mt-4 block text-sm font-medium" htmlFor="clientId">Client</label>
        <select id="clientId" name="clientId" required className={field}
          defaultValue={preselectedClientId ?? ''}>
          <option value="" disabled>Choose a client…</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}{c.companyName && c.companyName !== c.name ? ` — ${c.companyName}` : ''}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-muted">
          Not listed?{' '}
          {canCreateClients ? (
            <Link href="/clients/new" className="underline">Create the client record</Link>
          ) : (
            'Ask Sales to create the client record'
          )}
          , then come back — client names are never typed into a project.
        </p>

        <label className="mt-4 block text-sm font-medium" htmlFor="period">Month this work belongs to</label>
        <select id="period" name="period" required className={field} defaultValue={currentMonth?.value}>
          {months.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
      </section>

      <section className={card}>
        <h2 className="text-sm font-semibold">The work</h2>

        <label className="mt-4 block text-sm font-medium" htmlFor="title">Project name</label>
        <input id="title" name="title" required className={field} placeholder="10 Social Media Videos" />

        <label className="mt-4 block text-sm font-medium" htmlFor="projectType">Project / order type</label>
        <input id="projectType" name="projectType" className={field} placeholder="Social media content" />

        <label className="mt-4 block text-sm font-medium" htmlFor="objective">Objective</label>
        <textarea id="objective" name="objective" rows={2} className={field} />

        <label className="mt-4 block text-sm font-medium" htmlFor="description">Description</label>
        <textarea id="description" name="description" rows={3} className={field} />

        <label className="mt-4 block text-sm font-medium" htmlFor="poReference">PO reference</label>
        <input id="poReference" name="poReference" className={field} />

        <label className="mt-4 block text-sm font-medium" htmlFor="requirements">Requirements</label>
        <textarea id="requirements" name="requirements" rows={3} className={field} />
      </section>

      <section className={card}>
        <h2 className="text-sm font-semibold">Teams and deliverables</h2>
        <p className="mt-1 text-xs text-muted">
          A project can need more than one team. Each gets its own deliverables and its own QA.
        </p>

        <ul className="mt-4 space-y-3">
          {departments.map((d) => {
            const on = selectedTeams.includes(d.id);
            return (
              <li key={d.id} className="flex items-center justify-between gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="department" value={d.id}
                    onChange={(e) => toggleTeam(d.id, e.target.checked)} />
                  {d.name}
                </label>
                <label className={`flex items-center gap-2 text-xs ${on ? '' : 'opacity-40'}`}>
                  deliverables
                  <input type="number" name={`planned_${d.id}`} min={0} defaultValue={0}
                    disabled={!on}
                    className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm" />
                </label>
              </li>
            );
          })}
        </ul>
      </section>

      <section className={card}>
        <h2 className="text-sm font-semibold">Schedule, pricing and notes</h2>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium" htmlFor="deadline">Deadline</label>
            <input id="deadline" name="deadline" type="date" className={field} />
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

        {canSetPricing ? (
          <div className="mt-4">
            <label className="block text-sm font-medium" htmlFor="priceAmount">Price (AED)</label>
            <input id="priceAmount" name="priceAmount" type="number" min={0} step="0.01" className={field} />
            <p className="mt-1 text-xs text-muted">
              Visible only to management, Sales and the Project Manager.
            </p>
          </div>
        ) : null}

        <label className="mt-4 block text-sm font-medium" htmlFor="clientNotes">Client notes</label>
        <textarea id="clientNotes" name="clientNotes" rows={2} className={field} />

        <label className="mt-4 block text-sm font-medium" htmlFor="internalNotes">Internal notes</label>
        <textarea id="internalNotes" name="internalNotes" rows={2} className={field} />

        <label className="mt-4 flex items-center gap-2 text-sm">
          <input type="checkbox" name="requiresPmQa" defaultChecked />
          Require Project Manager QA before delivery
        </label>
      </section>

      {state.error ? (
        <p role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}

      <button type="submit" disabled={pending}
        className="w-full rounded-md bg-accent px-3 py-2.5 text-sm font-medium text-white disabled:opacity-60">
        {pending ? 'Filing…' : 'File project'}
      </button>
    </form>
  );
}
