import Link from 'next/link';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { NotificationIcon } from '@/components/notification-icon';
import { extractProjectMeta, getNotificationStyle } from '@/components/notification-meta';
import { INBOX_DEADLINE_DAYS, inbox, upcomingDeadlines, type InboxItem } from '@/lib/notifications/inbox';
import { formatDateTime } from '@/lib/workspace/format';
import { markAllNotificationsRead, markNotificationRead } from './actions';
import { SnackbarTriggerButton } from './snackbar-trigger-button';

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
    inbox(actor, { limit: 100 }),
    upcomingDeadlines(actor, INBOX_DEADLINE_DAYS),
  ]);
  const unread = items.filter((i) => !i.isRead);
  const read = items.filter((i) => i.isRead);

  return (
    <AppShell actor={actor}>
      {/* Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-surface px-5 py-4">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">Inbox</h1>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                unread.length > 0
                  ? 'bg-accent text-white'
                  : 'border border-border bg-background text-muted'
              }`}
            >
              {unread.length === 0 ? 'All caught up' : `${unread.length} unread`}
            </span>
            {deadlines.length > 0 ? (
              <span className="rounded-full border border-amber-500/35 bg-amber-500/12 px-2.5 py-0.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
                {deadlines.length} upcoming / due
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted">
            Real-time project updates, QA decisions, deliveries, and upcoming deadlines.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {unread.length > 0 ? (
            <form action={markAllNotificationsRead}>
              <button
                type="submit"
                className="rounded-lg border border-accent/35 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent transition-colors hover:bg-accent hover:text-white"
              >
                Mark all read
              </button>
            </form>
          ) : null}
          <Link
            href="/settings/notifications"
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-accent/40 hover:text-accent"
          >
            Email, Slack &amp; WhatsApp settings
          </Link>
        </div>
      </div>

      {/* Deadlines Section */}
      {deadlines.length > 0 ? (
        <section className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
              Deadlines &amp; Due Items ({deadlines.length})
            </h2>
          </div>
          <ul className="mt-3 space-y-3">
            {deadlines.map((d) => {
              const isOverdue = d.daysLeft < 0;
              const isToday = d.daysLeft === 0;
              return (
                <li
                  key={`${d.kind}-${d.id}`}
                  className="relative overflow-hidden rounded-xl border border-border bg-surface px-5 py-3.5 shadow-2xs transition-colors hover:border-accent/40"
                >
                  <span
                    className={`absolute inset-y-0 left-0 w-1.5 ${
                      isOverdue ? 'bg-rose-500' : isToday ? 'bg-amber-500' : 'bg-sky-500'
                    }`}
                    aria-hidden="true"
                  />
                  <div className="flex flex-wrap items-center gap-3 pl-2 text-sm">
                    <span
                      className={`inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold ${
                        isOverdue
                          ? 'border-rose-500/35 bg-rose-500/12 text-rose-600 dark:text-rose-400'
                          : isToday
                            ? 'border-amber-500/35 bg-amber-500/12 text-amber-600 dark:text-amber-400'
                            : 'border-sky-500/35 bg-sky-500/12 text-sky-600 dark:text-sky-400'
                      }`}
                    >
                      {isOverdue
                        ? `${-d.daysLeft} day${d.daysLeft === -1 ? '' : 's'} overdue`
                        : isToday
                          ? 'Due today'
                          : `Due in ${d.daysLeft} day${d.daysLeft === 1 ? '' : 's'}`}
                    </span>

                    <span className="rounded-md border border-accent/25 bg-accent/10 px-2 py-0.5 font-mono text-xs font-medium text-accent">
                      {d.projectCode}
                    </span>

                    <span className="rounded-md border border-border bg-background px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                      {d.kind}
                    </span>

                    <Link href={d.linkPath} className="font-semibold text-foreground hover:text-accent hover:underline">
                      {d.title}
                    </Link>

                    <span className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-sky-500/20 bg-sky-500/8 px-2.5 py-1 text-xs font-medium tabular-nums text-sky-600 dark:text-sky-400">
                      Due: {d.due}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* Unread / New Notifications */}
      <section className="mt-8">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-foreground">
            New Updates
          </h2>
          {unread.length > 0 ? (
            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-semibold text-accent">
              {unread.length}
            </span>
          ) : null}
        </div>
        {unread.length === 0 ? (
          <div className="mt-3 rounded-xl border border-border bg-surface px-5 py-6 text-sm text-muted">
            You are up to date — no unread notifications right now.
          </div>
        ) : (
          <ul className="mt-3 space-y-3.5">
            {unread.map((n) => (
              <Row key={n.id} item={n} />
            ))}
          </ul>
        )}
      </section>

      {/* Earlier / Read Notifications */}
      {read.length > 0 ? (
        <section className="mt-8">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
              Earlier ({read.length})
            </h2>
          </div>
          <ul className="mt-3 space-y-3.5">
            {read.map((n) => (
              <Row key={n.id} item={n} />
            ))}
          </ul>
        </section>
      ) : null}
    </AppShell>
  );
}

function Row({ item }: { item: InboxItem }) {
  const style = getNotificationStyle(item.type, item.title);
  const meta = extractProjectMeta(item.title, item.body);

  return (
    <li
      className={`group relative overflow-hidden rounded-xl border bg-surface px-5 py-4 shadow-2xs transition-all hover:border-accent/45 ${
        item.isRead ? 'border-border' : 'border-accent/45 ring-1 ring-accent/15'
      }`}
    >
      {/* Left colored status accent bar */}
      <span className={`absolute inset-y-0 left-0 w-1.5 ${style.accentBarClass}`} aria-hidden="true" />

      <div className="flex flex-col gap-3 pl-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3.5">
          {/* Status Icon */}
          <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${style.iconBgClass}`}>
            <NotificationIcon kind={style.iconKind} className="h-4 w-4" />
          </span>

          <div className="min-w-0 flex-1">
            {/* Top Meta Row: Status Pill + Unread Pill + Project Code + Project Name */}
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold ${style.badgeClass}`}>
                {style.label}
              </span>

              {!item.isRead ? (
                <span className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white">
                  <span className="h-1.5 w-1.5 rounded-full bg-white" />
                  Unread
                </span>
              ) : (
                <span className="inline-flex items-center rounded-md border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-muted">
                  Read
                </span>
              )}

              {meta.projectCode ? (
                <span className="inline-flex items-center rounded-md border border-accent/25 bg-accent/10 px-2 py-0.5 font-mono text-xs font-semibold text-accent">
                  {meta.projectCode}
                </span>
              ) : null}

              {meta.projectName ? (
                <span className="text-xs font-medium text-foreground/80">
                  {meta.projectName}
                </span>
              ) : null}
            </div>

            {/* Notification Title */}
            <div className="mt-2">
              {item.linkPath ? (
                <Link
                  href={`/notifications/${item.id}/go`}
                  className="text-[15px] font-semibold text-foreground transition-colors hover:text-accent hover:underline"
                >
                  {item.title}
                </Link>
              ) : (
                <span className="text-[15px] font-semibold text-foreground">{item.title}</span>
              )}
            </div>

            {/* Notification Body / Details */}
            {meta.cleanBody ? (
              <p className="mt-1 text-sm leading-relaxed text-muted">{meta.cleanBody}</p>
            ) : null}
          </div>
        </div>

        {/* Right Column: Date Pill + Actions */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-col sm:items-end">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/20 bg-sky-500/8 px-2.5 py-1 text-xs font-medium tabular-nums text-sky-600 dark:text-sky-400">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3.5 w-3.5" aria-hidden="true">
              <circle cx="10" cy="10" r="6.5" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 6.5V10l2.2 1.3" />
            </svg>
            {formatDateTime(item.createdAt)}
          </span>

          <div className="flex items-center gap-2">
            <SnackbarTriggerButton
              notice={{
                key: `notif-${item.id}`,
                id: item.id,
                type: item.type,
                title: item.title,
                body: item.body,
                linkPath: item.linkPath ? `/notifications/${item.id}/go` : '/notifications',
                createdAt: item.createdAt,
                isUnread: !item.isRead,
              }}
              label="Popup"
            />

            {item.linkPath ? (
              <Link
                href={`/notifications/${item.id}/go`}
                className="rounded-md border border-accent/30 bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent transition-colors hover:bg-accent hover:text-white"
              >
                Open →
              </Link>
            ) : null}

            {!item.isRead ? (
              <form action={markNotificationRead}>
                <input type="hidden" name="id" value={item.id} />
                <button
                  type="submit"
                  className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:border-foreground/30 hover:text-foreground"
                  aria-label={`Mark “${item.title}” read`}
                >
                  Mark read
                </button>
              </form>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}
