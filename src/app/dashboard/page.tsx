import Link from 'next/link';
import { forecasts } from '@/lib/insights/forecast';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { can } from '@/lib/authz';
import { backupHealth } from '@/lib/backup/health';
import { loadDashboard, ON_TIME_WINDOW_DAYS, THROUGHPUT_WINDOW_DAYS } from '@/lib/dashboard/dashboard';
import { jobsHealth } from '@/lib/jobs/health';
import { salesLeaderboard } from '@/lib/leaderboard/sales';
import { SalesLeaderboard } from '@/components/sales-leaderboard';
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

  // Sales, CEO and COO only (null for everyone else); privacy is applied in the query.
  const leaderboard = await salesLeaderboard(actor);

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
      <div className="flex flex-col gap-2 border-b border-border/70 pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              {ROLE_TITLE[actor.role] ?? 'Dashboard'}
            </h1>
            <span className="rounded-full border border-accent/25 bg-accent/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-accent">
              {actor.role === 'team_lead' ? 'Team Lead' : actor.role === 'project_manager' ? 'PM' : actor.role}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted sm:text-sm">
            {isExecutive
              ? 'What is on your desk, your active assignments, and deliverables due.'
              : 'Everything below is scoped to your department access and active projects.'}
          </p>
        </div>
        <div className="flex items-center gap-2 self-start text-xs text-muted sm:self-auto">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-surface/80 px-2.5 py-1">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="font-medium text-foreground/80">Live portal</span>
          </span>
        </div>
      </div>

      {backups ? (
        <div role={backups.state === 'ok' ? 'status' : 'alert'}
          className={`mt-5 rounded-xl border px-4 py-3.5 text-sm ${backups.state === 'ok'
            ? 'border-border/80 bg-surface/80 text-muted'
            : 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950'}`}>
          <span className="font-semibold text-foreground">
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
          className={`mt-5 rounded-xl border px-4 py-3.5 text-sm ${jobProblems.length === 0
            ? 'border-border/80 bg-surface/80 text-muted'
            : 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950'}`}>
          <span className="font-semibold text-foreground">
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

      {/* Responsive metric cards grid */}
      <div className={`mt-6 grid gap-3.5 ${
        tiles.length === 6
          ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-6'
          : tiles.length <= 4
            ? 'grid-cols-2 sm:grid-cols-4'
            : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4'
      }`}>
        {tiles.map((t) => (
          <Tile key={t.label} {...t} />
        ))}
      </div>

      {leaderboard ? (
        <SalesLeaderboard
          initial={leaderboard}
          viewerId={actor.id}
          viewerName={actor.fullName}
          allowDemo={process.env.NODE_ENV !== 'production'}
        />
      ) : null}

      {atRisk.length > 0 ? (
        <section className="mt-8 overflow-hidden rounded-xl border border-rose-500/30 bg-surface/90 shadow-xs">
          <div className="border-b border-border/70 bg-rose-500/5 px-5 py-3.5">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-rose-500 dark:text-rose-400">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
                <circle cx="10" cy="10" r="7" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6v4.5l3 1.5" />
              </svg>
              <span>Forecast to miss the deadline</span>
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              At each team’s pace over the last 30 days, with earlier deadlines served first.
            </p>
          </div>
          <ul className="divide-y divide-border/60">
            {atRisk.map(([id, f]) => (
              <li key={id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm transition-colors hover:bg-background/40">
                <div className="flex items-center gap-2.5">
                  <span className="inline-flex items-center rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-xs font-semibold text-rose-500">
                    {f.daysLate}d late
                  </span>
                  <Link href={`/projects/${id}`} className="font-medium text-foreground hover:text-accent hover:underline">
                    {f.title}
                  </Link>
                  <span className="rounded border border-border/80 bg-background/80 px-1.5 py-0.5 font-mono text-xs text-muted">
                    {f.projectCode}
                  </span>
                </div>
                <span className="text-xs text-muted">
                  due <span className="font-medium text-foreground">{f.deadline}</span> · forecast {f.finish}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {d.deadlines.length > 0 ? (
        <section className="mt-8 overflow-hidden rounded-xl border border-border/80 bg-surface/90 shadow-xs">
          <div className="flex items-center justify-between border-b border-border/70 bg-background/30 px-5 py-3.5">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-500/10 text-amber-500">
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5" aria-hidden="true">
                  <rect x="3" y="4" width="14" height="13" rx="2" strokeLinecap="round" strokeLinejoin="round" />
                  <path strokeLinecap="round" d="M3 8h14M7 2v3M13 2v3" />
                </svg>
              </span>
              <h2 className="text-sm font-semibold tracking-tight text-foreground">Deadlines in the next 7 days</h2>
            </div>
            <span className="rounded-full border border-border/80 bg-background/80 px-2.5 py-0.5 text-xs font-medium text-muted">
              {d.deadlines.length} due
            </span>
          </div>
          <ul className="divide-y divide-border/60">
            {d.deadlines.map((x) => (
              <li key={`${x.kind}-${x.id}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm transition-colors hover:bg-background/40">
                <div className="flex items-center gap-2.5">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
                      x.daysLeft < 0
                        ? 'border border-rose-500/30 bg-rose-500/10 text-rose-400'
                        : x.daysLeft === 0
                          ? 'border border-amber-500/30 bg-amber-500/10 text-amber-400'
                          : 'border border-sky-500/30 bg-sky-500/10 text-sky-400'
                    }`}
                  >
                    {x.daysLeft < 0 ? `${-x.daysLeft}d overdue` : x.daysLeft === 0 ? 'Today' : `${x.daysLeft}d left`}
                  </span>
                  <Link href={x.linkPath} className="font-medium text-foreground hover:text-accent hover:underline">
                    {x.title}
                  </Link>
                  <span className="rounded border border-border/80 bg-background/80 px-1.5 py-0.5 font-mono text-xs text-muted">
                    {x.projectCode}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted">
                  <span className="capitalize">{x.kind}</span>
                  <span>·</span>
                  <span className="font-medium text-foreground">{x.due}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {d.intake.length > 0 ? (
        <section className="mt-8 overflow-hidden rounded-xl border border-border/80 bg-surface/90 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 bg-background/30 px-5 py-3.5">
            <h2 className="text-sm font-semibold tracking-tight text-foreground">
              {actor.role === 'sales' ? 'Waiting for the Project Manager' : 'New projects in the Project Closure Report'}
            </h2>
            {can(actor, 'projects.triage') ? (
              <Link href="/triage" className="text-xs font-medium text-accent hover:underline">
                Open the Project Closure Report →
              </Link>
            ) : null}
          </div>
          <ul className="divide-y divide-border/60">
            {d.intake.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm transition-colors hover:bg-background/40">
                <div className="flex items-center gap-2.5">
                  <Link href={`/projects/${p.id}`} className="font-medium text-foreground hover:text-accent hover:underline">
                    {p.title}
                  </Link>
                  <span className="rounded border border-border/80 bg-background/80 px-1.5 py-0.5 font-mono text-xs text-muted">
                    {p.projectCode}
                  </span>
                  <span className="text-muted">{p.clientName}</span>
                </div>
                <span className="text-xs text-muted">{formatDateTime(p.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {d.planningGaps.length > 0 ? (
        <section className="mt-8 overflow-hidden rounded-xl border border-amber-500/30 bg-surface/90 shadow-xs">
          <div className="flex items-center justify-between border-b border-border/70 bg-amber-500/5 px-5 py-3.5">
            <h2 className="text-sm font-semibold tracking-tight text-amber-500 dark:text-amber-400">
              Assigned to your team, not yet planned
            </h2>
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-semibold text-amber-500">
              {d.planningGaps.length} gaps
            </span>
          </div>
          <ul className="divide-y divide-border/60">
            {d.planningGaps.map((g) => (
              <li key={g.projectDepartmentId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm transition-colors hover:bg-background/40">
                <div className="flex items-center gap-2.5">
                  <Link href={`/planning/${g.projectDepartmentId}`} className="font-semibold text-foreground hover:text-accent hover:underline">
                    {g.title}
                  </Link>
                  <span className="rounded border border-border/80 bg-background/80 px-1.5 py-0.5 font-mono text-xs text-muted">
                    {g.projectCode}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-muted">{g.department}</span>
                  <span className="rounded-md border border-border/80 bg-background/80 px-2 py-0.5 font-medium text-foreground">
                    {g.plannedDeliverables} planned
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Modern Department Performance / "Your team" Table */}
      {d.departments.length > 0 ? (
        <section className="mt-8 overflow-hidden rounded-xl border border-border/80 bg-surface/90 shadow-xs backdrop-blur-xs">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 bg-background/30 px-5 py-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/10 text-accent">
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10 3a3 3 0 100 6 3 3 0 000-6zM3.5 16a6.5 6.5 0 0113 0" />
                  </svg>
                </span>
                <h2 className="text-sm font-semibold tracking-tight text-foreground">
                  {isLead ? 'Your team performance' : 'Department performance'}
                </h2>
              </div>
              <p className="mt-1 text-xs text-muted">
                {isManagement
                  ? `Throughput: slots approved in last ${THROUGHPUT_WINDOW_DAYS}d · On time: met slot due date or project deadline over last ${ON_TIME_WINDOW_DAYS}d.`
                  : 'Active projects, slot distribution, QA rounds, and approval rates.'}
              </p>
            </div>
            <span className="rounded-md border border-border/80 bg-background/80 px-2.5 py-1 text-xs font-medium text-muted">
              {d.departments.length} {d.departments.length === 1 ? 'Department' : 'Departments'}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-sm">
              <thead className="border-b border-border/70 bg-background/50 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-5 py-3">Team</th>
                  <th className="px-4 py-3 text-right">Active projects</th>
                  <th className="px-4 py-3 text-right">Open slots</th>
                  <th className="px-4 py-3 text-right">In QA</th>
                  <th className="px-4 py-3 text-right">Approved</th>
                  <th className="px-4 py-3 text-right">QA rounds</th>
                  <th className="px-5 py-3 text-right">Sent back</th>
                  {isManagement ? (
                    <>
                      <th className="px-4 py-3 text-right" title={`Slots that cleared their last QA stage in the last ${THROUGHPUT_WINDOW_DAYS} days`}>
                        Throughput
                      </th>
                      <th className="px-5 py-3 text-right" title={`Approved by the slot’s due date, or the project deadline when it has none, over the last ${ON_TIME_WINDOW_DAYS} days`}>
                        On time
                      </th>
                    </>
                  ) : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {d.departments.map((t) => (
                  <tr key={t.departmentId} className="transition-colors hover:bg-background/40">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10 text-accent">
                          {getDepartmentIcon(t.name)}
                        </span>
                        <span className="font-semibold text-foreground">{t.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-right tabular-nums">
                      <span className="inline-flex items-center rounded-full border border-sky-500/20 bg-sky-500/10 px-2.5 py-0.5 text-xs font-semibold text-sky-400">
                        {t.activeProjects}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-right font-medium tabular-nums text-foreground">
                      {t.openSlots}
                    </td>
                    <td className="px-4 py-3.5 text-right tabular-nums">
                      {t.inQa > 0 ? (
                        <span className="inline-flex items-center rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-0.5 text-xs font-semibold text-amber-400">
                          {t.inQa}
                        </span>
                      ) : (
                        <span className="text-muted/60">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-right tabular-nums">
                      {t.approved > 0 ? (
                        <span className="inline-flex items-center rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-400">
                          {t.approved}
                        </span>
                      ) : (
                        <span className="text-muted/60">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-right tabular-nums text-muted">
                      {t.reviews}
                    </td>
                    <td className="px-5 py-3.5 text-right tabular-nums">
                      {t.rejected > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/20 bg-rose-500/10 px-2.5 py-0.5 text-xs font-semibold text-rose-400">
                          <span>{t.rejected}</span>
                          {t.reviews > 0 ? (
                            <span className="font-normal text-[11px] opacity-80">
                              ({Math.round((t.rejected / t.reviews) * 100)}%)
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-muted/60">0</span>
                      )}
                    </td>
                    {isManagement ? (
                      <>
                        <td className="px-4 py-3.5 text-right font-medium tabular-nums text-foreground">
                          {t.throughput}
                        </td>
                        <td className="px-5 py-3.5 text-right tabular-nums">
                          {t.onTimeRate === null ? (
                            <span className="text-muted">n/a</span>
                          ) : (
                            <span
                              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                                t.onTimeRate >= 80
                                  ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
                                  : t.onTimeRate >= 50
                                    ? 'border border-amber-500/20 bg-amber-500/10 text-amber-400'
                                    : 'border border-rose-500/20 bg-rose-500/10 text-rose-400'
                              }`}
                            >
                              {t.onTimeRate}%
                            </span>
                          )}
                        </td>
                      </>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* Modern Team Workload Section */}
      {d.workload.length > 0 ? (
        <section className="mt-8 overflow-hidden rounded-xl border border-border/80 bg-surface/90 shadow-xs backdrop-blur-xs">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 bg-background/30 px-5 py-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/10 text-accent">
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h12M4 10h12M4 14h7" />
                  </svg>
                </span>
                <h2 className="text-sm font-semibold tracking-tight text-foreground">Team workload</h2>
              </div>
              <p className="mt-1 text-xs text-muted">Open slots per person: committed work deliverables, not hours.</p>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted">
              <span className="inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-background/80 px-2.5 py-1">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                <span>Available</span>
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-background/80 px-2.5 py-1">
                <span className="h-2 w-2 rounded-full bg-sky-500" />
                <span>Active</span>
              </span>
            </div>
          </div>

          <div className={`p-4 sm:p-5 ${d.workload.length > 1 ? 'grid gap-5 lg:grid-cols-2' : ''}`}>
            {d.workload.map((w) => (
              <div key={w.departmentId} className="overflow-hidden rounded-xl border border-border/70 bg-background/40">
                {/* Department Header */}
                <div className="flex items-center justify-between border-b border-border/70 bg-surface/60 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/15 text-accent">
                      {getDepartmentIcon(w.name)}
                    </span>
                    <span className="text-sm font-semibold text-foreground">{w.name} Team</span>
                  </div>
                  <span className="rounded-full border border-border/80 bg-background/90 px-2.5 py-0.5 text-xs font-medium text-muted">
                    {w.members.length} {w.members.length === 1 ? 'member' : 'members'}
                  </span>
                </div>

                {w.members.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-muted">No members assigned to this department yet.</p>
                ) : (
                  <div className="divide-y divide-border/50">
                    {w.members.map((m) => {
                      const isOverloaded = m.dueSoon > 0 || m.openSlots > 4;
                      const isActive = m.openSlots > 0 || m.inQa > 0;
                      return (
                        <div
                          key={m.userId}
                          className="flex flex-col gap-2.5 px-4 py-3 transition-colors hover:bg-surface/50 sm:flex-row sm:items-center sm:justify-between"
                        >
                          {/* Member Profile + Role */}
                          <div className="flex items-center gap-3">
                            <div className="relative">
                              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-bold text-accent ring-1 ring-accent/20">
                                {getInitials(m.fullName)}
                              </span>
                              <span
                                className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-background ${
                                  isOverloaded
                                    ? 'bg-rose-500'
                                    : isActive
                                      ? 'bg-sky-500'
                                      : 'bg-emerald-500'
                                }`}
                                title={isOverloaded ? 'Needs attention / items due' : isActive ? 'Active assignments' : 'Available capacity'}
                              />
                            </div>
                            <div>
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="text-sm font-semibold text-foreground">{m.fullName}</span>
                                {m.isLead ? (
                                  <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.2 text-[10px] font-bold uppercase tracking-wider text-emerald-400">
                                    Lead
                                  </span>
                                ) : null}
                              </div>
                              <div className="text-[11px] text-muted">
                                {isOverloaded
                                  ? 'Needs attention / items due'
                                  : isActive
                                    ? `${m.activeAssignments} active assignment${m.activeAssignments === 1 ? '' : 's'}`
                                    : 'Available for new assignments'}
                              </div>
                            </div>
                          </div>

                          {/* Workload metric badges */}
                          <div className="flex items-center gap-2 self-start sm:self-auto">
                            <span
                              className={`inline-flex items-center rounded-lg border px-2.5 py-1 text-xs font-medium tabular-nums ${
                                m.openSlots > 0
                                  ? 'border-sky-500/20 bg-sky-500/10 text-sky-400'
                                  : 'border-border/60 bg-surface text-muted/70'
                              }`}
                            >
                              {m.openSlots} open
                            </span>

                            <span
                              className={`inline-flex items-center rounded-lg border px-2.5 py-1 text-xs font-medium tabular-nums ${
                                m.inQa > 0
                                  ? 'border-amber-500/20 bg-amber-500/10 font-semibold text-amber-400'
                                  : 'border-border/60 bg-surface text-muted/70'
                              }`}
                            >
                              {m.inQa} in QA
                            </span>

                            <span
                              className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium tabular-nums ${
                                m.dueSoon > 0
                                  ? 'border-rose-500/30 bg-rose-500/10 font-bold text-rose-400'
                                  : 'border-border/60 bg-surface text-muted/70'
                              }`}
                            >
                              {m.dueSoon > 0 ? <span className="h-1.5 w-1.5 rounded-full bg-rose-500" /> : null}
                              {m.dueSoon} due soon
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {isExecutive ? (
        <p className="mt-8 text-sm text-muted">
          <Link href="/work" className="font-medium text-accent underline underline-offset-2">My work</Link> lists each assignment with its brief and files.
        </p>
      ) : null}
    </AppShell>
  );
}

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

function getDepartmentIcon(name: string) {
  const n = name.toLowerCase();
  if (n.includes('video')) {
    return (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 6A1.5 1.5 0 015 4.5h7A1.5 1.5 0 0113.5 6v8a1.5 1.5 0 01-1.5 1.5H5A1.5 1.5 0 013.5 14V6z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 8.5l3.5-2v7l-3.5-2" />
      </svg>
    );
  }
  if (n.includes('dev') || n.includes('web') || n.includes('mobile')) {
    return (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 7l-3.5 3 3.5 3M14 7l3.5 3-3.5 3M11.5 5.5l-3 9" />
      </svg>
    );
  }
  if (n.includes('design') || n.includes('art') || n.includes('creative')) {
    return (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
        <circle cx="7" cy="7" r="1.5" />
        <circle cx="13" cy="7" r="1.5" />
        <circle cx="13.5" cy="12.5" r="1.5" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M10 2.5a7.5 7.5 0 105.3 12.8 2.5 2.5 0 00-2.3-4.3H11A1 1 0 0110 10V2.5z" />
      </svg>
    );
  }
  if (n.includes('market') || n.includes('ppc') || n.includes('seo')) {
    return (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 10l9-4v9L3 11v-1zM12 6h2a3 3 0 013 3v0a3 3 0 01-3 3h-2" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 3a3 3 0 100 6 3 3 0 000-6zM3.5 16a6.5 6.5 0 0113 0" />
    </svg>
  );
}

function getTileIcon(label: string) {
  const l = label.toLowerCase();
  if (l.includes('project')) {
    return (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h3.5l2 2H15a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V5z" />
      </svg>
    );
  }
  if (l.includes('plan')) {
    return (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
        <rect x="3" y="4" width="14" height="13" rx="2" strokeLinecap="round" strokeLinejoin="round" />
        <path strokeLinecap="round" d="M3 8h14M7 2v3M13 2v3" />
      </svg>
    );
  }
  if (l.includes('task') || l.includes('assignment')) {
    return (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
        <rect x="3.5" y="3.5" width="13" height="13" rx="2.5" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M7 10l2 2 4-4" />
      </svg>
    );
  }
  if (l.includes('qa')) {
    return (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M10 2.5l6 2.5v5c0 4.2-2.8 7.3-6 8.5-3.2-1.2-6-4.3-6-8.5V5l6-2.5z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 10l1.5 1.5 3-3" />
      </svg>
    );
  }
  if (l.includes('revis') || l.includes('redo')) {
    return (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 10a6 6 0 1111.3 2.8M15.5 8.5v4.5H11" />
      </svg>
    );
  }
  if (l.includes('delay') || l.includes('overdue')) {
    return (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
        <circle cx="10" cy="10" r="7" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M10 6v4.5l3 1.5" />
      </svg>
    );
  }
  if (l.includes('deliver')) {
    return (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.5V6.5L10 3l7 3.5v7l-7 3.5-7-3.5z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 6.5l7 3.5 7-3.5M10 10v7" />
      </svg>
    );
  }
  if (l.includes('value')) {
    return (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
        <rect x="2.5" y="4.5" width="15" height="11" rx="2" />
        <circle cx="10" cy="10" r="2.5" />
        <path strokeLinecap="round" d="M5.5 7.5h.01M14.5 12.5h.01" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2V6z" />
    </svg>
  );
}

function Tile({ label, value, href, warn }: { label: string; value: string | number; href?: string; warn?: boolean }) {
  const isNumber = typeof value === 'number';
  const isPositive = isNumber ? value > 0 : value !== '$0' && value !== 'AED 0.00' && value !== 'Rs 0' && !String(value).includes('0.00');
  const isWarning = warn && isPositive;

  const content = (
    <div
      className={`group relative flex flex-col justify-between overflow-hidden rounded-xl border p-4 transition-all duration-200 ${
        isWarning
          ? 'border-rose-500/40 bg-gradient-to-b from-rose-500/10 via-surface to-surface shadow-xs hover:border-rose-500/70 dark:border-rose-500/30'
          : 'border-border/80 bg-surface/90 shadow-2xs hover:border-accent/60 hover:bg-surface hover:shadow-md'
      }`}
    >
      {/* Top row: Label + Icon */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11.5px] font-medium tracking-tight text-muted line-clamp-1 group-hover:text-foreground/90 transition-colors">
          {label}
        </span>
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors ${
            isWarning
              ? 'bg-rose-500/15 text-rose-500 dark:text-rose-400'
              : 'bg-background/80 text-muted group-hover:bg-accent/10 group-hover:text-accent'
          }`}
        >
          {getTileIcon(label)}
        </span>
      </div>

      {/* Middle row: Big Metric Number */}
      <div className="mt-3 flex items-baseline justify-between">
        <div
          className={`text-2xl sm:text-3xl font-bold tracking-tight tabular-nums ${
            isWarning
              ? 'text-rose-500 dark:text-rose-400'
              : isPositive
                ? 'text-foreground'
                : 'text-muted/65 font-semibold'
          }`}
        >
          {value}
        </div>
        {href ? (
          <span className="flex items-center gap-0.5 text-xs font-semibold text-accent opacity-0 transition-all duration-150 group-hover:opacity-100 group-hover:translate-x-0.5">
            View <span aria-hidden="true">→</span>
          </span>
        ) : null}
      </div>

      {/* Subtle indicator bar on hover or warn */}
      {isWarning ? (
        <span className="absolute inset-x-0 bottom-0 h-0.5 bg-rose-500/80" aria-hidden="true" />
      ) : null}
    </div>
  );

  return href ? (
    <Link href={href} className="block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-accent">
      {content}
    </Link>
  ) : (
    content
  );
}
