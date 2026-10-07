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
      <h1 className="text-lg font-semibold tracking-tight">Planning</h1>
      <p className="mt-1 max-w-prose text-sm text-muted">
        {seesEverything
          ? 'Work routed to every team.'
          : 'Work routed to the teams you lead. You do not see other teams’ rows.'}
      </p>

      {rows.length === 0 ? (
        <p className="mt-6 rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">
          Nothing routed to you yet. The Project Manager assigns work from the Project Closure Report.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Project</th>
                <th className="px-4 py-2.5 font-medium">Client</th>
                <th className="px-4 py-2.5 font-medium">Month</th>
                <th className="px-4 py-2.5 font-medium">Team</th>
                {seesEverything ? <th className="px-4 py-2.5 font-medium">Lead</th> : null}
                <th className="px-4 py-2.5 font-medium">Assigned to</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium text-right">Planned</th>
                <th className="px-4 py-2.5 font-medium text-right">Progress</th>
                <th className="px-4 py-2.5 font-medium">Dates</th>
                <th className="px-4 py-2.5 font-medium">Deadline</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.teamId} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5">
                    <Link href={`/planning/${r.teamId}`} className="font-medium hover:underline">
                      {r.title}
                    </Link>
                    <div className="font-mono text-xs text-muted">{r.projectCode}</div>
                  </td>
                  <td className="px-4 py-2.5 text-muted">{r.clientName}</td>
                  <td className="px-4 py-2.5 text-muted">
                    {formatMonth(r.periodYear, r.periodMonth)}
                  </td>
                  <td className="px-4 py-2.5">
                    <Link href={`/planning/${r.teamId}`} className="hover:underline">{r.department}</Link>
                  </td>
                  {seesEverything ? (
                    <td className="px-4 py-2.5 text-muted">{r.teamLead ?? 'not assigned'}</td>
                  ) : null}
                  <td className="px-4 py-2.5 text-muted">{r.assignees ?? 'nobody yet'}</td>
                  <td className="px-4 py-2.5 text-muted">{statusLabel(r.status)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted">{r.planned}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted">
                    {r.approved}/{r.slots}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-muted">
                    {r.startsOn || r.endsOn ? `${r.startsOn ?? '—'} → ${r.endsOn ?? '—'}` : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{r.deadline ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-xs text-muted">
        Open a row to see the team’s workload and assign work.
      </p>

      {roster.length > 0 ? (
        <section className="mt-10">
          <h2 className="text-base font-semibold tracking-tight">Teams</h2>
          <p className="mt-1 max-w-prose text-sm text-muted">
            {seesEverything
              ? 'Every production team: who leads it, who is in it, how loaded each person is, and what they are on.'
              : 'Your team: members, their workload, and what each person is on.'}
          </p>

          {roster.map((t) => (
            <div key={t.departmentId} className="mt-6 rounded-lg border border-border bg-surface">
              <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
                <div>
                  <h3 className="font-semibold">{t.name}</h3>
                  <p className="text-xs text-muted">
                    {t.leads.length > 0 ? `Led by ${t.leads.map((l) => l.fullName).join(', ')}` : 'No lead assigned'}
                    {' · '}{t.members.length} member{t.members.length === 1 ? '' : 's'}
                  </p>
                </div>
                <dl className="flex gap-4 text-xs text-muted">
                  <div><dt className="inline">Open slots </dt><dd className="inline font-medium text-foreground tabular-nums">{t.openSlots}</dd></div>
                  <div><dt className="inline">Assignments </dt><dd className="inline font-medium text-foreground tabular-nums">{t.activeAssignments}</dd></div>
                </dl>
              </header>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                    <tr>
                      <th className={th}>Member</th>
                      <th className={thNum}>Open</th>
                      <th className={thNum}>In QA</th>
                      <th className={thNum}>Due ≤7d</th>
                      <th className={th}>Assignments</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.members.length === 0 ? (
                      <tr><td colSpan={5} className={`${td} text-muted`}>Nobody in this team yet.</td></tr>
                    ) : t.members.map((m) => (
                      <tr key={m.userId} className="border-b border-border last:border-0">
                        <td className={`${td} whitespace-nowrap`}>
                          {m.fullName}
                          {m.isLead ? <span className="ml-1.5 text-xs text-muted">lead</span> : null}
                        </td>
                        <td className={tdNum}>{m.openSlots}</td>
                        <td className={tdNum}>{m.inQa}</td>
                        <td className={`${tdNum} ${m.dueSoon > 0 ? 'text-accent' : ''}`}>{m.dueSoon}</td>
                        <td className={td}>
                          {m.assignments.length === 0 ? (
                            <span className="text-muted">Nothing assigned.</span>
                          ) : (
                            <ul className="space-y-1">
                              {m.assignments.map((a) => (
                                <li key={a.assignmentId}>
                                  <div>
                                    <Link href={`/planning/${a.teamId}`} className="font-mono hover:underline">
                                      {a.projectCode}
                                    </Link>
                                    {' '}{a.projectTitle} · {a.clientName}
                                  </div>
                                  <div className="text-xs text-muted">
                                    {a.title} · {a.startDate ?? '—'} → {a.endDate ?? '—'}
                                    {' · '}{a.approved}/{a.total} approved
                                    {' · '}{statusLabel(a.projectStatus)}
                                    {a.deadline ? ` · due ${a.deadline}` : ''}
                                  </div>
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    ))}
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
