import Link from 'next/link';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { can } from '@/lib/authz';
import { planningBoard } from '@/lib/planning/board';
import { planningRoster } from '@/lib/planning/roster';
import { formatMonth } from '@/lib/projects/intake';
import { statusLabel } from '@/lib/workspace/format';

const th = 'px-3 py-2 font-medium';
const thNum = 'px-3 py-2 font-medium text-right';
const td = 'px-3 py-2 align-top';
const tdNum = 'px-3 py-2 align-top text-right tabular-nums';

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

function getStatusBadgeClass(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('deliver') || s.includes('complete')) {
    return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400';
  }
  if (s.includes('qa') || s.includes('review')) {
    return 'border-amber-500/25 bg-amber-500/10 text-amber-400';
  }
  if (s.includes('delay') || s.includes('overdue')) {
    return 'border-rose-500/25 bg-rose-500/10 text-rose-400';
  }
  return 'border-sky-500/25 bg-sky-500/10 text-sky-400';
}

/**
 * The planning page (brief §6), on one screen.
 *
 * The board: every routed team-row — for the PM across every team, for a
 * Team Lead only the teams they lead. The rows come from lib/planning/board.ts,
 * so the scope is the one the tests prove.
 *
 * The Teams section below it: every production team, its leads, its members
 * with their workload, and what each person is on — dates, progress and
 * project status — from lib/planning/roster.ts, under the same scope.
 */
export default async function PlanningPage() {
  const actor = await requireActor();
  const seesEverything = can(actor, 'planning.viewAllDepartments');
  const [rows, roster] = await Promise.all([planningBoard(actor), planningRoster(actor)]);

  return (
    <AppShell actor={actor}>
      {/* Page Header */}
      <div className="flex flex-col gap-2 border-b border-border/70 pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">Planning</h1>
            <span className="rounded-full border border-accent/25 bg-accent/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-accent">
              {seesEverything ? 'Production Board' : 'Team Lead Board'}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted sm:text-sm">
            {seesEverything
              ? 'Work routed to every production team across all active projects.'
              : 'Work routed to the teams you lead. Open any project department row to schedule deliverables.'}
          </p>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="mt-6 rounded-xl border border-border/80 bg-surface/90 px-6 py-8 text-center text-sm text-muted">
          Nothing routed to you yet. The Project Manager assigns work from the Project Closure Report.
        </div>
      ) : (
        <div className="mt-6 overflow-hidden rounded-xl border border-border/80 bg-surface/90 shadow-xs backdrop-blur-xs">
          <div className="flex items-center justify-between border-b border-border/70 bg-background/35 px-5 py-3.5">
            <h2 className="text-sm font-semibold tracking-tight text-foreground">Production Routing Board</h2>
            <span className="rounded-full border border-border/80 bg-background/80 px-2.5 py-0.5 text-xs font-medium text-muted">
              {rows.length} {rows.length === 1 ? 'project department' : 'project departments'}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-sm">
              <thead className="border-b border-border/70 bg-background/50 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-5 py-3">Project</th>
                  <th className="px-4 py-3">Client</th>
                  <th className="px-4 py-3">Month</th>
                  <th className="px-4 py-3">Team</th>
                  {seesEverything ? <th className="px-4 py-3">Lead</th> : null}
                  <th className="px-4 py-3">Assigned to</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Planned</th>
                  <th className="px-4 py-3 text-right">Progress</th>
                  <th className="px-4 py-3">Dates</th>
                  <th className="px-5 py-3">Deadline</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {rows.map((r) => (
                  <tr key={r.teamId} className="transition-colors hover:bg-background/40">
                    <td className="px-5 py-3.5">
                      <Link href={`/planning/${r.teamId}`} className="font-semibold text-foreground hover:text-accent hover:underline">
                        {r.title}
                      </Link>
                      <div className="mt-0.5">
                        <span className="rounded border border-border/80 bg-background/80 px-1.5 py-0.2 font-mono text-[11px] text-muted">
                          {r.projectCode}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-xs text-muted">{r.clientName}</td>
                    <td className="px-4 py-3.5 text-xs text-muted whitespace-nowrap">
                      {formatMonth(r.periodYear, r.periodMonth)}
                    </td>
                    <td className="px-4 py-3.5">
                      <Link href={`/planning/${r.teamId}`} className="font-medium text-foreground hover:text-accent hover:underline">
                        {r.department}
                      </Link>
                    </td>
                    {seesEverything ? (
                      <td className="px-4 py-3.5 text-xs text-muted">{r.teamLead ?? 'not assigned'}</td>
                    ) : null}
                    <td className="px-4 py-3.5 text-xs text-muted">{r.assignees ?? 'nobody yet'}</td>
                    <td className="px-4 py-3.5">
                      <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold capitalize ${getStatusBadgeClass(r.status)}`}>
                        {statusLabel(r.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-right tabular-nums text-foreground font-medium">{r.planned}</td>
                    <td className="px-4 py-3.5 text-right tabular-nums">
                      <span className="font-semibold text-foreground">
                        {r.approved}/{r.slots}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 whitespace-nowrap text-xs text-muted">
                      {r.startsOn || r.endsOn ? `${r.startsOn ?? '—'} → ${r.endsOn ?? '—'}` : '—'}
                    </td>
                    <td className="px-5 py-3.5 text-xs font-medium text-foreground whitespace-nowrap">{r.deadline ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="mt-4 text-xs text-muted">
        Open any row to configure slot breakdowns, view assignments, and schedule deliverable files.
      </p>

      {roster.length > 0 ? (
        <section className="mt-10">
          <div className="border-b border-border/70 pb-4">
            <h2 className="text-lg font-bold tracking-tight text-foreground">Team Workload & Active Assignments</h2>
            <p className="mt-0.5 text-xs text-muted sm:text-sm">
              {seesEverything
                ? 'Every production team: who leads it, who is in it, capacity load, and what each person is working on.'
                : 'Your team: members, current open slots, and assigned deliverables.'}
            </p>
          </div>

          {roster.map((t) => (
            <div key={t.departmentId} className="mt-6 overflow-hidden rounded-xl border border-border/80 bg-surface/90 shadow-xs backdrop-blur-xs">
              <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 bg-background/35 px-5 py-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-bold text-foreground">{t.name} Team</h3>
                    <span className="rounded-full border border-border/80 bg-background/80 px-2 py-0.2 text-[11px] font-medium text-muted">
                      {t.members.length} {t.members.length === 1 ? 'member' : 'members'}
                    </span>
                  </div>
                  <p className="text-xs text-muted">
                    {t.leads.length > 0 ? `Led by ${t.leads.map((l) => l.fullName).join(', ')}` : 'No lead assigned'}
                  </p>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="rounded-lg border border-border/70 bg-background/80 px-2.5 py-1 text-muted">
                    Open slots: <strong className="font-semibold text-foreground">{t.openSlots}</strong>
                  </span>
                  <span className="rounded-lg border border-border/70 bg-background/80 px-2.5 py-1 text-muted">
                    Active assignments: <strong className="font-semibold text-foreground">{t.activeAssignments}</strong>
                  </span>
                </div>
              </header>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[700px] text-sm">
                  <thead className="border-b border-border/70 bg-background/50 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                    <tr>
                      <th className="px-5 py-3">Member</th>
                      <th className="px-3 py-3 text-right">Open</th>
                      <th className="px-3 py-3 text-right">In QA</th>
                      <th className="px-3 py-3 text-right">Due ≤7d</th>
                      <th className="px-5 py-3">Current Assignments</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {t.members.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-5 py-6 text-center text-sm text-muted">
                          Nobody assigned to this team yet.
                        </td>
                      </tr>
                    ) : (
                      t.members.map((m) => (
                        <tr key={m.userId} className="transition-colors hover:bg-background/40">
                          <td className="px-5 py-3.5 align-top">
                            <div className="flex items-center gap-2.5">
                              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-bold text-accent">
                                {getInitials(m.fullName)}
                              </span>
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="font-semibold text-foreground">{m.fullName}</span>
                                {m.isLead ? (
                                  <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.2 text-[10px] font-bold uppercase tracking-wider text-emerald-400">
                                    Lead
                                  </span>
                                ) : null}
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-3.5 align-top text-right font-medium tabular-nums text-foreground">
                            {m.openSlots}
                          </td>
                          <td className="px-3 py-3.5 align-top text-right tabular-nums">
                            {m.inQa > 0 ? (
                              <span className="inline-flex rounded-md border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.2 text-xs font-semibold text-amber-400">
                                {m.inQa}
                              </span>
                            ) : (
                              <span className="text-muted/60">0</span>
                            )}
                          </td>
                          <td className="px-3 py-3.5 align-top text-right tabular-nums">
                            {m.dueSoon > 0 ? (
                              <span className="inline-flex rounded-md border border-rose-500/20 bg-rose-500/10 px-1.5 py-0.2 text-xs font-semibold text-rose-400">
                                {m.dueSoon}
                              </span>
                            ) : (
                              <span className="text-muted/60">0</span>
                            )}
                          </td>
                          <td className="px-5 py-3.5 align-top">
                            {m.assignments.length === 0 ? (
                              <span className="text-xs text-muted">Nothing currently assigned.</span>
                            ) : (
                              <ul className="space-y-2">
                                {m.assignments.map((a) => (
                                  <li key={a.assignmentId} className="rounded-lg border border-border/70 bg-background/50 p-2.5">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <Link href={`/planning/${a.teamId}`} className="rounded border border-border/80 bg-background/90 px-1.5 py-0.2 font-mono text-[11px] font-semibold text-foreground hover:text-accent">
                                        {a.projectCode}
                                      </Link>
                                      <span className="font-medium text-foreground text-xs">{a.projectTitle}</span>
                                      <span className="text-xs text-muted">· {a.clientName}</span>
                                    </div>
                                    <div className="mt-1 flex items-center gap-2 text-xs text-muted flex-wrap">
                                      <span className="font-medium text-foreground/90">{a.title}</span>
                                      <span>·</span>
                                      <span>{a.startDate ?? '—'} → {a.endDate ?? '—'}</span>
                                      <span>·</span>
                                      <span className="font-semibold text-foreground">{a.approved}/{a.total} approved</span>
                                      <span>·</span>
                                      <span className="capitalize">{statusLabel(a.projectStatus)}</span>
                                      {a.deadline ? (
                                        <>
                                          <span>·</span>
                                          <span className="text-rose-400 font-medium">due {a.deadline}</span>
                                        </>
                                      ) : null}
                                    </div>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </section>
      ) : null}
    </AppShell>
  );
}
