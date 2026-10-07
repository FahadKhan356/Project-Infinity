import Link from 'next/link';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { INBOX_DEADLINE_DAYS, inbox, upcomingDeadlines } from '@/lib/notifications/inbox';
import { formatDateTime } from '@/lib/workspace/format';
import { markAllNotificationsRead, markNotificationRead } from './actions';

/**
 * The inbox (brief §20): what happened that concerns this person, newest
 * first, plus the deadlines coming up — computed now, not stored, so the
 * list is always current. The nightly run also stores a reminder as an item
 * comes within three days, falls due and goes overdue (reminders.ts); that
 * row is the message, and the Deadlines list is where the item stands now,
 * so the same item can appear in both until the reminder is read.
 */
export default async function NotificationsPage() {
  const actor = await requireActor();
  const [items, deadlines] = await Promise.all([
    inbox(actor, { limit: 100 }), upcomingDeadlines(actor, INBOX_DEADLINE_DAYS),
  ]);
  const unread = items.filter((i) => !i.isRead);
  const read = items.filter((i) => i.isRead);

  return (
    <AppShell actor={actor}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Inbox</h1>
          <p className="mt-1 text-sm text-muted">
            {unread.length === 0 ? 'Nothing unread.' : `${unread.length} unread.`}
            {' '}<Link href="/settings/notifications" className="underline-offset-2 hover:underline">Email, Slack and WhatsApp settings</Link>
          </p>
        </div>
        {unread.length > 0 ? (
          <form action={markAllNotificationsRead}>
            <button type="submit" className="text-sm text-muted hover:underline">Mark all read</button>
          </form>
        ) : null}
      </div>

      {deadlines.length > 0 ? (
        <section className="mt-6">
          <h2 className="text-sm font-semibold">Deadlines</h2>
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border bg-surface">
            {deadlines.map((d) => (
              <li key={`${d.kind}-${d.id}`} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2.5 text-sm">
                <span className={d.daysLeft < 0 ? 'font-medium text-red-600 dark:text-red-400' : 'font-medium'}>
                  {d.daysLeft < 0 ? `${-d.daysLeft} day${d.daysLeft === -1 ? '' : 's'} overdue`
                    : d.daysLeft === 0 ? 'Due today'
                    : `Due in ${d.daysLeft} day${d.daysLeft === 1 ? '' : 's'}`}
                </span>
                <Link href={d.linkPath} className="hover:underline">
                  {d.title}
                </Link>
                <span className="font-mono text-xs text-muted">{d.projectCode}</span>
                <span className="ml-auto text-xs text-muted">{d.kind} · {d.due}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-6">
        <h2 className="text-sm font-semibold">New</h2>
        {unread.length === 0 ? (
          <p className="mt-2 rounded-lg border border-border bg-surface px-4 py-5 text-sm text-muted">
            You are up to date.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border bg-surface">
            {unread.map((n) => <Row key={n.id} item={n} />)}
          </ul>
        )}
      </section>

      {read.length > 0 ? (
        <section className="mt-6">
          <h2 className="text-sm font-semibold text-muted">Earlier</h2>
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border bg-surface opacity-80">
            {read.map((n) => <Row key={n.id} item={n} />)}
          </ul>
        </section>
      ) : null}
    </AppShell>
  );
}

function Row({ item }: { item: { id: number; title: string; body: string | null; linkPath: string | null; isRead: boolean; createdAt: string } }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        {item.linkPath ? (
          <Link href={`/notifications/${item.id}/go`} className="font-medium hover:underline">{item.title}</Link>
        ) : (
          <span className="font-medium">{item.title}</span>
        )}
        {item.body ? <p className="mt-0.5 text-muted">{item.body}</p> : null}
      </div>
      <span className="shrink-0 text-xs tabular-nums text-muted">{formatDateTime(item.createdAt)}</span>
      {!item.isRead ? (
        <form action={markNotificationRead}>
          <input type="hidden" name="id" value={item.id} />
          <button type="submit" className="shrink-0 text-xs text-muted hover:underline" aria-label={`Mark “${item.title}” read`}>
            Mark read
          </button>
        </form>
      ) : null}
    </li>
  );
}
