'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { clientServices } from '@/db/schema';
import { recordActivity } from '@/lib/auth/audit';
import { requireActor } from '@/lib/auth/dal';
import { assertCan } from '@/lib/authz';
import {
  ClientProfileError, createClientRecord, removeContact, saveContact, updateClientProfile,
  type ClientStatus, type ContactInput,
} from '@/lib/clients/profile';
import { copyMonth, parseCopyForm } from '@/lib/months/copy';
import { MonthError, closeMonth, openMonth, reopenMonth } from '@/lib/months/lifecycle';
import { IntakeError } from '@/lib/projects/file-project';
import { formatMonth } from '@/lib/projects/intake';
import { isClientVisible } from '@/lib/projects/queries';

export interface ClientFormState {
  error?: string;
  notice?: string;
  clientId?: number;
}

export async function createClient(
  _prev: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  const actor = await requireActor();
  const text = (key: string) => String(formData.get(key) ?? '').trim() || null;

  // §31 "date client started": defaults to the day the record is made; a
  // prospect has not started, so it is set when they become a client.
  let created;
  try {
    created = await createClientRecord(actor, {
      name: String(formData.get('name') ?? ''),
      companyName: text('companyName'),
      clientType: formData.get('clientType') === 'one_off' ? 'one_off' : 'retainer',
      status: formData.get('prospect') === 'on' ? 'prospect' : 'active',
      notes: text('notes'),
      startedOn: text('startedOn'),
    });
  } catch (error) {
    if (error instanceof ClientProfileError) return { error: error.message };
    throw error;
  }

  await recordActivity({
    actorId: actor.id,
    action: 'client.created',
    entityType: 'client',
    entityId: created.clientId,
    clientId: created.clientId,
    metadata: { name: created.name },
  });

  revalidatePath('/clients');
  return { notice: `Created ${created.name}.`, clientId: created.clientId };
}

function contactFrom(formData: FormData): ContactInput {
  const text = (key: string) => String(formData.get(key) ?? '').trim() || null;
  return {
    name: String(formData.get('contactName') ?? ''),
    email: text('contactEmail'),
    phone: text('contactPhone'),
    jobTitle: text('contactTitle'),
    isPrimary: formData.get('isPrimary') === 'on',
  };
}

/** Adds a contact, or edits one when the form carries a contactId (brief §31). */
export async function addContact(
  _prev: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  const actor = await requireActor();
  const clientId = Number(formData.get('clientId'));
  if (!Number.isInteger(clientId)) return { error: 'Unknown client.' };
  const rawContactId = formData.get('contactId');
  const contactId = rawContactId === null ? undefined : Number(rawContactId);
  if (contactId !== undefined && !Number.isInteger(contactId)) return { error: 'Unknown contact.' };
  const contact = contactFrom(formData);

  try {
    await saveContact(actor, { clientId, contactId, contact });
  } catch (error) {
    if (error instanceof ClientProfileError) return { error: error.message };
    throw error;
  }

  await recordActivity({
    actorId: actor.id,
    action: contactId === undefined ? 'client.contact_added' : 'client.contact_updated',
    entityType: 'client',
    entityId: clientId,
    clientId,
    metadata: { name: contact.name.trim() },
  });

  revalidatePath(`/clients/${clientId}`);
  return { notice: contactId === undefined ? 'Contact added.' : 'Contact saved.' };
}

export async function deleteContact(
  _prev: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  const actor = await requireActor();
  const clientId = Number(formData.get('clientId'));
  const contactId = Number(formData.get('contactId'));
  if (!Number.isInteger(clientId) || !Number.isInteger(contactId)) return { error: 'Unknown contact.' };

  let removed;
  try {
    removed = await removeContact(actor, { clientId, contactId });
  } catch (error) {
    if (error instanceof ClientProfileError) return { error: error.message };
    throw error;
  }

  await recordActivity({
    actorId: actor.id,
    action: 'client.contact_removed',
    entityType: 'client',
    entityId: clientId,
    clientId,
    metadata: { name: removed.name },
  });

  revalidatePath(`/clients/${clientId}`);
  return { notice: `Removed ${removed.name}.` };
}

/** Edits the permanent client record in place (brief §31). */
export async function updateClient(
  _prev: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  const actor = await requireActor();
  const clientId = Number(formData.get('clientId'));
  if (!Number.isInteger(clientId)) return { error: 'Unknown client.' };
  const text = (key: string) => String(formData.get(key) ?? '').trim() || null;
  const status = String(formData.get('status') ?? '') as ClientStatus;
  const ownerRaw = formData.get('ownerUserId');

  let result;
  try {
    result = await updateClientProfile(actor, {
      clientId,
      profile: {
        name: String(formData.get('name') ?? ''),
        companyName: text('companyName'),
        status,
        clientType: formData.get('clientType') === 'one_off' ? 'one_off' : 'retainer',
        startedOn: text('startedOn'),
        notes: text('notes'),
        // Only present on the form for those who may move a client.
        ownerUserId: ownerRaw === null ? undefined : ownerRaw === '' ? null : Number(ownerRaw),
      },
    });
  } catch (error) {
    if (error instanceof ClientProfileError) return { error: error.message };
    throw error;
  }

  if (result.changed.length > 0) {
    await recordActivity({
      actorId: actor.id,
      action: 'client.updated',
      entityType: 'client',
      entityId: clientId,
      clientId,
      metadata: { fields: result.changed },
    });
  }

  revalidatePath('/clients');
  revalidatePath(`/clients/${clientId}`);
  redirect(`/clients/${clientId}`);
}

export async function setClientServices(
  _prev: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  const actor = await requireActor();
  assertCan(actor, 'clients.manage');

  const clientId = Number(formData.get('clientId'));
  if (!Number.isInteger(clientId)) return { error: 'Unknown client.' };
  if (!(await isClientVisible(getDb(), actor, clientId))) return { error: 'Unknown client.' };

  const departmentIds = formData.getAll('service').map(Number).filter(Number.isInteger);

  const db = getDb();
  await db.delete(clientServices).where(eq(clientServices.clientId, clientId));
  if (departmentIds.length > 0) {
    await db
      .insert(clientServices)
      .values(departmentIds.map((departmentId) => ({ clientId, departmentId })));
  }

  await recordActivity({
    actorId: actor.id,
    action: 'client.services_changed',
    entityType: 'client',
    entityId: clientId,
    clientId,
    metadata: { departmentIds },
  });

  revalidatePath(`/clients/${clientId}`);
  return { notice: 'Services updated.' };
}

/**
 * "+ Create October 2026" (brief §37): opens the next monthly workspace for
 * a retainer client. Permanent client information is not re-entered — only
 * the bucket is new. A month already on record is reported as such; nothing
 * is written and no second opening is logged.
 */
export async function createNextMonth(
  _prev: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  const actor = await requireActor();
  const clientId = Number(formData.get('clientId'));
  const year = Number(formData.get('year'));
  const month = Number(formData.get('month'));

  if (!Number.isInteger(clientId) || !Number.isInteger(year) || !Number.isInteger(month)) {
    return { error: 'Unknown month.' };
  }

  let result;
  try {
    result = await openMonth(actor, { clientId, year, month });
  } catch (error) {
    if (error instanceof MonthError) return { error: error.message };
    throw error;
  }

  const label = formatMonth(year, month);
  if (!result.created) {
    return {
      notice: result.status === 'closed'
        ? `${label} is already on record and closed. Reopen it to file into it.`
        : `${label} is already open.`,
    };
  }

  await recordActivity({
    actorId: actor.id,
    action: 'client.month_opened',
    entityType: 'client_month',
    entityId: result.clientMonthId,
    clientId,
    metadata: { year, month },
  });

  revalidatePath(`/clients/${clientId}`);
  return { notice: `${label} created.` };
}

/** Sales (or the PM) archives a finished month (brief §36). */
export async function closeClientMonth(
  _prev: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  const actor = await requireActor();
  const clientMonthId = Number(formData.get('clientMonthId'));
  if (!Number.isInteger(clientMonthId)) return { error: 'Unknown month.' };

  let result;
  try {
    result = await closeMonth(actor, { clientMonthId });
  } catch (error) {
    if (error instanceof MonthError) return { error: error.message };
    throw error;
  }

  await recordActivity({
    actorId: actor.id,
    action: 'client.month_closed',
    entityType: 'client_month',
    entityId: result.clientMonthId,
    clientId: result.clientId,
    metadata: { year: result.year, month: result.month, projectCount: result.projectCount },
  });

  revalidatePath(`/clients/${result.clientId}`);
  return { notice: `${formatMonth(result.year, result.month)} closed.` };
}

/** Management unlocks an archived month so its records can change (brief §36). */
export async function reopenClientMonth(
  _prev: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  const actor = await requireActor();
  const clientMonthId = Number(formData.get('clientMonthId'));
  if (!Number.isInteger(clientMonthId)) return { error: 'Unknown month.' };

  let result;
  try {
    result = await reopenMonth(actor, { clientMonthId });
  } catch (error) {
    if (error instanceof MonthError) return { error: error.message };
    throw error;
  }

  await recordActivity({
    actorId: actor.id,
    action: 'client.month_reopened',
    entityType: 'client_month',
    entityId: result.clientMonthId,
    clientId: result.clientId,
    metadata: { year: result.year, month: result.month },
  });

  revalidatePath(`/clients/${result.clientId}`);
  return { notice: `${formatMonth(result.year, result.month)} reopened.` };
}

/** Sales copies last month's orders forward (brief §38). */
export async function copyClientMonth(
  _prev: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  const actor = await requireActor();

  let result;
  try {
    const input = parseCopyForm(formData);
    if (!Number.isInteger(input.clientId) || !Number.isInteger(input.fromMonthId)) {
      return { error: 'Unknown month.' };
    }
    result = await copyMonth(actor, input);
  } catch (error) {
    if (error instanceof MonthError || error instanceof IntakeError) return { error: error.message };
    throw error;
  }

  const [from] = await getDb().execute<{ period_year: number; period_month: number }>(sql`
    SELECT period_year, period_month FROM client_months WHERE id = ${Number(formData.get('fromMonthId'))}
  `);
  const fromLabel = from ? formatMonth(Number(from.period_year), Number(from.period_month)) : null;

  await recordActivity({
    actorId: actor.id,
    action: 'client.month_copied',
    entityType: 'client_month',
    entityId: result.clientMonthId,
    clientId: result.clientId,
    metadata: {
      year: result.year, month: result.month, fromLabel,
      projectCount: result.projects.length, monthCreated: result.monthCreated,
      projectCodes: result.projects.map((p) => p.projectCode),
    },
  });
  // Each new project also gets its own first line, so its feed starts the
  // way every other project's does — and says where it came from.
  for (const p of result.projects) {
    await recordActivity({
      actorId: actor.id,
      action: 'project.created',
      entityType: 'project',
      entityId: p.projectId,
      projectId: p.projectId,
      clientId: result.clientId,
      metadata: { projectCode: p.projectCode, copiedFromCode: p.copiedFromCode, copiedFromId: p.copiedFromId },
    });
  }

  revalidatePath('/projects');
  revalidatePath('/triage');
  revalidatePath(`/clients/${result.clientId}`);
  redirect(`/clients/${result.clientId}?copied=${result.projects.length}`);
}
