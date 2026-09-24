'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { clientContacts, clientServices, clients } from '@/db/schema';
import { recordActivity } from '@/lib/auth/audit';
import { requireActor } from '@/lib/auth/dal';
import { assertCan, can } from '@/lib/authz';
import { copyMonth, parseCopyForm } from '@/lib/months/copy';
import { MonthError, closeMonth, reopenMonth } from '@/lib/months/lifecycle';
import { IntakeError } from '@/lib/projects/file-project';
import { formatMonth } from '@/lib/projects/intake';
import { isClientVisible } from '@/lib/projects/queries';

export interface ClientFormState {
  error?: string;
  notice?: string;
  clientId?: number;
}

const DUPLICATE_NAME = '23505';

export async function createClient(
  _prev: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  const actor = await requireActor();
  assertCan(actor, 'clients.manage');

  const name = String(formData.get('name') ?? '').trim();
  const companyName = String(formData.get('companyName') ?? '').trim() || null;
  const clientType = formData.get('clientType') === 'one_off' ? 'one_off' : 'retainer';
  const notes = String(formData.get('notes') ?? '').trim() || null;

  if (name.length < 2) return { error: 'Enter the client’s name.' };

  try {
    const [created] = await getDb()
      .insert(clients)
      .values({
        name,
        companyName,
        clientType,
        notes,
        // The rep who books the client owns it, which is what scopes their
        // visibility later (brief §23, §31).
        ownerUserId: actor.role === 'sales' ? actor.id : null,
        createdBy: actor.id,
      })
      .returning({ id: clients.id });

    await recordActivity({
      actorId: actor.id,
      action: 'client.created',
      entityType: 'client',
      entityId: created.id,
      clientId: created.id,
      metadata: { name },
    });

    revalidatePath('/clients');
    return { notice: `Created ${name}.`, clientId: created.id };
  } catch (error) {
    if ((error as { code?: string }).code === DUPLICATE_NAME) {
      // The unique index on lower(name) is what keeps "ABC Company" and
      // "abc company" from becoming two histories (brief §31).
      return { error: `A client called “${name}” already exists. Open that record instead.` };
    }
    throw error;
  }
}

export async function addContact(
  _prev: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  const actor = await requireActor();
  assertCan(actor, 'clients.manage');

  const clientId = Number(formData.get('clientId'));
  const name = String(formData.get('contactName') ?? '').trim();
  if (!Number.isInteger(clientId)) return { error: 'Unknown client.' };
  if (!name) return { error: 'Enter the contact’s name.' };
  if (!(await isClientVisible(getDb(), actor, clientId))) return { error: 'Unknown client.' };

  await getDb().insert(clientContacts).values({
    clientId,
    name,
    email: String(formData.get('contactEmail') ?? '').trim() || null,
    phone: String(formData.get('contactPhone') ?? '').trim() || null,
    jobTitle: String(formData.get('contactTitle') ?? '').trim() || null,
    isPrimary: formData.get('isPrimary') === 'on',
  });

  await recordActivity({
    actorId: actor.id,
    action: 'client.contact_added',
    entityType: 'client',
    entityId: clientId,
    clientId,
    metadata: { name },
  });

  revalidatePath(`/clients/${clientId}`);
  return { notice: 'Contact added.' };
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
 * Opens the next monthly workspace for a retainer client (brief §37).
 * Permanent client information is not re-entered — only the bucket is new.
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
  if (!can(actor, 'projects.create')) {
    return { error: 'You are not permitted to open a month.' };
  }
  if (!(await isClientVisible(getDb(), actor, clientId))) return { error: 'Unknown client.' };

  await getDb().execute(sql`
    INSERT INTO client_months (client_id, period_year, period_month, created_by)
    VALUES (${clientId}, ${year}, ${month}, ${actor.id})
    ON CONFLICT (client_id, period_year, period_month) DO NOTHING
  `);

  await recordActivity({
    actorId: actor.id,
    action: 'client.month_opened',
    entityType: 'client',
    entityId: clientId,
    clientId,
    metadata: { year, month },
  });

  revalidatePath(`/clients/${clientId}`);
  return { notice: 'Month opened.' };
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
