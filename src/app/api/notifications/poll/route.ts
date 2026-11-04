import { getActor } from '@/lib/auth/dal';
import {
  INBOX_DEADLINE_DAYS,
  deadlineCount,
  inbox,
  markRead,
  upcomingDeadlines,
  unreadCount,
} from '@/lib/notifications/inbox';

export const dynamic = 'force-dynamic';

export async function GET() {
  const actor = await getActor();
  if (!actor || actor.mustChangePassword || actor.role === 'client') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [unread, due, unreadItems, recentItems, deadlines] = await Promise.all([
    unreadCount(actor),
    deadlineCount(actor, INBOX_DEADLINE_DAYS),
    inbox(actor, { limit: 5, unreadOnly: true }),
    inbox(actor, { limit: 3 }),
    upcomingDeadlines(actor, INBOX_DEADLINE_DAYS),
  ]);

  return Response.json({
    unreadCount: unread,
    dueCount: due,
    unreadItems,
    recentItems,
    deadlines: deadlines.slice(0, 3),
  });
}

export async function POST(request: Request) {
  const actor = await getActor();
  if (!actor || actor.mustChangePassword || actor.role === 'client') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = (await request.json()) as { id?: number };
    const id = Number(body.id);
    if (Number.isInteger(id) && id > 0) {
      await markRead(actor, id);
    }
    const [unread, due] = await Promise.all([
      unreadCount(actor),
      deadlineCount(actor, INBOX_DEADLINE_DAYS),
    ]);
    return Response.json({ ok: true, unreadCount: unread, dueCount: due });
  } catch {
    return Response.json({ error: 'Invalid request' }, { status: 400 });
  }
}

