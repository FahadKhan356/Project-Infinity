import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { can } from '@/lib/authz';
import { loadTeamOverview } from '@/lib/teams/overview';
import { statusLabel } from '@/lib/workspace/format';

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
 * Team Overview (brief §5, §6). The PM sees every production team; a Team
 * Lead sees the teams they lead and nothing else. Workload is a count of
 * committed slots — see src/lib/planning/workload.ts for what it means.
 */
export default async function TeamsPage() {
  const actor = await requireActor();
  const teams = await loadTeamOverview(actor);
  if (!teams) notFound();
  const seesAll = can(actor, 'planning.viewAllDepartments');

  return (
    <AppShell actor={actor}>
      {/* Page Header */}
      <div className="flex flex-col gap-2 border-b border-border/70 pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              Team overview
            </h1>
            <span className="rounded-full border border-accent/25 bg-accent/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-accent">
              {seesAll ? 'All Departments' : 'Your Teams'}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted sm:text-sm">
            {seesAll
              ? 'Every production team: who leads it, who is in it, how loaded each person is, and active project routing.'
              : 'The teams you lead: member workloads, active capacity, and projects currently routed to you.'}
          </p>
        </div>
      </div>

      {teams.length === 0 ? (
        <div className="mt-6 rounded-xl border border-border/80 bg-surface/90 px-6 py-8 text-center text-sm text-muted">
          No production teams found for your account.
        </div>
      ) : null}

      {teams.map((t) => (
        <section
          key={t.departmentId}
          className="mt-8 overflow-hidden rounded-xl border border-border/80 bg-surface/90 shadow-xs backdrop-blur-xs"
        >
          {/* Section Header with KPI summary pills */}
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 bg-background/35 px-5 py-4">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/15 text-accent shadow-xs">
                {getDepartmentIcon(t.name)}
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-bold text-foreground">{t.name}</h2>
                  <span className="rounded-full border border-border/80 bg-background/80 px-2 py-0.2 text-[11px] font-medium text-muted">
                    {t.members.length} {t.members.length === 1 ? 'member' : 'members'}
                  </span>
                </div>
                <p className="text-xs text-muted">
                  {t.leads.length > 0
                    ? `Led by ${t.leads.map((l) => l.fullName).join(', ')}`
                    : 'No lead assigned'}
                </p>
              </div>
            </div>

            {/* Top KPI indicators */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/20 bg-sky-500/10 px-2.5 py-1 text-xs font-semibold text-sky-400">
                <span className="text-muted/80 font-normal">Active projects:</span>
                <span>{t.activeProjects}</span>
              </span>

              <span className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-background/80 px-2.5 py-1 text-xs font-medium text-foreground">
                <span className="text-muted font-normal">Open slots:</span>
                <span>{t.openSlots}</span>
              </span>

              <span
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold ${
                  t.inQa > 0
                    ? 'border-amber-500/20 bg-amber-500/10 text-amber-400'
                    : 'border-border/70 bg-background/80 text-muted'
                }`}
              >
                <span className="text-muted font-normal">In QA:</span>
                <span>{t.inQa}</span>
              </span>

              <span
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold ${
                  t.overdueSlots > 0
                    ? 'border-rose-500/30 bg-rose-500/10 text-rose-400'
                    : 'border-border/70 bg-background/80 text-muted'
                }`}
              >
                <span className="text-muted font-normal">Overdue:</span>
                <span>{t.overdueSlots}</span>
              </span>
            </div>
          </header>

          {/* Side-by-side: Members on left, Projects on right */}
          <div className="grid gap-0 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1.8fr)]">
            {/* Members Section */}
            <div className="overflow-x-auto border-b border-border/70 lg:border-b-0 lg:border-r">
              <div className="border-b border-border/60 bg-surface/50 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted">
                Team members ({t.members.length})
              </div>
              <table className="w-full min-w-[420px] text-sm">
                <thead className="border-b border-border/60 bg-background/40 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                  <tr>
                    <th className="px-4 py-2.5">Member</th>
                    <th className="px-3 py-2.5 text-right">Open</th>
                    <th className="px-3 py-2.5 text-right">In QA</th>
                    <th className="px-3 py-2.5 text-right">Due soon</th>
                    <th className="px-4 py-2.5 text-right">Tasks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {t.members.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-sm text-muted">
                        Nobody assigned to this team yet.
                      </td>
                    </tr>
                  ) : (
                    t.members.map((m) => (
                      <tr key={m.userId} className="transition-colors hover:bg-background/40">
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2.5">
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-bold text-accent">
                              {getInitials(m.fullName)}
                            </span>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-medium text-foreground">{m.fullName}</span>
                              {m.isLead ? (
                                <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.2 text-[10px] font-bold uppercase tracking-wider text-emerald-400">
                                  Lead
                                </span>
                              ) : null}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right font-medium tabular-nums text-foreground">
                          {m.openSlots}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {m.inQa > 0 ? (
                            <span className="inline-flex rounded-md border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.2 text-xs font-semibold text-amber-400">
                              {m.inQa}
                            </span>
                          ) : (
                            <span className="text-muted/60">0</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {m.dueSoon > 0 ? (
                            <span className="inline-flex rounded-md border border-rose-500/20 bg-rose-500/10 px-1.5 py-0.2 text-xs font-semibold text-rose-400">
                              {m.dueSoon}
                            </span>
                          ) : (
                            <span className="text-muted/60">0</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-muted">
                          {m.activeAssignments}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Active Projects Section */}
            <div className="overflow-x-auto">
              <div className="border-b border-border/60 bg-surface/50 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted">
                Active projects ({t.projects.length})
              </div>
              <table className="w-full min-w-[500px] text-sm">
                <thead className="border-b border-border/60 bg-background/40 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                  <tr>
                    <th className="px-4 py-2.5">Project</th>
                    <th className="px-3 py-2.5">Lead</th>
                    <th className="px-3 py-2.5">Status</th>
                    <th className="px-3 py-2.5 text-right">Approved</th>
                    <th className="px-4 py-2.5">Timeline</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {t.projects.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-sm text-muted">
                        No active projects currently routed to this team.
                      </td>
                    </tr>
                  ) : (
                    t.projects.map((p) => (
                      <tr key={p.projectDepartmentId} className="transition-colors hover:bg-background/40">
                        <td className="px-4 py-3">
                          <Link
                            href={`/planning/${p.projectDepartmentId}`}
                            className="font-semibold text-foreground hover:text-accent hover:underline"
                          >
                            {p.title}
                          </Link>
                          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                            <span className="rounded border border-border/80 bg-background/80 px-1.5 py-0.2 font-mono text-[11px] text-muted">
                              {p.projectCode}
                            </span>
                            <span>·</span>
                            <span>{p.clientName}</span>
                          </div>
                        </td>
                        <td className="px-3 py-3 text-xs text-muted">
                          {p.teamLead ? (
                            <span className="font-medium text-foreground">{p.teamLead}</span>
                          ) : (
                            <span className="text-muted/60">—</span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <span
                            className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold capitalize ${getStatusBadgeClass(
                              p.status,
                            )}`}
                          >
                            {statusLabel(p.status)}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          <span className="font-semibold text-foreground">
                            {p.approved}/{p.total}
                          </span>
                          {p.overdueSlots > 0 ? (
                            <div className="mt-0.5 text-[11px] font-semibold text-rose-400">
                              {p.overdueSlots} overdue
                            </div>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-xs text-muted">
                          {p.startDate || p.endDate ? (
                            <span className="font-medium text-foreground/90">
                              {p.startDate ?? '…'} → {p.endDate ?? '…'}
                            </span>
                          ) : (
                            <span className="text-muted/60">Not planned</span>
                          )}
                          <div className="mt-0.5 text-[11px]">
                            Deadline: <span className="font-medium text-foreground">{p.deadline ?? '—'}</span>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ))}
    </AppShell>
  );
}
