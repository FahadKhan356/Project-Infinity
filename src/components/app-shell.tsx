import Link from 'next/link';
import type { Actor } from '@/lib/authz';
import { can } from '@/lib/authz';
import { canViewActivityLog } from '@/lib/activity/log';
import { deadlineCount, unreadCount } from '@/lib/notifications/inbox';
import { canViewReports } from '@/lib/reports/monthly';
import { canViewTeams } from '@/lib/teams/overview';
import { canViewProductivity } from '@/lib/reports/productivity';
import { canUsePipeline } from '@/lib/pipeline/opportunities';
import { canManageInvoices } from '@/lib/invoices/invoices';

const ROLE_LABELS: Record<Actor['role'], string> = {
  ceo: 'CEO',
  coo: 'COO',
  admin: 'Administrator',
  sales: 'Sales',
  project_manager: 'Project Manager',
  team_lead: 'Team Lead',
  executive: 'Executive',
  client: 'Client',
};

export async function AppShell({ actor, children }: { actor: Actor; children: React.ReactNode }) {
  // Two badges: what was said to this person, and what is due or overdue in
  // the inbox's window (§20 "deadline approaching") — the latter computed,
  // never stored, so it falls as the work is done.
  const [unread, due] = await Promise.all([unreadCount(actor), deadlineCount(actor)]);
  const links = [
    { show: true, href: '/dashboard', label: 'Dashboard' },
    { show: actor.role === 'executive' || actor.departmentIds.length > 0, href: '/work', label: 'My work' },
    { show: actor.role === 'executive' || actor.departmentIds.length > 0, href: '/time', label: 'My time' },
    { show: true, href: '/projects', label: 'Projects' },
    { show: can(actor, 'projects.triage'), href: '/triage', label: 'Project Closure Report' },
    { show: actor.leadDepartmentIds.length > 0 || can(actor, 'planning.viewAllDepartments'), href: '/planning', label: 'Planning' },
    { show: actor.leadDepartmentIds.length > 0 || can(actor, 'qa.reviewAsProjectManager'), href: '/qa', label: 'QA' },
    { show: can(actor, 'delivery.view'), href: '/deliveries', label: 'Deliveries' },
    { show: true, href: '/revisions', label: 'Revisions' },
    { show: true, href: '/clients', label: 'Clients' },
    { show: canUsePipeline(actor), href: '/pipeline', label: 'Pipeline' },
    { show: canManageInvoices(actor), href: '/invoices', label: 'Invoices' },
    { show: canViewTeams(actor), href: '/teams', label: 'Team Overview' },
    { show: canViewReports(actor), href: '/reports', label: 'Reports' },
    { show: !canViewReports(actor) && canViewProductivity(actor), href: '/reports/productivity', label: 'Productivity' },
    { show: canViewActivityLog(actor), href: '/activity', label: 'Activity' },
    { show: can(actor, 'users.view'), href: '/admin/users', label: 'Users' },
  ].filter((l) => l.show);
  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3 sm:gap-6 sm:px-6">
          <Link href="/dashboard" className="shrink-0 whitespace-nowrap text-sm font-semibold tracking-tight">
            Aktivacity<span className="hidden sm:inline"> Portal</span>
          </Link>

          <nav className="hidden flex-wrap items-center gap-x-4 gap-y-1 text-sm md:flex">
            {links.map((l) => (
              <Link key={l.href} href={l.href} className="text-muted hover:text-foreground">{l.label}</Link>
            ))}
          </nav>
          {/* On a phone (brief §29, mobile application) the same links fold into a menu. */}
          <details className="relative md:hidden">
            <summary className="cursor-pointer list-none rounded-md border border-border px-2.5 py-1 text-sm">Menu</summary>
            <nav className="absolute left-0 z-20 mt-2 flex w-56 flex-col rounded-lg border border-border bg-surface p-2 text-sm shadow-lg">
              <form action="/search" method="get" role="search" className="mb-1">
                <input name="q" type="search" placeholder="Search…" aria-label="Search projects"
                  className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-accent" />
              </form>
              {links.map((l) => (
                <Link key={l.href} href={l.href} className="rounded px-2 py-1.5 hover:bg-background">{l.label}</Link>
              ))}
            </nav>
          </details>

          <div className="ml-auto flex shrink-0 items-center gap-3 whitespace-nowrap text-sm">
            <Link href="/notifications" className="text-muted hover:text-foreground"
              aria-label={`Inbox, ${unread} unread, ${due} due`}>
              Inbox
              {unread > 0 ? (
                <span className="ml-1 rounded-full bg-accent px-1.5 py-0.5 text-xs font-medium text-white">
                  {unread > 99 ? '99+' : unread}
                </span>
              ) : null}
              {due > 0 ? (
                <span className="ml-1 rounded-full border border-border px-1.5 py-0.5 text-xs font-medium">
                  {due > 99 ? '99+' : due} due
                </span>
              ) : null}
            </Link>
            <form action="/search" method="get" role="search" className="hidden sm:block">
              <input name="q" type="search" placeholder="Search…" aria-label="Search projects"
                className="w-28 rounded-md border border-border bg-background px-2.5 py-1 text-sm outline-none focus:border-accent lg:w-40" />
            </form>
            <span className="hidden text-muted md:inline">
              {actor.fullName} · {ROLE_LABELS[actor.role]}
            </span>
            <form action="/logout" method="post">
              <button type="submit" className="text-muted underline-offset-2 hover:text-foreground hover:underline">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}
