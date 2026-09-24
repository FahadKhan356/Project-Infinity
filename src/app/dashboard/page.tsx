import Link from 'next/link';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { can } from '@/lib/authz';
import { loadDashboard } from '@/lib/dashboard/dashboard';
import { formatMoney } from '@/lib/projects/intake';
import { formatDateTime } from '@/lib/workspace/format';

const ROLE_TITLE: Record<string, string> = {
  ceo: 'Management dashboard', coo: 'Management dashboard', admin: 'Management dashboard',
  sales: 'Sales dashboard', project_manager: 'Project Manager dashboard',
  team_lead: 'Team Lead dashboard', executive: 'Your dashboard',
};

/**
 * Per-role dashboards (brief §21). One page; which tiles and tables appear
 * depends on the role, and every number is scoped the way every list is.
 */
export default async function DashboardPage() {
  const actor = await requireActor();
  const d = await loadDashboard(actor);
  const c = d.counts;
  const seesAll = can(actor, 'projects.viewAll');
  const isLead = actor.leadDepartmentIds.length > 0 && !seesAll;
  const isExecutive = actor.role === 'executive';

  const tiles: { label: string; value: string | number; href?: string; warn?: boolean }[] = [];
  if (isExecutive && d.executive) {
    tiles.push(
      { label: 'Active assignments', value: d.executive.activeAssignments, href: '/work' },
      { label: 'Current projects', value: d.executive.currentProjects, href: '/work' },
      { label: 'Pending deliverables', value: d.executive.pendingDeliverables },
      { label: 'In QA', value: d.executive.inQa },
      { label: 'To redo', value: d.executive.toRedo, warn: d.executive.toRedo > 0 },
      { label: 'Completed deliverables', value: d.executive.completedDeliverables },
      { label: 'Open revisions', value: d.openRevisions, href: '/revisions', warn: d.openRevisions > 0 },
    );
  } else if (isLead) {
    tiles.push(
      { label: 'Team projects', value: c.active, href: '/projects' },
      { label: 'Awaiting planning', value: d.planningGaps.length, href: '/planning', warn: d.planningGaps.length > 0 },
      { label: 'Active tasks', value: d.workload.reduce((sum, w) => sum + w.members.reduce((s, m) => s + m.activeAssignments, 0), 0) },
      { label: 'QA queue', value: d.qaQueue, href: '/qa', warn: d.qaQueue > 0 },
      { label: 'Open revisions', value: d.openRevisions, href: '/revisions' },
      { label: 'Delayed', value: c.delayed, warn: c.delayed > 0 },
    );
  } else if (actor.role === 'sales') {
    tiles.push(
      { label: 'Waiting for the PM', value: c.new, href: '/projects' },
      { label: 'Active projects', value: c.active, href: '/projects' },
      { label: 'In production', value: c.planned + c.inProgress },
      { label: 'In QA', value: c.inQa },
      { label: 'Ready to deliver', value: d.pendingDeliveries, href: '/deliveries', warn: d.pendingDeliveries > 0 },
      { label: 'In revision', value: c.inRevision, href: '/revisions' },
      { label: 'Delayed', value: c.delayed, warn: c.delayed > 0 },
    );
  } else if (actor.role === 'project_manager') {
    tiles.push(
      { label: 'New projects', value: c.new, href: '/triage', warn: c.new > 0 },
      { label: 'Active projects', value: c.active, href: '/projects' },
      { label: 'In production', value: c.planned + c.inProgress },
      { label: 'In QA', value: c.inQa },
      { label: 'Your QA queue', value: d.qaQueue, href: '/qa', warn: d.qaQueue > 0 },
      { label: 'Pending revisions', value: d.openRevisions, href: '/revisions' },
      { label: 'Awaiting delivery', value: c.awaitingDelivery },
      { label: 'Delayed', value: c.delayed, warn: c.delayed > 0 },
    );
  } else {
    tiles.push(
      { label: 'Active projects', value: c.active, href: '/projects' },
      { label: 'Completed', value: c.completed },
      { label: 'In production', value: c.planned + c.inProgress },
      { label: 'In QA', value: c.inQa },
      { label: 'Awaiting delivery', value: c.awaitingDelivery },
      { label: 'In revision', value: c.inRevision, href: '/revisions' },
      { label: 'Delayed', value: c.delayed, warn: c.delayed > 0 },
      { label: 'On hold', value: c.onHold },
    );
  }
  if (d.value) {
    tiles.push(
      { label: 'Value of active projects', value: formatMoney(d.value.active, d.value.currency) },
      { label: 'Value filed this month', value: formatMoney(d.value.thisMonth, d.value.currency) },
    );
  }

  return (
    <AppShell actor={actor}>
      <h1 className="text-lg font-semibold tracking-tight">{ROLE_TITLE[actor.role] ?? 'Dashboard'}</h1>
      <p className="mt-1 text-sm text-muted">
        {isExecutive ? 'What is on your desk, and what is due.' : 'Everything below is scoped to what you can open.'}
      </p>

      <div className="mt-6 grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <Tile key={t.label} {...t} />
        ))}
      </div>

      {d.deadlines.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-sm font-semibold">Deadlines in the next 7 days</h2>
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border bg-surface">
            {d.deadlines.map((x) => (
              <li key={`${x.kind}-${x.id}`} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2 text-sm">
                <span className={x.daysLeft < 0 ? 'font-medium text-red-600 dark:text-red-400' : 'font-medium'}>
                  {x.daysLeft < 0 ? `${-x.daysLeft}d overdue` : x.daysLeft === 0 ? 'Today' : `${x.daysLeft}d`}
                </span>
                <Link href={`/projects/${x.projectId}${x.kind === 'assignment' ? '#workspace' : ''}`} className="hover:underline">{x.title}</Link>
                <span className="font-mono text-xs text-muted">{x.projectCode}</span>
                <span className="ml-auto text-xs text-muted">{x.kind} · {x.due}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {d.intake.length > 0 ? (
        <section className="mt-8">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">{actor.role === 'sales' ? 'Waiting for the Project Manager' : 'New projects in intake'}</h2>
            {can(actor, 'projects.triage') ? <Link href="/triage" className="text-xs text-muted hover:underline">Open intake →</Link> : null}
          </div>
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border bg-surface">
            {d.intake.map((p) => (
              <li key={p.id} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2 text-sm">
                <Link href={`/projects/${p.id}`} className="font-medium hover:underline">{p.title}</Link>
                <span className="font-mono text-xs text-muted">{p.projectCode}</span>
                <span className="text-muted">{p.clientName}</span>
                <span className="ml-auto text-xs text-muted">{formatDateTime(p.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {d.planningGaps.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-sm font-semibold">Assigned to your team, not yet planned</h2>
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border bg-surface">
            {d.planningGaps.map((g) => (
              <li key={g.projectDepartmentId} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2 text-sm">
                <Link href={`/planning/${g.projectDepartmentId}`} className="font-medium hover:underline">{g.title}</Link>
                <span className="font-mono text-xs text-muted">{g.projectCode}</span>
                <span className="text-muted">{g.department} · {g.plannedDeliverables} planned</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {d.departments.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-sm font-semibold">{isLead ? 'Your team' : 'By department'}</h2>
          <div className="mt-2 overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Team</th>
                  <th className="px-4 py-2 text-right font-medium">Active projects</th>
                  <th className="px-4 py-2 text-right font-medium">Open slots</th>
                  <th className="px-4 py-2 text-right font-medium">In QA</th>
                  <th className="px-4 py-2 text-right font-medium">Approved</th>
                  <th className="px-4 py-2 text-right font-medium">QA rounds</th>
                  <th className="px-4 py-2 text-right font-medium">Sent back</th>
                </tr>
              </thead>
              <tbody>
                {d.departments.map((t) => (
                  <tr key={t.departmentId} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 font-medium">{t.name}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{t.activeProjects}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{t.openSlots}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{t.inQa}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{t.approved}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted">{t.reviews}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted">
                      {t.rejected}{t.reviews > 0 ? ` (${Math.round((t.rejected / t.reviews) * 100)}%)` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {d.workload.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-sm font-semibold">Team workload</h2>
          <p className="mt-1 text-xs text-muted">Open slots per person: committed work, not hours.</p>
          <div className="mt-2 grid gap-4 lg:grid-cols-2">
            {d.workload.map((w) => (
              <div key={w.departmentId} className="rounded-lg border border-border bg-surface">
                <div className="border-b border-border px-4 py-2 text-sm font-medium">{w.name}</div>
                {w.members.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-muted">No members.</p>
                ) : (
                  <table className="w-full text-sm">
                    <tbody>
                      {w.members.map((m) => (
                        <tr key={m.userId} className="border-b border-border last:border-0">
                          <td className="px-4 py-1.5">{m.fullName}{m.isLead ? <span className="ml-1 text-xs text-muted">lead</span> : null}</td>
                          <td className="px-4 py-1.5 text-right tabular-nums">{m.openSlots} open</td>
                          <td className="px-4 py-1.5 text-right tabular-nums text-muted">{m.inQa} in QA</td>
                          <td className="px-4 py-1.5 text-right tabular-nums text-muted">{m.dueSoon} due soon</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {isExecutive ? (
        <p className="mt-8 text-sm text-muted">
          <Link href="/work" className="underline">My work</Link> lists each assignment with its brief and files.
        </p>
      ) : null}
    </AppShell>
  );
}

function Tile({ label, value, href, warn }: { label: string; value: string | number; href?: string; warn?: boolean }) {
  const body = (
    <>
      <div className={`text-2xl font-semibold tabular-nums ${warn ? 'text-red-600 dark:text-red-400' : ''}`}>{value}</div>
      <div className="mt-0.5 text-xs text-muted">{label}</div>
    </>
  );
  const cls = 'rounded-lg border border-border bg-surface px-4 py-3';
  return href ? <Link href={href} className={`${cls} block hover:border-accent`}>{body}</Link> : <div className={cls}>{body}</div>;
}
