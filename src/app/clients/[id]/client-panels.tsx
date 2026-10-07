'use client';

import { useActionState } from 'react';
import {
  addContact,
  deleteContact,
  setClientServices,
  type ClientFormState,
} from '../actions';
import { CreateMonthForm } from './create-month-form';
import { Feedback } from './feedback';

const initial: ClientFormState = {};
const field =
  'mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent';
const card = 'rounded-lg border border-border bg-surface p-6';

interface Props {
  clientId: number;
  canManage: boolean;
  canOpenMonth: boolean;
  /** The month "+ Create …" offers: the one after the newest on record (§37), chosen by the page. */
  nextMonth: { year: number; month: number; label: string };
  contacts: { id: number; name: string; email: string | null; phone: string | null; job_title: string | null; is_primary: boolean }[];
  services: number[];
  departments: { id: number; name: string }[];
  notes: string | null;
}

type Contact = Props['contacts'][number];

/** Edit or remove one contact, folded away until needed. */
function ContactEditor({ clientId, contact: c }: { clientId: number; contact: Contact }) {
  const [saveState, saveAction, saving] = useActionState(addContact, initial);
  const [removeState, removeAction, removing] = useActionState(deleteContact, initial);
  const key = `c${c.id}`;
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-muted hover:text-foreground">Edit</summary>
      <form action={saveAction} className="mt-2 rounded-md border border-border p-3">
        <input type="hidden" name="clientId" value={clientId} />
        <input type="hidden" name="contactId" value={c.id} />
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium" htmlFor={`${key}-name`}>Name</label>
            <input id={`${key}-name`} name="contactName" required defaultValue={c.name} className={field} />
          </div>
          <div>
            <label className="block text-xs font-medium" htmlFor={`${key}-title`}>Job title</label>
            <input id={`${key}-title`} name="contactTitle" defaultValue={c.job_title ?? ''} className={field} />
          </div>
          <div>
            <label className="block text-xs font-medium" htmlFor={`${key}-email`}>Email</label>
            <input id={`${key}-email`} name="contactEmail" type="email" defaultValue={c.email ?? ''} className={field} />
          </div>
          <div>
            <label className="block text-xs font-medium" htmlFor={`${key}-phone`}>Phone</label>
            <input id={`${key}-phone`} name="contactPhone" defaultValue={c.phone ?? ''} className={field} />
          </div>
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" name="isPrimary" defaultChecked={c.is_primary} /> Primary contact
        </label>
        <Feedback state={saveState} />
        <div className="mt-3 flex gap-2">
          <button type="submit" disabled={saving}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="submit" formAction={removeAction} disabled={removing} formNoValidate
            className="rounded-md border border-border px-3 py-1.5 text-xs disabled:opacity-60">
            {removing ? 'Removing…' : 'Remove contact'}
          </button>
        </div>
        <Feedback state={removeState} />
      </form>
    </details>
  );
}

export function ClientPanels({
  clientId, canManage, canOpenMonth, nextMonth: next, contacts, services, departments, notes,
}: Props) {
  const [contactState, contactAction, contactPending] = useActionState(addContact, initial);
  const [serviceState, serviceAction, servicePending] = useActionState(setClientServices, initial);

  return (
    <div className="mt-8 grid gap-6 lg:grid-cols-2">
      <section className={card}>
        <h2 className="text-sm font-semibold">Contacts</h2>
        {contacts.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No contacts recorded.</p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {contacts.map((c) => (
              <li key={c.id}>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{c.name}</span>
                  {c.is_primary ? <span className="text-xs text-accent">primary</span> : null}
                  {c.job_title ? <span className="text-xs text-muted">{c.job_title}</span> : null}
                  <span className="text-xs text-muted">{[c.email, c.phone].filter(Boolean).join(' · ')}</span>
                </div>
                {canManage ? <ContactEditor clientId={clientId} contact={c} /> : null}
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
          <CreateMonthForm clientId={clientId} nextMonth={next} className="mt-6 border-t border-border pt-5" />
        ) : null}
      </section>
    </div>
  );
}
