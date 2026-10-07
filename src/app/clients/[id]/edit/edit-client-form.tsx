'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { updateClient, type ClientFormState } from '../../actions';

const initial: ClientFormState = {};
const field =
  'mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent';

const STATUSES = [
  { value: 'prospect', label: 'Prospect' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'churned', label: 'Churned' },
];

interface Props {
  client: {
    id: number; name: string; companyName: string | null; status: string; clientType: string;
    startedOn: string | null; notes: string | null; ownerUserId: number | null;
  };
  /** null when the viewer may not move the client to another rep. */
  reps: { id: number; name: string }[] | null;
}

export function EditClientForm({ client: c, reps }: Props) {
  const [state, formAction, pending] = useActionState(updateClient, initial);

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="clientId" value={c.id} />
      <section className="rounded-lg border border-border bg-surface p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium" htmlFor="name">Client name</label>
            <input id="name" name="name" required defaultValue={c.name} className={field} />
          </div>
          <div>
            <label className="block text-sm font-medium" htmlFor="companyName">Company name</label>
            <input id="companyName" name="companyName" defaultValue={c.companyName ?? ''} className={field} />
          </div>
          <div>
            <label className="block text-sm font-medium" htmlFor="status">Status</label>
            <select id="status" name="status" defaultValue={c.status} className={field}>
              {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium" htmlFor="clientType">Type</label>
            <select id="clientType" name="clientType" defaultValue={c.clientType} className={field}>
              <option value="retainer">Retainer</option>
              <option value="one_off">One-off</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium" htmlFor="startedOn">Client since</label>
            <input id="startedOn" name="startedOn" type="date" defaultValue={c.startedOn ?? ''} className={field} />
          </div>
          {reps ? (
            <div>
              <label className="block text-sm font-medium" htmlFor="ownerUserId">Sales representative</label>
              <select id="ownerUserId" name="ownerUserId" defaultValue={c.ownerUserId ?? ''} className={field}>
                <option value="">Unassigned</option>
                {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
          ) : null}
        </div>

        <label className="mt-4 block text-sm font-medium" htmlFor="notes">Client notes</label>
        <textarea id="notes" name="notes" rows={4} defaultValue={c.notes ?? ''} className={field} />
      </section>

      {state.error ? (
        <p role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}

      <div className="flex gap-3">
        <button type="submit" disabled={pending}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
          {pending ? 'Saving…' : 'Save changes'}
        </button>
        <Link href={`/clients/${c.id}`} className="rounded-md border border-border px-4 py-2 text-sm">Cancel</Link>
      </div>
    </form>
  );
}
