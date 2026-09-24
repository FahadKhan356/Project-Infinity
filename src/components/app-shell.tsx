import Link from 'next/link';
import type { Actor } from '@/lib/authz';
import { can } from '@/lib/authz';
import { unreadCount } from '@/lib/notifications/inbox';

const ROLE_LABELS: Record<Actor['role'], string> = {
  ceo: 'CEO',
  coo: 'COO',
  admin: 'Administrator',
  sales: 'Sales',
  project_manager: 'Project Manager',
  team_lead: 'Team Lead',
  executive: 'Executive',
};

export async function AppShell({ actor, children }: { actor: Actor; children: React.ReactNode }) {
  const unread = await unreadCount(actor);
  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-3">
          <Link href="/dashboard" className="text-sm font-semibold tracking-tight">
            Aktivacity Portal
          </Link>

          <nav className="flex items-center gap-4 text-sm">
            <Link href="/dashboard" className="text-muted hover:text-foreground">
              Dashboard
            </Link>
            {actor.role === 'executive' || actor.departmentIds.length > 0 ? (
              <Link href="/work" className="text-muted hover:text-foreground">
                My work
              </Link>
            ) : null}
            <Link href="/projects" className="text-muted hover:text-foreground">
              Projects
            </Link>
            {can(actor, 'projects.triage') ? (
              <Link href="/triage" className="text-muted hover:text-foreground">
                Intake
              </Link>
            ) : null}
            {actor.leadDepartmentIds.length > 0 || can(actor, 'planning.viewAllDepartments') ? (
              <Link href="/planning" className="text-muted hover:text-foreground">
                Planning
              </Link>
            ) : null}
            {actor.leadDepartmentIds.length > 0 || can(actor, 'qa.reviewAsProjectManager') ? (
              <Link href="/qa" className="text-muted hover:text-foreground">
                QA
              </Link>
            ) : null}
            {can(actor, 'delivery.manage') ? (
              <Link href="/deliveries" className="text-muted hover:text-foreground">
                Deliveries
              </Link>
            ) : null}
            <Link href="/revisions" className="text-muted hover:text-foreground">
              Revisions
            </Link>
            <Link href="/clients" className="text-muted hover:text-foreground">
              Clients
            </Link>
            {can(actor, 'users.view') ? (
              <Link href="/admin/users" className="text-muted hover:text-foreground">
                Users
              </Link>
            ) : null}
          </nav>

          <div className="ml-auto flex items-center gap-3 text-sm">
            <Link href="/notifications" className="text-muted hover:text-foreground" aria-label={`Inbox, ${unread} unread`}>
              Inbox
              {unread > 0 ? (
                <span className="ml-1 rounded-full bg-accent px-1.5 py-0.5 text-xs font-medium text-white">
                  {unread > 99 ? '99+' : unread}
                </span>
              ) : null}
            </Link>
            <form action="/search" method="get" role="search">
              <input name="q" type="search" placeholder="Search…" aria-label="Search projects"
                className="w-40 rounded-md border border-border bg-background px-2.5 py-1 text-sm outline-none focus:border-accent" />
            </form>
            <span className="text-muted">
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

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">{children}</main>
    </div>
  );
}
