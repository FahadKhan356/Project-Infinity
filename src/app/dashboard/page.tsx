import Link from 'next/link';
import { forecasts } from '@/lib/insights/forecast';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { can } from '@/lib/authz';
import { backupHealth } from '@/lib/backup/health';
import { loadDashboard, ON_TIME_WINDOW_DAYS, THROUGHPUT_WINDOW_DAYS } from '@/lib/dashboard/dashboard';
import { jobsHealth } from '@/lib/jobs/health';
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
  // Department performance (§21) is a Management dashboard figure: the brief
  // gives the PM projects by department and leads their workload, so this is
  // keyed on the three roles ROLE_TITLE calls management, not on a scope.
  const isManagement = actor.role === 'ceo' || actor.role === 'coo' || actor.role === 'admin';
  // A Team Lead account that leads no department is a setup mistake: it can
  // open nothing, so say so rather than show management tiles reading zero.
  if (actor.role === 'team_lead' && actor.leadDepartmentIds.length === 0) {
    return (
      <AppShell actor={actor}>
        <h1 className="text-lg font-semibold tracking-tight">{ROLE_TITLE[actor.role]}</h1>
        <div role="alert" className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm dark:border-amber-800 dark:bg-amber-950">
          <span className="font-medium">Your account is not yet the lead of any team.</span>{' '}
          Ask an administrator to mark you as lead on your department under Admin → Users. Until then there is nothing here to plan or review.
        </div>
      </AppShell>
    );
  }
  // Management and administrators are the ones who can act on a failing backup.
  const backups = can(actor, 'users.manage') ? await backupHealth() : null;
  // Likewise for the scheduled jobs (sweep, recurring projects, nightly
  // housekeeping): a job that has never run, is stale, or failed last time.
  const jobs = can(actor, 'users.manage') ? Object.values(await jobsHealth()) : null;
  const jobProblems = jobs?.filter((j) => j.stale || j.lastRun?.status === 'failed') ?? [];
  const nightly = jobs?.find((j) => j.name === 'nightly');
  // Deadline prediction (brief §29) for those who plan: which live projects
  // will miss their deadline at the teams' recent pace.
  const atRisk = seesAll || isLead
    ? [...(await forecasts(actor)).entries()]
      .filter(([, f]) => f.status === 'at_risk')
      .sort(([, a], [, b]) => (b.daysLate ?? 0) - (a.daysLate ?? 0))
      .slice(0, 10)
    : [];

  const tiles: { label: string; value: string | number; href?: string; warn?: boolean }[] = [];
  if (isExecutive && d.executive) {
    tiles.push(
      { label: 'Today’s assignments', value: d.executive.todayAssignments, href: '/work' },
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

      {backups ? (
        <div role={backups.state === 'ok' ? 'status' : 'alert'}
          className={`mt-4 rounded-md border px-4 py-3 text-sm ${backups.state === 'ok'
            ? 'border-border bg-surface text-muted'
            : 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950'}`}>
          <span className="font-medium text-foreground">
            {backups.state === 'ok' ? 'Backups are running.'
              : backups.state === 'failed' ? 'Backups are failing.'
              : backups.state === 'unconfigured' ? 'File backups are not configured.'
              : backups.state === 'disabled' ? 'File backups are switched off.'
              : backups.state === 'unknown' ? 'Backup status unknown.'
              : 'Backups need attention.'}
          </span>{' '}
          {backups.lastSuccessAt ? `Last complete backup ${formatDateTime(backups.lastSuccessAt)}. ` : ''}
          {backups.lastVerifiedAt ? `Last restore rehearsal ${formatDateTime(backups.lastVerifiedAt)}. ` : ''}
          {backups.problems.join(' ')}
          {backups.state !== 'ok' ? ' See docs/runbook.md, “Monitoring backups”.' : ''}
        </div>
      ) : null}

      {jobs ? (
        <div role={jobProblems.length === 0 ? 'status' : 'alert'}
          className={`mt-4 rounded-md border px-4 py-3 text-sm ${jobProblems.length === 0
            ? 'border-border bg-surface text-muted'
            : 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950'}`}>
          <span className="font-medium text-foreground">
            {jobProblems.length === 0 ? 'Scheduled jobs are running.' : 'Scheduled jobs need attention.'}
          </span>{' '}
          {jobProblems.length === 0
            ? (nightly?.lastRun ? `Last nightly run ${formatDateTime(nightly.lastRun.finished_at)}.` : '')
            : jobProblems.map((j) => !j.lastRun
              ? `${j.title} has never run.`
              : j.lastRun.status === 'failed'
                ? `${j.title} failed ${formatDateTime(j.lastRun.finished_at)}: ${j.lastRun.error ?? 'no detail'}.`
                : `${j.title} has not run since ${formatDateTime(j.lastRun.finished_at)}.`).join(' ')}
          {jobProblems.length > 0 ? ' See docs/runbook.md, “Scheduled jobs”.' : ''}
        </div>
      ) : null}

      <div className="mt-6 grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <Tile key={t.label} {...t} />
        ))}
      </div>

      {atRisk.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-sm font-semibold">Forecast to miss the deadline</h2>
          <p className="mt-0.5 text-xs text-muted">At each team’s pace over the last 30 days, with earlier deadlines served first.</p>
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border bg-surface">
            {atRisk.map(([id, f]) => (
              <li key={id} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2 text-sm">
                <span className="font-medium text-red-600 dark:text-red-400">{f.daysLate}d late</span>
                <Link href={`/projects/${id}`} className="hover:underline">{f.title}</Link>
                <span className="font-mono text-xs text-muted">{f.projectCode}</span>
                <span className="ml-auto text-xs text-muted">due {f.deadline} · forecast {f.finish}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {d.deadlines.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-sm font-semibold">Deadlines in the next 7 days</h2>
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border bg-surface">
            {d.deadlines.map((x) => (
              <li key={`${x.kind}-${x.id}`} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2 text-sm">
                <span className={x.daysLeft < 0 ? 'font-medium text-red-600 dark:text-red-400' : 'font-medium'}>
                  {x.daysLeft < 0 ? `${-x.daysLeft}d overdue` : x.daysLeft === 0 ? 'Today' : `${x.daysLeft}d`}
                </span>
                <Link href={x.linkPath} className="hover:underline">{x.title}</Link>
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
            <h2 className="text-sm font-semibold">{actor.role === 'sales' ? 'Waiting for the Project Manager' : 'New projects in the Project Closure Report'}</h2>
            {can(actor, 'projects.triage') ? <Link href="/triage" className="text-xs text-muted hover:underline">Open the Project Closure Report →</Link> : null}
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
          {isManagement ? (
            <p className="mt-0.5 text-xs text-muted">
              Throughput is slots approved in the last {THROUGHPUT_WINDOW_DAYS} days; on time is the share of the last {ON_TIME_WINDOW_DAYS} days’ approvals that met the slot’s due date, or the project deadline when it has none.
            </p>
          ) : null}
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
                  {isManagement ? (
                    <>
                      <th className="px-4 py-2 text-right font-medium" title={`Slots that cleared their last QA stage in the last ${THROUGHPUT_WINDOW_DAYS} days`}>Throughput</th>
                      <th className="px-4 py-2 text-right font-medium" title={`Approved by the slot’s due date, or the project deadline when it has none, over the last ${ON_TIME_WINDOW_DAYS} days`}>On time</th>
                    </>
                  ) : null}
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
                    {isManagement ? (
                      <>
                        <td className="px-4 py-2 text-right tabular-nums">{t.throughput}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{t.onTimeRate === null ? 'n/a' : `${t.onTimeRate}%`}</td>
                      </>
                    ) : null}
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
