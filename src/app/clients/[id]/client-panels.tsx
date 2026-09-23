'use client';

import { useActionState } from 'react';
import {
  addContact,
  createNextMonth,
  setClientServices,
  type ClientFormState,
} from '../actions';

const initial: ClientFormState = {};
const field =
  'mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent';
const card = 'rounded-lg border border-border bg-surface p-6';

interface Props {
  clientId: number;
  canManage: boolean;
  canOpenMonth: boolean;
  contacts: { id: number; name: string; email: string | null; phone: string | null; job_title: string | null; is_primary: boolean }[];
  services: number[];
  departments: { id: number; name: string }[];
  notes: string | null;
}

function Feedback({ state }: { state: ClientFormState }) {
  if (state.error) {
    return (
      <p role="alert" className="mt-4 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
        {state.error}
      </p>
    );
  }
  if (state.notice) {
    return <p role="status" className="mt-4 rounded-md bg-accent/10 px-3 py-2 text-sm">{state.notice}</p>;
  }
  return null;
}

/** The next calendar month, which is what "open the next month" means (§37). */
function nextMonth() {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    label: d.toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  };
}

export function ClientPanels({
  clientId, canManage, canOpenMonth, contacts, services, departments, notes,
}: Props) {
  const [contactState, contactAction, contactPending] = useActionState(addContact, initial);
  const [serviceState, serviceAction, servicePending] = useActionState(setClientServices, initial);
  const [monthState, monthAction, monthPending] = useActionState(createNextMonth, initial);
  const next = nextMonth();

  return (
    <div className="mt-8 grid gap-6 lg:grid-cols-2">
      <section className={card}>
        <h2 className="text-sm font-semibold">Contacts</h2>
        {contacts.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No contacts recorded.</p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {contacts.map((c) => (
              <li key={c.id} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{c.name}</span>
                {c.is_primary ? <span className="text-xs text-accent">primary</span> : null}
                {c.job_title ? <span className="text-xs text-muted">{c.job_title}</span> : null}
                <span className="text-xs text-muted">{[c.email, c.phone].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
        )}

        {canManage ? (
          <form action={contactAction} className="mt-5 border-t border-border pt-5">
            <input type="hidden" name="clientId" value={clientId} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium" htmlFor="contactName">Name</label>
                <input id="contactName" name="contactName" required className={field} />
              </div>
              <div>
                <label className="block text-sm font-medium" htmlFor="contactTitle">Job title</label>
                <input id="contactTitle" name="contactTitle" className={field} />
              </div>
              <div>
                <label className="block text-sm font-medium" htmlFor="contactEmail">Email</label>
                <input id="contactEmail" name="contactEmail" type="email" className={field} />
              </div>
              <div>
                <label className="block text-sm font-medium" htmlFor="contactPhone">Phone</label>
                <input id="contactPhone" name="contactPhone" className={field} />
              </div>
            </div>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input type="checkbox" name="isPrimary" /> Primary contact
            </label>
            <Feedback state={contactState} />
            <button type="submit" disabled={contactPending}
              className="mt-4 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
              {contactPending ? 'Adding…' : 'Add contact'}
            </button>
          </form>
        ) : null}
      </section>

      <section className={card}>
        <h2 className="text-sm font-semibold">Services</h2>
        <p className="mt-1 text-xs text-muted">What Aktivacity delivers for this client (brief §31).</p>
        <form action={serviceAction} className="mt-4">
          <input type="hidden" name="clientId" value={clientId} />
          <ul className="space-y-2">
            {departments.map((d) => (
              <li key={d.id}>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="service" value={d.id}
                    defaultChecked={services.includes(d.id)} disabled={!canManage} />
                  {d.name}
                </label>
              </li>
            ))}
          </ul>
          <Feedback state={serviceState} />
          {canManage ? (
            <button type="submit" disabled={servicePending}
              className="mt-4 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
              {servicePending ? 'Saving…' : 'Save services'}
            </button>
          ) : null}
        </form>

        {notes ? (
          <div className="mt-6 border-t border-border pt-5">
            <h3 className="text-sm font-semibold">Notes</h3>
            <p className="mt-2 whitespace-pre-wrap text-sm text-muted">{notes}</p>
          </div>
        ) : null}

        {canOpenMonth ? (
          <form action={monthAction} className="mt-6 border-t border-border pt-5">
            <input type="hidden" name="clientId" value={clientId} />
            <input type="hidden" name="year" value={next.year} />
            <input type="hidden" name="month" value={next.month} />
            <h3 className="text-sm font-semibold">Next month</h3>
            <p className="mt-1 text-xs text-muted">
              Opens {next.label} without re-entering anything about the client. Filing a project
              for a month opens it automatically, so this is only needed to plan ahead.
            </p>
            <Feedback state={monthState} />
            <button type="submit" disabled={monthPending}
              className="mt-4 rounded-md border border-border px-3 py-2 text-sm font-medium disabled:opacity-60">
              {monthPending ? 'Opening…' : `Open ${next.label}`}
            </button>
          </form>
        ) : null}
      </section>
    </div>
  );
}
