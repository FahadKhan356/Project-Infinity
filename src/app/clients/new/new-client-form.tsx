'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { createClient, type ClientFormState } from '../actions';

const initial: ClientFormState = {};
const field =
  'mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent';

export function NewClientForm({ prospect = false }: { prospect?: boolean }) {
  const [state, formAction, pending] = useActionState(createClient, initial);

  return (
    <form action={formAction} className="rounded-lg border border-border bg-surface p-6">
      <label className="block text-sm font-medium" htmlFor="name">Client name</label>
      <input id="name" name="name" required className={field} />

      <label className="mt-4 block text-sm font-medium" htmlFor="companyName">Company name</label>
      <input id="companyName" name="companyName" className={field} />

      <label className="mt-4 block text-sm font-medium" htmlFor="clientType">Type</label>
      <select id="clientType" name="clientType" defaultValue="retainer" className={field}>
        <option value="retainer">Retainer — recurring monthly work</option>
        <option value="one_off">One-off — a single engagement</option>
      </select>

      <label className="mt-4 block text-sm font-medium" htmlFor="startedOn">Client since</label>
      <input id="startedOn" name="startedOn" type="date" className={field}
        defaultValue={new Date().toISOString().slice(0, 10)} />
      <p className="mt-1 text-xs text-muted">Left as it is for a prospect until they become a client.</p>

      <label className="mt-4 flex items-center gap-2 text-sm">
        <input type="checkbox" name="prospect" defaultChecked={prospect} />
        Prospect — nothing confirmed yet; becomes active when their first project is filed from the pipeline
      </label>

      <label className="mt-4 block text-sm font-medium" htmlFor="notes">Notes</label>
      <textarea id="notes" name="notes" rows={3} className={field} />

      {state.error ? (
        <p role="alert" className="mt-4 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      {state.notice ? (
        <p role="status" className="mt-4 rounded-md bg-accent/10 px-3 py-2 text-sm">
          {state.notice}{' '}
          {state.clientId ? (
            <Link href={`/clients/${state.clientId}`} className="underline">Open the record</Link>
          ) : null}
          {state.clientId && prospect ? (
            <> · <Link href="/pipeline" className="underline">Back to the pipeline</Link></>
          ) : null}
        </p>
      ) : null}

      <button type="submit" disabled={pending}
        className="mt-6 w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
        {pending ? 'Creating…' : 'Create client'}
      </button>
    </form>
  );
}
