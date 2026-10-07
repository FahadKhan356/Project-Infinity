import 'server-only';
import { and, eq, ne, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { clientContacts, clients } from '@/db/schema';
import type { Actor } from '@/lib/authz';
import { can } from '@/lib/authz';
import { isClientVisible } from '@/lib/projects/queries';

export class ClientProfileError extends Error {}

export type ClientStatus = 'prospect' | 'active' | 'paused' | 'churned';
export type ClientType = 'retainer' | 'one_off';
export const CLIENT_STATUSES: ClientStatus[] = ['prospect', 'active', 'paused', 'churned'];

/** The permanent part of a client (brief §31), edited in place for years. */
export interface ClientProfile {
  name: string;
  companyName: string | null;
  status: ClientStatus;
  clientType: ClientType;
  startedOn: string | null;
  notes: string | null;
  /**
   * The Sales representative. `undefined` leaves it alone. Only someone who
   * sees every client may move one, because the owner is what scopes a rep's
   * view (§23): a rep handing a client away would lose it mid-edit.
   */
  ownerUserId?: number | null;
}

const COLUMNS: Record<Exclude<keyof ClientProfile, never>, { column: string; label: string }> = {
  name: { column: 'name', label: 'name' },
  companyName: { column: 'company_name', label: 'company' },
  status: { column: 'status', label: 'status' },
  clientType: { column: 'client_type', label: 'type' },
  startedOn: { column: 'started_on', label: 'start date' },
  notes: { column: 'notes', label: 'notes' },
  ownerUserId: { column: 'owner_user_id', label: 'sales representative' },
};

/**
 * True for a unique-constraint violation. Drizzle wraps the driver's error,
 * so the Postgres code sits on `cause`; checking `code` alone never matches.
 */
export function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface NewClientInput {
  name: string;
  companyName: string | null;
  clientType: ClientType;
  /** A prospect is a name in the pipeline (§29); anything else is an active client. */
  status: 'prospect' | 'active';
  notes: string | null;
  /** §31 "date client started". Empty: today for an active client, unset for a prospect. */
  startedOn?: string | null;
}

/**
 * Makes the permanent client record (brief §31) — once; every project
 * afterwards hangs off it. The rep who books the client owns it, which is
 * what scopes their visibility later (§23). A prospect has not started, so
 * its start date is set the day it becomes a client (winOpportunity,
 * updateClientProfile), not the day it was noted down.
 */
export async function createClientRecord(
  actor: Actor,
  input: NewClientInput,
): Promise<{ clientId: number; name: string }> {
  if (!can(actor, 'clients.manage')) throw new ClientProfileError('You are not permitted to create clients.');
  const name = input.name.trim();
  if (name.length < 2) throw new ClientProfileError('Enter the client’s name.');
  const startedOnRaw = input.startedOn?.trim() || null;
  if (startedOnRaw !== null && !DATE.test(startedOnRaw)) throw new ClientProfileError('Enter the start date as a date.');
  const status = input.status === 'prospect' ? 'prospect' : 'active';
  const clientType = input.clientType === 'one_off' ? 'one_off' : 'retainer';

  try {
    const [created] = await getDb()
      .insert(clients)
      .values({
        name,
        companyName: input.companyName?.trim() || null,
        clientType,
        status,
        notes: input.notes?.trim() || null,
        startedOn: status === 'prospect' ? null : (startedOnRaw ?? sql`current_date`),
        ownerUserId: actor.role === 'sales' ? actor.id : null,
        createdBy: actor.id,
      })
      .returning({ id: clients.id });
    return { clientId: created.id, name };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The unique index on lower(name) is what keeps "ABC Company" and
      // "abc company" from becoming two histories (brief §31).
      throw new ClientProfileError(`A client called “${name}” already exists. Open that record instead.`);
    }
    throw error;
  }
}

export async function updateClientProfile(
  actor: Actor,
  input: { clientId: number; profile: ClientProfile },
): Promise<{ clientId: number; changed: string[] }> {
  if (!can(actor, 'clients.manage')) throw new ClientProfileError('You are not permitted to edit clients.');
  const db = getDb();
  if (!(await isClientVisible(db, actor, input.clientId))) throw new ClientProfileError('Unknown client.');

  const p = { ...input.profile, name: input.profile.name.trim() };
  if (p.name.length < 2) throw new ClientProfileError('Enter the client’s name.');
  if (!CLIENT_STATUSES.includes(p.status)) throw new ClientProfileError('Choose a status.');
  if (p.clientType !== 'retainer' && p.clientType !== 'one_off') throw new ClientProfileError('Choose a type.');
  if (p.startedOn !== null && !DATE.test(p.startedOn)) throw new ClientProfileError('Enter a valid start date.');

  const keys = (Object.keys(COLUMNS) as (keyof ClientProfile)[])
    .filter((k) => k !== 'ownerUserId' || p.ownerUserId !== undefined);
  if (p.ownerUserId !== undefined) {
    if (!can(actor, 'clients.viewAll')) {
      throw new ClientProfileError('Only management can move a client to another representative.');
    }
    if (p.ownerUserId !== null) {
      const [rep] = await db.execute<{ id: number }>(sql`
        SELECT id FROM users WHERE id = ${p.ownerUserId} AND role = 'sales' AND is_active
      `);
      if (!rep) throw new ClientProfileError('Choose an active Sales representative.');
    }
  }

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx.execute<Record<string, string | number | null>>(sql`
        SELECT name, company_name, status::text AS status, client_type::text AS client_type,
               started_on::text AS started_on, notes, owner_user_id, current_date::text AS today
        FROM clients WHERE id = ${input.clientId} FOR UPDATE
      `);
      if (!row) throw new ClientProfileError('Unknown client.');
      // A prospect becoming a client starts today (§31 "date client
      // started") unless the form says when, as the pipeline win does.
      if (row.status === 'prospect' && p.status === 'active' && p.startedOn === null) {
        p.startedOn = String(row.today);
      }
      const changed = keys.filter((k) => {
        const before = row[COLUMNS[k].column];
        return (before === null ? null : String(before)) !== (p[k] == null ? null : String(p[k]));
      });
      if (changed.length > 0) {
        await tx.execute(sql`
          UPDATE clients SET ${sql.join(
            changed.map((k) => sql`${sql.identifier(COLUMNS[k].column)} = ${p[k] ?? null}`),
            sql`, `,
          )}
          WHERE id = ${input.clientId}
        `);
      }
      return { clientId: input.clientId, changed: changed.map((k) => COLUMNS[k].label) };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Renaming onto another client would merge two histories by name (§31).
      throw new ClientProfileError(`Another client is already called “${p.name}”.`);
    }
    throw error;
  }
}

export interface ContactInput {
  name: string;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  isPrimary: boolean;
}

/** Adds a contact, or edits one when `contactId` is given. One primary per client. */
export async function saveContact(
  actor: Actor,
  input: { clientId: number; contactId?: number; contact: ContactInput },
): Promise<{ contactId: number }> {
  if (!can(actor, 'clients.manage')) throw new ClientProfileError('You are not permitted to edit clients.');
  const name = input.contact.name.trim();
  if (!name) throw new ClientProfileError('Enter the contact’s name.');
  const db = getDb();
  if (!(await isClientVisible(db, actor, input.clientId))) throw new ClientProfileError('Unknown client.');

  return db.transaction(async (tx) => {
    const values = { ...input.contact, name };
    let contactId: number;
    if (input.contactId === undefined) {
      const [created] = await tx.insert(clientContacts)
        .values({ clientId: input.clientId, ...values })
        .returning({ id: clientContacts.id });
      contactId = created.id;
    } else {
      // Scoped to the client, so a form cannot edit another client's contact.
      const updated = await tx.update(clientContacts).set(values)
        .where(and(eq(clientContacts.id, input.contactId), eq(clientContacts.clientId, input.clientId)))
        .returning({ id: clientContacts.id });
      if (updated.length === 0) throw new ClientProfileError('Unknown contact.');
      contactId = updated[0].id;
    }
    if (values.isPrimary) {
      await tx.update(clientContacts).set({ isPrimary: false })
        .where(and(eq(clientContacts.clientId, input.clientId), ne(clientContacts.id, contactId)));
    }
    return { contactId };
  });
}

export async function removeContact(
  actor: Actor,
  input: { clientId: number; contactId: number },
): Promise<{ name: string }> {
  if (!can(actor, 'clients.manage')) throw new ClientProfileError('You are not permitted to edit clients.');
  const db = getDb();
  if (!(await isClientVisible(db, actor, input.clientId))) throw new ClientProfileError('Unknown client.');
  const removed = await db.delete(clientContacts)
    .where(and(eq(clientContacts.id, input.contactId), eq(clientContacts.clientId, input.clientId)))
    .returning({ name: clientContacts.name });
  if (removed.length === 0) throw new ClientProfileError('Unknown contact.');
  return removed[0];
}
