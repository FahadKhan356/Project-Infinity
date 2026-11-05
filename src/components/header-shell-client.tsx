'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NotificationIcon } from './notification-icon';
import { extractProjectMeta, getNotificationStyle } from './notification-meta';
import { CurrencyDomSynchronizer, CurrencySwipeToggle } from './currency-switcher';

export interface NavItem {
  href: string;
  label: string;
  group: 'workspace' | 'production' | 'commercial' | 'management';
}

export interface SnackbarNotice {
  key: string;
  id?: number;
  type: string;
  title: string;
  body: string | null;
  linkPath: string | null;
  createdAt: string;
  isUnread?: boolean;
}

interface PollResponse {
  unreadCount: number;
  dueCount: number;
  unreadItems: {
    id: number;
    type: string;
    title: string;
    body: string | null;
    linkPath: string | null;
    isRead: boolean;
    createdAt: string;
  }[];
  recentItems: {
    id: number;
    type: string;
    title: string;
    body: string | null;
    linkPath: string | null;
    isRead: boolean;
    createdAt: string;
  }[];
  deadlines: {
    kind: 'project' | 'assignment' | 'revision';
    id: number;
    projectCode: string;
    title: string;
    linkPath: string;
    due: string;
    daysLeft: number;
  }[];
}

const GROUP_LABELS: Record<NavItem['group'], string> = {
  workspace: 'Workspace',
  production: 'Production',
  commercial: 'Commercial',
  management: 'Management',
};

const GROUP_ORDER: NavItem['group'][] = ['workspace', 'production', 'commercial', 'management'];

function formatShortTime(isoOrDate: string): string {
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return isoOrDate;
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

export function HeaderShellClient({
  userId,
  fullName,
  roleLabel,
  links,
  initialUnread,
  initialDue,
  initialUnreadItems,
  initialRecentItems,
  initialDeadlines,
}: {
  userId: number;
  fullName: string;
  roleLabel: string;
  links: NavItem[];
  initialUnread: number;
  initialDue: number;
  initialUnreadItems: PollResponse['unreadItems'];
  initialRecentItems: PollResponse['recentItems'];
  initialDeadlines: PollResponse['deadlines'];
}) {
  const pathname = usePathname();
  const initialSignature = `${initialUnread}:${initialDue}`;
  const [polledCounts, setPolledCounts] = useState<{
    unread: number;
    due: number;
    signature: string;
  } | null>(null);

  const unread = polledCounts?.signature === initialSignature ? polledCounts.unread : initialUnread;
  const due = polledCounts?.signature === initialSignature ? polledCounts.due : initialDue;

  const [toasts, setToasts] = useState<SnackbarNotice[]>([]);
  const [latestPreview, setLatestPreview] = useState<SnackbarNotice | null>(() => {
    const first = initialUnreadItems[0] ?? initialRecentItems[0];
    if (first) {
      return {
        key: `notif-${first.id}`,
        id: first.id,
        type: first.type,
        title: first.title,
        body: first.body,
        linkPath: first.linkPath ? `/notifications/${first.id}/go` : '/notifications',
        createdAt: first.createdAt,
        isUnread: !first.isRead,
      };
    }
    const d = initialDeadlines[0];
    if (d) {
      const overdue = d.daysLeft < 0;
      const statusText = overdue
        ? `${-d.daysLeft} day${d.daysLeft === -1 ? '' : 's'} overdue`
        : d.daysLeft === 0
          ? 'Due today'
          : `Due in ${d.daysLeft} day${d.daysLeft === 1 ? '' : 's'}`;
      return {
        key: `due-${d.kind}-${d.id}`,
        type: overdue ? 'deadline.overdue' : 'deadline.approaching',
        title: `${statusText}: ${d.title}`,
        body: `${d.projectCode} · Scheduled due date ${d.due}`,
        linkPath: d.linkPath,
        createdAt: d.due,
        isUnread: false,
      };
    }
    return null;
  });

  const seenKeysRef = useRef<Set<string>>(new Set());
  const storageKey = `aktivacity_seen_snackbars_v1_${userId}`;

  const enqueueNotices = useCallback(
    (notices: SnackbarNotice[], force = false) => {
      if (notices.length === 0) return;
      setToasts((prev) => {
        const existingKeys = new Set(prev.map((t) => t.key));
        const additions: SnackbarNotice[] = [];
        for (const n of notices) {
          if (existingKeys.has(n.key)) continue;
          if (!force && seenKeysRef.current.has(n.key)) continue;
          seenKeysRef.current.add(n.key);
          additions.push(n);
        }
        if (additions.length === 0) return prev;
        try {
          sessionStorage.setItem(storageKey, JSON.stringify([...seenKeysRef.current].slice(-100)));
        } catch {
          // ignore storage quota errors
        }
        return [...additions, ...prev].slice(0, 3);
      });
    },
    [storageKey],
  );

  // Hydrate seen keys & surface initial unread notifications or due reminders as snackbars
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as string[];
        if (Array.isArray(parsed)) {
          parsed.forEach((k) => seenKeysRef.current.add(k));
        }
      }
    } catch {
      // ignore
    }

    const initialToasts: SnackbarNotice[] = [];
    for (const item of initialUnreadItems.slice(0, 2)) {
      initialToasts.push({
        key: `notif-${item.id}`,
        id: item.id,
        type: item.type,
        title: item.title,
        body: item.body,
        linkPath: item.linkPath ? `/notifications/${item.id}/go` : '/notifications',
        createdAt: item.createdAt,
        isUnread: true,
      });
    }

    if (initialToasts.length === 0 && initialDeadlines.length > 0) {
      const d = initialDeadlines[0];
      const overdue = d.daysLeft < 0;
      const statusText = overdue
        ? `${-d.daysLeft} day${d.daysLeft === -1 ? '' : 's'} overdue`
        : d.daysLeft === 0
          ? 'Due today'
          : `Due in ${d.daysLeft} day${d.daysLeft === 1 ? '' : 's'}`;
      initialToasts.push({
        key: `due-${d.kind}-${d.id}`,
        type: overdue ? 'deadline.overdue' : 'deadline.approaching',
        title: `${statusText}: ${d.title}`,
        body: `${d.projectCode} · Scheduled due date ${d.due}`,
        linkPath: d.linkPath,
        createdAt: d.due,
        isUnread: false,
      });
    }

    if (initialToasts.length === 0) return;
    const timer = setTimeout(() => {
      enqueueNotices(initialToasts);
    }, 60);
    return () => clearTimeout(timer);
  }, [enqueueNotices, initialDeadlines, initialUnreadItems, storageKey]);

  // Listen for custom snackbar triggers (e.g., from Inbox page "Preview popup" button)
  useEffect(() => {
    const handler = (e: Event) => {
      const custom = e as CustomEvent<SnackbarNotice>;
      if (custom.detail) {
        enqueueNotices([{ ...custom.detail, key: `${custom.detail.key}-${Date.now()}` }], true);
      }
    };
    window.addEventListener('aktivacity:show-snackbar', handler);
    return () => window.removeEventListener('aktivacity:show-snackbar', handler);
  }, [enqueueNotices]);

  // Live background polling for new notifications
  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      try {
        const res = await fetch('/api/notifications/poll', { cache: 'no-store' });
        if (!res.ok || !active) return;
        const data = (await res.json()) as PollResponse;
        if (!active) return;

        setPolledCounts({
          unread: data.unreadCount,
          due: data.dueCount,
          signature: initialSignature,
        });

        const newest = data.unreadItems[0] ?? data.recentItems[0];
        if (newest) {
          setLatestPreview({
            key: `notif-${newest.id}`,
            id: newest.id,
            type: newest.type,
            title: newest.title,
            body: newest.body,
            linkPath: newest.linkPath ? `/notifications/${newest.id}/go` : '/notifications',
            createdAt: newest.createdAt,
            isUnread: !newest.isRead,
          });
        }

        if (data.unreadItems.length > 0) {
          enqueueNotices(
            data.unreadItems.slice(0, 2).map((item) => ({
              key: `notif-${item.id}`,
              id: item.id,
              type: item.type,
              title: item.title,
              body: item.body,
              linkPath: item.linkPath ? `/notifications/${item.id}/go` : '/notifications',
              createdAt: item.createdAt,
              isUnread: true,
            })),
          );
        }
      } catch {
        // ignore transient network errors
      }
    };

    const interval = setInterval(poll, 8000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [enqueueNotices, initialSignature]);

  const dismissToast = useCallback((key: string) => {
    setToasts((prev) => prev.filter((t) => t.key !== key));
  }, []);

  const markToastRead = useCallback(
    async (toast: SnackbarNotice) => {
      dismissToast(toast.key);
      if (!toast.id) return;
      try {
        const res = await fetch('/api/notifications/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: toast.id }),
        });
        if (res.ok) {
          const data = (await res.json()) as { unreadCount: number; dueCount: number };
          setPolledCounts({
            unread: data.unreadCount,
            due: data.dueCount,
            signature: initialSignature,
          });
        }
      } catch {
        // ignore
      }
    },
    [dismissToast, initialSignature],
  );

  // Auto-dismiss snackbars after 8 seconds
  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setTimeout(() => {
      setToasts((prev) => prev.slice(0, -1));
    }, 8000);
    return () => clearTimeout(timer);
  }, [toasts]);

  const groupedLinks = GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    items: links.filter((l) => l.group === group),
  })).filter((g) => g.items.length > 0);

  const isLinkActive = (href: string) => {
    if (href === '/dashboard') return pathname === '/dashboard' || pathname === '/';
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  return (
    <>
      <CurrencyDomSynchronizer />
      <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur-md">
        {/* Tier 1: Brand Identity + Global Actions + User Profile */}
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-2.5 sm:px-6">
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="group flex items-center gap-2.5 text-sm font-semibold tracking-tight">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-xs font-bold text-white shadow-xs transition-transform group-hover:scale-105">
                A
              </span>
              <span className="text-[15px] font-semibold text-foreground">
                Aktivacity <span className="font-normal text-muted">Portal</span>
              </span>
            </Link>

            {/* Mobile menu trigger */}
            <details className="relative md:hidden">
              <summary className="cursor-pointer list-none rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground">
                Menu
              </summary>
              <nav className="absolute left-0 z-40 mt-2 flex w-64 flex-col gap-1 rounded-xl border border-border bg-surface p-3 text-sm shadow-xl">
                <form action="/search" method="get" role="search" className="mb-2">
                  <input
                    name="q"
                    type="search"
                    placeholder="Search projects, clients…"
                    aria-label="Search projects"
                    className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-accent"
                  />
                </form>
                {groupedLinks.map((section) => (
                  <div key={section.group} className="py-1">
                    <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted/80">
                      {section.label}
                    </div>
                    {section.items.map((l) => {
                      const active = isLinkActive(l.href);
                      return (
                        <Link
                          key={l.href}
                          href={l.href}
                          className={`block rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                            active ? 'bg-accent text-white' : 'text-muted hover:bg-background hover:text-foreground'
                          }`}
                        >
                          {l.label}
                        </Link>
                      );
                    })}
                  </div>
                ))}
              </nav>
            </details>
          </div>

          <div className="flex items-center gap-2.5 sm:gap-3">
            {/* Search Input */}
            <form action="/search" method="get" role="search" className="relative hidden sm:block">
              <svg
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
                aria-hidden="true"
              >
                <circle cx="9" cy="9" r="5.5" />
                <path strokeLinecap="round" d="M13.2 13.2L16.5 16.5" />
              </svg>
              <input
                name="q"
                type="search"
                placeholder="Search…"
                aria-label="Search projects"
                className="w-36 rounded-lg border border-border bg-background py-1.5 pl-8 pr-3 text-xs text-foreground placeholder:text-muted outline-none transition-all focus:w-52 focus:border-accent lg:w-48 lg:focus:w-64"
              />
            </form>

            {/* Global Currency Swipe Toggle ($ USD <-> ₨ PKR) */}
            <CurrencySwipeToggle />

            {/* Inbox Pill + Snackbar Trigger */}
            <div className="flex shrink-0 items-center rounded-lg border border-border bg-background p-0.5">
              <Link
                href="/notifications"
                aria-label={`Inbox, ${unread} unread, ${due} due`}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                  pathname.startsWith('/notifications')
                    ? 'bg-accent text-white'
                    : 'text-foreground hover:bg-surface'
                }`}
              >
                <svg
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  className="h-3.5 w-3.5 shrink-0"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M10 3a4.5 4.5 0 00-4.5 4.5v2.6c0 .6-.2 1.2-.6 1.6L3.8 13h12.4l-1.1-1.3c-.4-.4-.6-1-.6-1.6V7.5A4.5 4.5 0 0010 3zm-1.8 12.5a1.8 1.8 0 003.6 0"
                  />
                </svg>
                <span>Inbox</span>
                {unread > 0 ? (
                  <span
                    className={`inline-flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full px-1.5 text-[10px] font-bold leading-none whitespace-nowrap ${
                      pathname.startsWith('/notifications')
                        ? 'bg-white text-accent'
                        : 'bg-accent text-white'
                    }`}
                  >
                    {unread > 99 ? '99+' : unread}
                  </span>
                ) : null}
                {due > 0 ? (
                  <span
                    className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-none whitespace-nowrap ${
                      pathname.startsWith('/notifications')
                        ? 'border-white/40 bg-white/15 text-white'
                        : 'border-amber-500/35 bg-amber-500/12 text-amber-500 dark:text-amber-400'
                    }`}
                  >
                    <span>{due > 99 ? '99+' : due}</span>
                    <span>due</span>
                  </span>
                ) : null}
              </Link>

              {latestPreview ? (
                <button
                  type="button"
                  onClick={() => enqueueNotices([{ ...latestPreview, key: `${latestPreview.key}-${Date.now()}` }], true)}
                  title="Pop up latest inbox update"
                  aria-label="Pop up latest inbox update"
                  className="rounded-md px-1.5 py-1 text-muted transition-colors hover:bg-surface hover:text-accent"
                >
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 14h12M6 10l4-4 4 4" />
                  </svg>
                </button>
              ) : null}
            </div>

            {/* User Profile Pill */}
            <div className="hidden shrink-0 items-center gap-2 rounded-lg border border-border/80 bg-background/60 px-2.5 py-1 whitespace-nowrap md:flex">
              <span className="flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[10px] font-bold text-accent ring-1 ring-accent/20">
                {getInitials(fullName)}
              </span>
              <span className="text-xs font-medium text-foreground whitespace-nowrap">{fullName}</span>
              <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-accent whitespace-nowrap">
                {roleLabel}
              </span>
            </div>

            {/* Sign out */}
            <form action="/logout" method="post" className="shrink-0">
              <button
                type="submit"
                className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-500 whitespace-nowrap"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>

        {/* Tier 2: Organized, Categorized Desktop Navigation Bar */}
        <div className="hidden border-t border-border/60 bg-background/40 md:block">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-y-1.5 px-4 py-1.5 sm:px-6">
            {groupedLinks.map((section, idx) => (
              <div key={section.group} className="flex items-center">
                {idx > 0 ? <span className="mx-2.5 h-4 w-px bg-border" aria-hidden="true" /> : null}
                <div className="flex flex-wrap items-center gap-1">
                  <span className="mr-1 select-none text-[10px] font-semibold uppercase tracking-wider text-muted/65">
                    {section.label}
                  </span>
                  {section.items.map((l) => {
                    const active = isLinkActive(l.href);
                    return (
                      <Link
                        key={l.href}
                        href={l.href}
                        className={`rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-all ${
                          active
                            ? 'bg-accent text-white shadow-2xs'
                            : 'text-muted hover:bg-surface hover:text-foreground'
                        }`}
                      >
                        {l.label}
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </header>

      {/* Floating Snackbar Popup Notifications */}
      {toasts.length > 0 ? (
        <div
          aria-live="polite"
          className="fixed bottom-5 right-5 z-50 flex w-[calc(100vw-2.5rem)] max-w-md flex-col gap-3 pointer-events-none"
        >
          {toasts.map((toast) => {
            const style = getNotificationStyle(toast.type, toast.title);
            const meta = extractProjectMeta(toast.title, toast.body);
            return (
              <div
                key={toast.key}
                role="status"
                className="pointer-events-auto relative overflow-hidden rounded-xl border border-border bg-surface/98 p-4 shadow-2xl ring-1 ring-black/10 backdrop-blur-md transition-all duration-200 dark:ring-white/10"
              >
                {/* Left Colored Status Bar */}
                <span className={`absolute inset-y-0 left-0 w-1.5 ${style.accentBarClass}`} aria-hidden="true" />

                <div className="flex items-start gap-3 pl-2">
                  <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${style.iconBgClass}`}>
                    <NotificationIcon kind={style.iconKind} className="h-4 w-4" />
                  </span>

                  <div className="min-w-0 flex-1">
                    {/* Top row: Status badge, Project Code pill, Date */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold ${style.badgeClass}`}>
                        {style.label}
                      </span>
                      {meta.projectCode ? (
                        <span className="inline-flex items-center rounded-md border border-accent/25 bg-accent/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-accent">
                          {meta.projectCode}
                        </span>
                      ) : null}
                      <span className="ml-auto text-[11px] font-medium tabular-nums text-sky-600 dark:text-sky-400">
                        {formatShortTime(toast.createdAt)}
                      </span>
                    </div>

                    {/* Title */}
                    <p className="mt-1.5 text-sm font-semibold leading-snug text-foreground">
                      {toast.title}
                    </p>

                    {/* Project Name & Clean Body */}
                    {meta.projectName ? (
                      <p className="mt-0.5 text-xs font-medium text-foreground/80">
                        {meta.projectName}
                      </p>
                    ) : null}
                    {meta.cleanBody ? (
                      <p className="mt-1 text-xs leading-relaxed text-muted">
                        {meta.cleanBody}
                      </p>
                    ) : null}

                    {/* Actions */}
                    <div className="mt-3 flex items-center gap-3 border-t border-border/60 pt-2.5 text-xs">
                      {toast.linkPath ? (
                        <Link
                          href={toast.linkPath}
                          onClick={() => dismissToast(toast.key)}
                          className="font-semibold text-accent hover:underline"
                        >
                          Open update →
                        </Link>
                      ) : null}
                      <Link
                        href="/notifications"
                        onClick={() => dismissToast(toast.key)}
                        className="font-medium text-muted hover:text-foreground"
                      >
                        View inbox
                      </Link>
                      {toast.isUnread && toast.id ? (
                        <button
                          type="button"
                          onClick={() => markToastRead(toast)}
                          className="ml-auto font-medium text-muted hover:text-foreground"
                        >
                          Mark read
                        </button>
                      ) : null}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => dismissToast(toast.key)}
                    aria-label="Dismiss notification"
                    className="rounded-md p-1 text-muted transition-colors hover:bg-background hover:text-foreground"
                  >
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l8 8M14 6l-8 8" />
                    </svg>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
