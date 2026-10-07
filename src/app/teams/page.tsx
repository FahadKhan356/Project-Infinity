import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { can } from '@/lib/authz';
import { loadTeamOverview } from '@/lib/teams/overview';
import { statusLabel } from '@/lib/workspace/format';

const th = 'px-3 py-2 font-medium';
const thNum = 'px-3 py-2 font-medium text-right';
const td = 'px-3 py-2';
const tdNum = 'px-3 py-2 text-right tabular-nums';

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
      <h1 className="text-lg font-semibold tracking-tight">Team overview</h1>
      <p className="mt-1 max-w-prose text-sm text-muted">
        {seesAll
          ? 'Every production team: who leads it, who is in it, how loaded each person is, and what it is working on.'
          : 'The teams you lead: members, their workload, and the projects routed to you.'}
      </p>

      {teams.length === 0 ? (
        <p className="mt-6 rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">
          No production teams.
        </p>
      ) : null}

      {teams.map((t) => (
        <section key={t.departmentId} className="mt-8 rounded-lg border border-border bg-surface">
          <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
            <div>
              <h2 className="font-semibold">{t.name}</h2>
              <p className="text-xs text-muted">
                {t.leads.length > 0 ? `Led by ${t.leads.map((l) => l.fullName).join(', ')}` : 'No lead assigned'}
                {' · '}{t.members.length} member{t.members.length === 1 ? '' : 's'}
              </p>
            </div>
            <dl className="flex gap-4 text-xs text-muted">
              <div><dt className="inline">Active projects </dt><dd className="inline font-medium text-foreground tabular-nums">{t.activeProjects}</dd></div>
              <div><dt className="inline">Open slots </dt><dd className="inline font-medium text-foreground tabular-nums">{t.openSlots}</dd></div>
              <div><dt className="inline">In QA </dt><dd className="inline font-medium text-foreground tabular-nums">{t.inQa}</dd></div>
              <div>
                <dt className="inline">Overdue </dt>
                <dd className={`inline font-medium tabular-nums ${t.overdueSlots > 0 ? 'text-accent' : 'text-foreground'}`}>
                  {t.overdueSlots}
                </dd>
              </div>
            </dl>
          </header>

          <div className="grid gap-0 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <div className="overflow-x-auto border-b border-border lg:border-b-0 lg:border-r">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className={th}>Member</th>
                    <th className={thNum}>Open</th>
                    <th className={thNum}>In QA</th>
                    <th className={thNum}>Due soon</th>
                    <th className={thNum}>Assignments</th>
                  </tr>
                </thead>
                <tbody>
                  {t.members.length === 0 ? (
                    <tr><td colSpan={5} className={`${td} text-muted`}>Nobody in this team yet.</td></tr>
                  ) : t.members.map((m) => (
                    <tr key={m.userId} className="border-b border-border last:border-0">
                      <td className={td}>
                        {m.fullName}
                        {m.isLead ? <span className="ml-1.5 text-xs text-muted">lead</span> : null}
                      </td>
                      <td className={tdNum}>{m.openSlots}</td>
                      <td className={tdNum}>{m.inQa}</td>
                      <td className={`${tdNum} ${m.dueSoon > 0 ? 'text-accent' : ''}`}>{m.dueSoon}</td>
                      <td className={tdNum}>{m.activeAssignments}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className={th}>Project</th>
                    <th className={th}>Lead</th>
                    <th className={th}>Status</th>
                    <th className={thNum}>Approved</th>
                    <th className={th}>Dates</th>
                  </tr>
                </thead>
                <tbody>
                  {t.projects.length === 0 ? (
                    <tr><td colSpan={5} className={`${td} text-muted`}>No active projects.</td></tr>
                  ) : t.projects.map((p) => (
                    <tr key={p.projectDepartmentId} className="border-b border-border last:border-0">
                      <td className={td}>
                        <Link href={`/planning/${p.projectDepartmentId}`} className="font-medium hover:underline">
                          {p.title}
                        </Link>
                        <div className="text-xs text-muted">
                          <span className="font-mono">{p.projectCode}</span> · {p.clientName}
                        </div>
                      </td>
                      <td className={`${td} text-muted`}>{p.teamLead ?? '—'}</td>
                      <td className={`${td} capitalize`}>{statusLabel(p.status)}</td>
                      <td className={tdNum}>
                        {p.approved}/{p.total}
                        {p.overdueSlots > 0 ? (
                          <div className="text-xs text-accent">{p.overdueSlots} overdue</div>
                        ) : null}
                      </td>
                      <td className={`${td} whitespace-nowrap text-xs text-muted`}>
                        {p.startDate || p.endDate ? `${p.startDate ?? '…'} → ${p.endDate ?? '…'}` : 'Not planned'}
                        <div>Deadline {p.deadline ?? '—'}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ))}
    </AppShell>
  );
}
