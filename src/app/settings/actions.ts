'use server';

import { revalidatePath } from 'next/cache';
import { getActor } from '@/lib/auth/dal';
import { ChannelPrefError, setChannelPref } from '@/lib/channels/prefs';
import type { Channel } from '@/lib/channels/config';

export interface PrefState {
  error?: string;
  notice?: string;
}

/** Staff and client logins both set their own channels, so this takes either. */
export async function saveChannelPref(_prev: PrefState, formData: FormData): Promise<PrefState> {
  const actor = await getActor();
  if (!actor || actor.mustChangePassword) return { error: 'Sign in again.' };
  const channel = String(formData.get('channel') ?? '') as Channel;
  const enabled = formData.get('enabled') === 'on';
  try {
    await setChannelPref(actor, { channel, enabled, address: String(formData.get('address') ?? '') });
  } catch (error) {
    if (error instanceof ChannelPrefError) return { error: error.message };
    throw error;
  }
  revalidatePath('/settings/notifications');
  revalidatePath('/portal/settings');
  return { notice: enabled ? 'On. New notifications will be sent here too.' : 'Off.' };
}
