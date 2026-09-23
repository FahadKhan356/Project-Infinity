import { redirect } from 'next/navigation';
import { getActor } from '@/lib/auth/dal';
import { recordActivity } from '@/lib/auth/audit';
import { destroySession } from '@/lib/auth/session';

export async function POST() {
  const actor = await getActor();
  if (actor) {
    await recordActivity({
      actorId: actor.id,
      action: 'auth.logout',
      entityType: 'user',
      entityId: actor.id,
    });
  }
  await destroySession();
  redirect('/login');
}
