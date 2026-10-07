'use client';

import { useActionState, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createProject, type ProjectFormState } from '../actions';
import { PendingAttachments, uploadPending } from '@/components/files/pending-attachments';
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
  /** Filing from a pipeline deal: the project wins it. */
  opportunity?: { id: number; title: string; clientName: string; value: string | null } | null;
}

export function NewProjectForm({
  clients, departments, months, canSetPricing, canCreateClients, preselectedClientId, opportunity = null,
}: Props) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(createProject, initial);
  const [selectedTeams, setSelectedTeams] = useState<number[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [poFiles, setPoFiles] = useState<File[]>([]);
  const [attaching, setAttaching] = useState<string>('');
  const [attachError, setAttachError] = useState<string | null>(null);

  // The project exists now; send the PO and references it was filed with,
  // then open it. If a file fails, the project is still there to retry on:
  // the form stays done and the error line leads there, since filing again
  // from here would make a second project.
  const createdProjectId = state.createdProjectId;
  useEffect(() => {
    if (!createdProjectId) return;
    let cancelled = false;
    void (async () => {
      // The PO first, so a failure names the order before a stray reference.
      const po = await uploadPending(
        poFiles, { target: 'attachment', projectId: createdProjectId, kind: 'po' }, setAttaching,
      );
      if (cancelled) return;
      const refs = await uploadPending(
        files, { target: 'attachment', projectId: createdProjectId, purpose: 'brief' }, setAttaching,
      );
      if (cancelled) return;
      const failed = [po.failed ? `the PO document ${po.failed}` : null, refs.failed].filter(Boolean);
      if (failed.length > 0) setAttachError(`Project filed, but ${failed.join('; ')}`);
      else router.push(`/projects/${createdProjectId}`);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per filed project
  }, [createdProjectId]);
  const filed = createdProjectId !== undefined;
  const busy = pending || filed;

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
      {opportunity ? (
        <p role="status" className="rounded-md border border-accent/40 bg-accent/10 px-4 py-3 text-sm">
          <input type="hidden" name="opportunityId" value={opportunity.id} />
          Filing this project wins the deal <span className="font-medium">“{opportunity.title}”</span> for{' '}
          {opportunity.clientName}.
        </p>
      ) : null}
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
        <input id="title" name="title" required className={field} placeholder="10 Social Media Videos"
          defaultValue={opportunity?.title ?? ''} />

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

        <label className="mt-4 block text-sm font-medium" htmlFor="otherInfo">Other relevant information</label>
        <textarea id="otherInfo" name="otherInfo" rows={3} className={field}
          placeholder="Anything else the team should know: delivery channel, brand assets, approvals" />
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
            <input id="priceAmount" name="priceAmount" type="number" min={0} step="0.01" className={field}
              defaultValue={opportunity?.value ?? ''} />
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

        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" name="recursMonthly" />
          Repeats every month — copied into each new month automatically
        </label>
      </section>

      <section className={`${card} space-y-5`}>
        <PendingAttachments
          files={poFiles}
          onChange={setPoFiles}
          multiple={false}
          disabled={busy}
          label="PO document"
          hint="The purchase order itself; the PO reference above is its number. Shown beside it on the project."
        />
        <PendingAttachments
          files={files}
          onChange={setFiles}
          disabled={busy}
          label="Brief and reference files"
          hint="Attached to the project as soon as it is filed. More can be added on the project page later."
        />
        {files.length + poFiles.length > 0 ? <input type="hidden" name="stayAfterCreate" value="1" /> : null}
      </section>

      {state.error ? (
        <p role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      {attachError ? (
        <p role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {attachError}{' '}
          <Link href={`/projects/${createdProjectId}`} className="underline">Open the project</Link> to attach the rest.
        </p>
      ) : null}

      <button type="submit" disabled={busy}
        className="w-full rounded-md bg-accent px-3 py-2.5 text-sm font-medium text-white disabled:opacity-60">
        {pending ? 'Filing…' : attaching || (attachError ? 'Filed' : filed ? 'Filed, attaching…' : 'File project')}
      </button>
    </form>
  );
}
