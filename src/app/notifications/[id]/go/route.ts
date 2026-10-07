import { redirect } from 'next/navigation';
import { requireActor } from '@/lib/auth/dal';
import { markRead } from '@/lib/notifications/inbox';

/** Opening a notification marks it read and lands on what it is about. */
export async function GET(_request: Request, context: RouteContext<'/notifications/[id]/go'>) {
  const actor = await requireActor();
  const { id } = await context.params;
  const notificationId = Number(id);
  const result = Number.isInteger(notificationId) ? await markRead(actor, notificationId) : null;
  // Only the person's own notifications resolve; anything else goes home.
  const target = result?.linkPath && result.linkPath.startsWith('/') ? result.linkPath : '/notifications';
  redirect(target);
}
