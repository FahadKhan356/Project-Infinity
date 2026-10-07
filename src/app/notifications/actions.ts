'use server';

import { revalidatePath } from 'next/cache';
import { requireActor } from '@/lib/auth/dal';
import { markAllRead, markRead } from '@/lib/notifications/inbox';

export async function markNotificationRead(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = Number(formData.get('id'));
  if (Number.isInteger(id)) await markRead(actor, id);
  revalidatePath('/notifications');
}

export async function markAllNotificationsRead(): Promise<void> {
  const actor = await requireActor();
  await markAllRead(actor);
  revalidatePath('/notifications');
}
