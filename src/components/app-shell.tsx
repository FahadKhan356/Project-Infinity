import type { Actor } from '@/lib/authz';
import { can } from '@/lib/authz';
import { canViewActivityLog } from '@/lib/activity/log';
import {
  INBOX_DEADLINE_DAYS,
  deadlineCount,
  inbox,
  upcomingDeadlines,
  unreadCount,
} from '@/lib/notifications/inbox';
import { canViewReports } from '@/lib/reports/monthly';
import { canViewTeams } from '@/lib/teams/overview';
import { canViewProductivity } from '@/lib/reports/productivity';
import { canUsePipeline } from '@/lib/pipeline/opportunities';
import { canManageInvoices } from '@/lib/invoices/invoices';
import { HeaderShellClient, type NavItem } from './header-shell-client';

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
  const [unread, due, unreadItems, recentItems, deadlines] = await Promise.all([
    unreadCount(actor),
    deadlineCount(actor),
    inbox(actor, { limit: 5, unreadOnly: true }),
    inbox(actor, { limit: 3 }),
    upcomingDeadlines(actor, INBOX_DEADLINE_DAYS),
  ]);

  const rawLinks: (NavItem & { show: boolean })[] = [
    // Workspace
    { show: true, href: '/dashboard', label: 'Dashboard', group: 'workspace' },
    { show: actor.role === 'executive' || actor.departmentIds.length > 0, href: '/work', label: 'My work', group: 'workspace' },
    { show: actor.role === 'executive' || actor.departmentIds.length > 0, href: '/time', label: 'My time', group: 'workspace' },

    // Production
    { show: true, href: '/projects', label: 'Projects', group: 'production' },
    { show: can(actor, 'projects.triage'), href: '/triage', label: 'Project Closure Report', group: 'production' },
    { show: actor.leadDepartmentIds.length > 0 || can(actor, 'planning.viewAllDepartments'), href: '/planning', label: 'Planning', group: 'production' },
    { show: actor.leadDepartmentIds.length > 0 || can(actor, 'qa.reviewAsProjectManager'), href: '/qa', label: 'QA', group: 'production' },
    { show: can(actor, 'delivery.view'), href: '/deliveries', label: 'Deliveries', group: 'production' },
    { show: true, href: '/revisions', label: 'Revisions', group: 'production' },

    // Commercial
    { show: true, href: '/clients', label: 'Clients', group: 'commercial' },
    { show: canUsePipeline(actor), href: '/pipeline', label: 'Pipeline', group: 'commercial' },
    { show: canManageInvoices(actor), href: '/invoices', label: 'Invoices', group: 'commercial' },

    // Management
    { show: canViewTeams(actor), href: '/teams', label: 'Team Overview', group: 'management' },
    { show: canViewReports(actor), href: '/reports', label: 'Reports', group: 'management' },
    { show: !canViewReports(actor) && canViewProductivity(actor), href: '/reports/productivity', label: 'Productivity', group: 'management' },
    { show: canViewActivityLog(actor), href: '/activity', label: 'Activity', group: 'management' },
    { show: can(actor, 'users.view'), href: '/admin/users', label: 'Users', group: 'management' },
    { show: actor.role === 'ceo' || actor.role === 'coo', href: '/admin/whatsapp', label: 'WhatsApp Alerts', group: 'management' },
  ];

  const links: NavItem[] = rawLinks
    .filter((l) => l.show)
    .map(({ href, label, group }) => ({ href, label, group }));

  return (
    <div className="flex min-h-svh flex-col">
      <HeaderShellClient
        userId={actor.id}
        fullName={actor.fullName}
        roleLabel={ROLE_LABELS[actor.role]}
        links={links}
        initialUnread={unread}
        initialDue={due}
        initialUnreadItems={unreadItems}
        initialRecentItems={recentItems}
        initialDeadlines={deadlines.slice(0, 3)}
      />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}
