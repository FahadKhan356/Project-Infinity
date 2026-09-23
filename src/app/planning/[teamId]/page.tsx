import Link from 'next/link';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { requireActor } from '@/lib/auth/dal';
import { AccessDenied } from '@/components/access-denied';
import { AppShell } from '@/components/app-shell';
import { can } from '@/lib/authz';
import { isProjectVisible } from '@/lib/authz/queries';
import { formatMonth } from '@/lib/projects/intake';
import { teamWorkload } from '@/lib/planning/workload';
import { AssignPanel } from './assign-panel';

export default async function TeamPlanningPage(props: PageProps<'/planning/[teamId]'>) {
  const actor = await requireActor();
  const { teamId } = await props.params;
  const projectDepartmentId = Number(teamId);
  if (!Number.isInteger(projectDepartmentId)) notFound();

  const db = getDb();

  const [team] = await db.execute<{
    id: number; project_id: number; department_id: number; department: string;
    team_lead_id: number | null; team_lead: string | null; planned: number;
    project_code: string; title: string; status: string; priority: string;
    deadline: string | null; client_name: string;
    period_year: number; period_month: number; requirements: string | null;
    objective: string | null;
  }>(sql`
    SELECT pd.id, pd.project_id, pd.department_id, d.name AS department,
           pd.team_lead_id, tl.full_name AS team_lead, pd.planned_deliverables AS planned,
           p.project_code, p.title, p.status, p.priority, p.deadline,
           p.requirements, p.objective,
           c.name AS client_name, cm.period_year, cm.period_month
    FROM project_departments pd
    JOIN departments d    ON d.id = pd.department_id
    JOIN projects p       ON p.id = pd.project_id
    JOIN clients c        ON c.id = p.client_id
    JOIN client_months cm ON cm.id = p.client_month_id
    LEFT JOIN users tl    ON tl.id = pd.team_lead_id
    WHERE pd.id = ${projectDepartmentId}
  `);
  if (!team) notFound();

  // Visible only through the project, so the same rule governs both.
  if (!(await isProjectVisible(db, actor, Number(team.project_id)))) notFound();

  const isLeadOfTeam = team.team_lead_id !== null && Number(team.team_lead_id) === actor.id;
  const mayPlan = isLeadOfTeam || can(actor, 'planning.viewAllDepartments');
  if (!mayPlan) {
    return (
      <AppShell actor={actor}>
        <AccessDenied what="planning for this team" />
      </AppShell>
    );
  }

  const [existing, workload] = await Promise.all([
    db.execute<{
      id: number; title: string; assignee: string; assignee_id: number;
      start_date: string | null; end_date: string | null; status: string; priority: string;
      total: number; approved: number; uploaded: number;
    }>(sql`
      SELECT a.id, a.title, u.full_name AS assignee, a.assignee_id,
             a.start_date, a.end_date, a.status, a.priority,
             prog.total, prog.approved, prog.started AS uploaded
      FROM assignments a
      JOIN users u ON u.id = a.assignee_id
      JOIN v_assignment_progress prog ON prog.assignment_id = a.id
      WHERE a.project_department_id = ${projectDepartmentId}
      ORDER BY a.created_at DESC
    `),
    teamWorkload(Number(team.department_id)),
  ]);

  const slotsCreated = existing.reduce((sum, a) => sum + Number(a.total), 0);
  const approved = existing.reduce((sum, a) => sum + Number(a.approved), 0);

  return (
    <AppShell actor={actor}>
      <Link href="/planning" className="text-sm text-muted hover:text-foreground">← Planning</Link>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            {team.department} — {team.title}
          </h1>
          <p className="mt-1 text-sm text-muted">
            <Link href={`/projects/${team.project_id}`} className="font-mono hover:underline">
              {team.project_code}
            </Link>
            {' · '}{team.client_name}
            {' · '}{formatMonth(Number(team.period_year), Number(team.period_month))}
            {team.deadline ? ` · due ${team.deadline}` : ''}
          </p>
        </div>
        <span className="rounded-md border border-border px-2.5 py-1 text-xs capitalize">
          {team.priority} priority
        </span>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Promised at intake" value={String(Number(team.planned))} />
        <Stat label="Slots created" value={String(slotsCreated)} />
        <Stat label="Approved" value={`${approved}/${slotsCreated}`} />
      </div>

      {Number(team.planned) > slotsCreated ? (
        <p className="mt-3 rounded-md border border-accent/40 bg-accent/5 px-3 py-2 text-xs">
          {Number(team.planned) - slotsCreated} of the {Number(team.planned)} deliverables Sales
          promised have no slot yet.
        </p>
      ) : null}

      {team.objective || team.requirements ? (
        <section className="mt-6 rounded-lg border border-border bg-surface p-5">
          {team.objective ? (
            <>
              <h2 className="text-sm font-semibold">Objective</h2>
              <p className="mt-1.5 whitespace-pre-wrap text-sm text-muted">{team.objective}</p>
            </>
          ) : null}
          {team.requirements ? (
            <>
              <h2 className="mt-4 text-sm font-semibold">Requirements</h2>
              <p className="mt-1.5 whitespace-pre-wrap text-sm text-muted">{team.requirements}</p>
            </>
          ) : null}
        </section>
      ) : null}

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Team workload</h2>
        <p className="mt-1 text-xs text-muted">
          Open slots are deliverables not yet approved, across every project — a count of
          committed work, not an estimate of hours.
        </p>
        <div className="mt-3 overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Member</th>
                <th className="px-4 py-2.5 font-medium text-right">Open slots</th>
                <th className="px-4 py-2.5 font-medium text-right">In QA</th>
                <th className="px-4 py-2.5 font-medium text-right">Due ≤7 days</th>
                <th className="px-4 py-2.5 font-medium text-right">Assignments</th>
                <th className="px-4 py-2.5 font-medium text-right">On this team</th>
              </tr>
            </thead>
            <tbody>
              {workload.map((m) => (
                <tr key={m.userId} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5">
                    {m.fullName}
                    {m.isLead ? <span className="ml-2 text-xs text-muted">lead</span> : null}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{m.openSlots}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted">{m.inQa}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted">{m.dueSoon}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted">{m.activeAssignments}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted">{m.onThisTeam}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Assignments</h2>
        {existing.length === 0 ? (
          <p className="mt-3 rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">
            Nothing assigned yet.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Assignment</th>
                  <th className="px-4 py-2.5 font-medium">Executive</th>
                  <th className="px-4 py-2.5 font-medium">Dates</th>
                  <th className="px-4 py-2.5 font-medium text-right">Progress</th>
                  <th className="px-4 py-2.5 font-medium text-right">Uploaded</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {existing.map((a) => (
                  <tr key={a.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2.5 font-medium">{a.title}</td>
                    <td className="px-4 py-2.5 text-muted">{a.assignee}</td>
                    <td className="px-4 py-2.5 text-muted">
                      {a.start_date ?? '—'} → {a.end_date ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {Number(a.approved)}/{Number(a.total)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted">
                      {Number(a.uploaded)}/{Number(a.total)}
                    </td>
                    <td className="px-4 py-2.5 text-muted">{a.status.replace(/_/g, ' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-muted">
          Progress counts approved slots. Uploaded shows what has arrived but not yet cleared QA.
        </p>
      </section>

      <AssignPanel
        projectDepartmentId={projectDepartmentId}
        members={workload.map((m) => ({ id: m.userId, name: m.fullName, openSlots: m.openSlots }))}
        defaultBaseName={team.department}
        remaining={Math.max(0, Number(team.planned) - slotsCreated)}
        deadline={team.deadline}
      />
    </AppShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-muted">{label}</div>
    </div>
  );
}
