'use server';

import { revalidatePath } from 'next/cache';
import { recordActivity } from '@/lib/auth/audit';
import { requireActor } from '@/lib/auth/dal';
import {
  PortalAccessError, createPortalLogin, resetPortalPassword, setAutoDeliver, setPortalLoginActive,
} from '@/lib/portal/access';

export interface PortalFormState {
  error?: string;
  notice?: string;
  temporaryPassword?: string;
  saved?: number;
}

async function guard<T>(fn: () => Promise<T>): Promise<T | PortalFormState> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof PortalAccessError) return { error: error.message };
    throw error;
  }
}
const isError = (v: unknown): v is PortalFormState => typeof v === 'object' && v !== null && 'error' in v;

export async function addPortalLogin(_prev: PortalFormState, formData: FormData): Promise<PortalFormState> {
  const actor = await requireActor();
  const clientId = Number(formData.get('clientId'));
  const result = await guard(() => createPortalLogin(actor, {
    clientId, fullName: String(formData.get('fullName') ?? ''), email: String(formData.get('email') ?? ''),
  }));
  if (isError(result)) return result;
  await recordActivity({
    actorId: actor.id, action: 'portal.login_created', entityType: 'user', entityId: result.userId, clientId,
  });
  revalidatePath(`/clients/${clientId}`);
  return {
    notice: 'Login created. Give them this password directly — it is shown once, and they choose their own at first sign-in.',
    temporaryPassword: result.temporaryPassword,
    saved: Date.now(),
  };
}

export async function togglePortalLogin(_prev: PortalFormState, formData: FormData): Promise<PortalFormState> {
  const actor = await requireActor();
  const userId = Number(formData.get('userId'));
  const active = formData.get('active') === 'true';
  const result = await guard(() => setPortalLoginActive(actor, { userId, active }));
  if (isError(result)) return result;
  await recordActivity({
    actorId: actor.id, action: active ? 'portal.login_enabled' : 'portal.login_disabled',
    entityType: 'user', entityId: userId, clientId: result.clientId,
  });
  revalidatePath(`/clients/${result.clientId}`);
  return { notice: active ? 'Access restored.' : 'Access removed; they are signed out.' };
}

export async function resetPortalLogin(_prev: PortalFormState, formData: FormData): Promise<PortalFormState> {
  const actor = await requireActor();
  const userId = Number(formData.get('userId'));
  const result = await guard(() => resetPortalPassword(actor, userId));
  if (isError(result)) return result;
  await recordActivity({
    actorId: actor.id, action: 'portal.password_reset', entityType: 'user', entityId: userId, clientId: result.clientId,
  });
  return { notice: 'New temporary password — shown once:', temporaryPassword: result.temporaryPassword };
}

export async function toggleAutoDeliver(_prev: PortalFormState, formData: FormData): Promise<PortalFormState> {
  const actor = await requireActor();
  const clientId = Number(formData.get('clientId'));
  const on = formData.get('on') === 'true';
  const result = await guard(() => setAutoDeliver(actor, { clientId, on }));
  if (isError(result)) return result;
  await recordActivity({
    actorId: actor.id, action: 'portal.auto_deliver_changed', entityType: 'client', entityId: clientId, clientId,
    metadata: { on },
  });
  revalidatePath(`/clients/${clientId}`);
  return { notice: on ? 'Approved files now go straight to the portal.' : 'Sales delivers each file again.' };
}
