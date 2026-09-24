import Link from 'next/link';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { can, projectScope } from '@/lib/authz';
import { formatMoney, formatMonth } from '@/lib/projects/intake';
import { projectActivity } from '@/lib/activity/feed';
import { formatDateTime } from '@/lib/workspace/format';
import { loadWorkspace } from '@/lib/workspace/workspace';
import { TriagePanel, type TriageDepartment } from '@/app/triage/triage-panel';
import { WorkspaceSection } from './workspace-section';

export default async function ProjectPage(props: PageProps<'/projects/[id]'>) {
  const actor = await requireActor();
  const { id } = await props.params;
  const projectId = Number(id);
  if (!Number.isInteger(projectId)) notFound();

  const showPricing = can(actor, 'pricing.view');
  const db = getDb();

  const [project] = await db.execute<{
    id: number; project_code: string; title: string; status: string; priority: string;
    objective: string | null; description: string | null; project_type: string | null;
    po_reference: string | null; requirements: string | null;
    client_notes: string | null; internal_notes: string | null;
    deadline: string | null; price_amount: string | null; price_currency: string;
    requires_pm_qa: boolean; client_id: number; client_name: string;
    period_year: number; period_month: number; month_status: string; sales_owner: string | null;
    project_manager: string | null; created_at: Date;
  }>(sql`
    SELECT p.id, p.project_code, p.title, p.status, p.priority, p.objective, p.description,
           p.project_type, p.po_reference, p.requirements, p.client_notes, p.deadline,
           p.requires_pm_qa, p.client_id, p.created_at, p.price_currency,
           ${showPricing ? sql`p.price_amount` : sql`NULL::numeric`} AS price_amount,
           ${can(actor, 'projects.viewAll') || can(actor, 'projects.create')
             ? sql`p.internal_notes` : sql`NULL::text`} AS internal_notes,
           c.name AS client_name, cm.period_year, cm.period_month, cm.status AS month_status,
           so.full_name AS sales_owner, pm.full_name AS project_manager
    FROM projects p
    JOIN clients c        ON c.id = p.client_id
    JOIN client_months cm ON cm.id = p.client_month_id
    LEFT JOIN users so    ON so.id = p.sales_owner_id
    LEFT JOIN users pm    ON pm.id = p.project_manager_id
    WHERE p.id = ${projectId} AND ${projectScope(actor, 'p')}
  `);
  if (!project) notFound();

  // The project is visible, so the workspace resolves; null only if it was
  // deleted between the two queries.
  const [workspace, activity] = await Promise.all([
    loadWorkspace(actor, projectId),
    projectActivity(projectId),
  ]);
  if (!workspace) notFound();

  const teams = await db.execute<{
    department: string; team_lead: string | null; planned: number;
    slots: number; approved: number; requires_pm_qa: boolean;
  }>(sql`
    SELECT d.name AS department, tl.full_name AS team_lead,
           pd.planned_deliverables AS planned, pd.requires_pm_qa,
           (SELECT count(*) FROM deliverables dv WHERE dv.project_department_id = pd.id
              AND dv.status <> 'cancelled')::int AS slots,
           (SELECT count(*) FROM deliverables dv WHERE dv.project_department_id = pd.id
              AND dv.status IN ('approved','delivered'))::int AS approved
    FROM project_departments pd
    JOIN departments d  ON d.id = pd.department_id
    LEFT JOIN users tl  ON tl.id = pd.team_lead_id
    WHERE pd.project_id = ${projectId}
    ORDER BY d.sort_order
  `);

  // Routing controls appear inline on the project, so the Project Manager
  // reads the objective, PO and requirements right above the decision.
  let triageDepartments: TriageDepartment[] = [];
  if (can(actor, 'projects.triage')) {
    const rows = await db.execute<{
      id: number; name: string; selected: boolean; team_lead_id: number | null;
      planned: number; has_work: boolean; leads: { id: number; name: string }[] | null;
    }>(sql`
      SELECT d.id, d.name,
             (pd.id IS NOT NULL) AS selected,
             pd.team_lead_id,
             COALESCE(pd.planned_deliverables, 0) AS planned,
             COALESCE(
               EXISTS (SELECT 1 FROM assignments a WHERE a.project_department_id = pd.id)
               OR EXISTS (SELECT 1 FROM deliverables dv WHERE dv.project_department_id = pd.id),
               false) AS has_work,
             (SELECT json_agg(json_build_object('id', u.id, 'name', u.full_name) ORDER BY u.full_name)
                FROM department_members dm
                JOIN users u ON u.id = dm.user_id
               WHERE dm.department_id = d.id AND dm.is_lead AND u.is_active) AS leads
      FROM departments d
      LEFT JOIN project_departments pd
        ON pd.department_id = d.id AND pd.project_id = ${projectId}
      WHERE d.is_production AND d.is_active
      ORDER BY d.sort_order
    `);
    triageDepartments = rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      selected: r.selected === true,
      teamLeadId: r.team_lead_id === null ? null : Number(r.team_lead_id),
      plannedDeliverables: Number(r.planned),
      hasWork: r.has_work === true,
      leads: (r.leads ?? []).map((l) => ({ id: Number(l.id), name: l.name })),
    }));
  }

  return (
    <AppShell actor={actor}>
      <Link href="/projects" className="text-sm text-muted hover:text-foreground">← Projects</Link>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{project.title}</h1>
          <p className="mt-1 text-sm text-muted">
            <span className="font-mono">{project.project_code}</span>
            {' · '}
            <Link href={`/clients/${project.client_id}`} className="hover:underline">
              {project.client_name}
            </Link>
            {' · '}
            {formatMonth(Number(project.period_year), Number(project.period_month))}
          </p>
        </div>
        <span className="rounded-md border border-border px-2.5 py-1 text-xs">
          {project.status.replace(/_/g, ' ')}
        </span>
      </div>

      {project.month_status === 'closed' ? (
        <p role="status" className="mt-4 rounded-md border border-border bg-surface px-4 py-3 text-sm">
          <span className="font-medium">
            {formatMonth(Number(project.period_year), Number(project.period_month))} is closed.
          </span>{' '}
          <span className="text-muted">
            This project is part of the client’s archive and is read-only.
            {can(actor, 'month.reopen')
              ? ' You can reopen the month from the client page.'
              : ' Management can reopen the month if something needs to change.'}
          </span>
        </p>
      ) : null}

      <div className="mt-6 grid gap-4 sm:grid-cols-4">
        <Stat label="Deadline" value={project.deadline ?? '—'} />
        <Stat label="Priority" value={project.priority} />
        <Stat label="Sales owner" value={project.sales_owner ?? '—'} />
        {showPricing ? (
          <Stat label="Price" value={formatMoney(project.price_amount, project.price_currency)} />
        ) : (
          <Stat label="Project Manager" value={project.project_manager ?? 'not assigned'} />
        )}
      </div>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Teams</h2>
        <div className="mt-3 overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Team</th>
                <th className="px-4 py-2.5 font-medium">Team Lead</th>
                <th className="px-4 py-2.5 font-medium text-right">Planned</th>
                <th className="px-4 py-2.5 font-medium text-right">Slots created</th>
                <th className="px-4 py-2.5 font-medium text-right">Approved</th>
                <th className="px-4 py-2.5 font-medium">PM QA</th>
              </tr>
            </thead>
            <tbody>
              {teams.map((t) => (
                <tr key={t.department} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5 font-medium">{t.department}</td>
                  <td className="px-4 py-2.5 text-muted">{t.team_lead ?? 'not assigned'}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted">{Number(t.planned)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted">{Number(t.slots)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{Number(t.approved)}</td>
                  <td className="px-4 py-2.5 text-muted">{t.requires_pm_qa ? 'required' : 'not required'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {can(actor, 'projects.triage') && project.month_status !== 'closed' ? (
        <TriagePanel
          projectId={project.id}
          departments={triageDepartments}
          priority={project.priority}
          deadline={project.deadline}
          internalNotes={project.internal_notes}
          requiresPmQa={project.requires_pm_qa}
        />
      ) : null}

      <section className="mt-8 grid gap-6 lg:grid-cols-2">
        <Panel title="Objective" body={project.objective} />
        <Panel title="Description" body={project.description} />
        <Panel title="PO reference" body={project.po_reference} />
        <Panel title="Requirements" body={project.requirements} />
        <Panel title="Client notes" body={project.client_notes} />
        {project.internal_notes !== null ? (
          <Panel title="Internal notes" body={project.internal_notes} />
        ) : null}
      </section>

      <WorkspaceSection actor={actor} workspace={workspace} />

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Activity</h2>
        <p className="mt-1 text-xs text-muted">
          Who did what, in order (brief §25). Downloads are logged but not shown here.
        </p>
        {activity.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No activity recorded yet.</p>
        ) : (
          <ol className="mt-3 rounded-lg border border-border bg-surface px-4 py-2 text-sm">
            {activity.map((line) => (
              <li key={line.id} className="flex gap-3 border-b border-border py-2 last:border-0">
                <span className="w-32 shrink-0 tabular-nums text-xs text-muted">{formatDateTime(line.at)}</span>
                <span>{line.text}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </AppShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="text-sm font-medium capitalize">{value}</div>
      <div className="mt-0.5 text-xs text-muted">{label}</div>
    </div>
  );
}

function Panel({ title, body }: { title: string; body: string | null }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-2 whitespace-pre-wrap text-sm text-muted">{body || '—'}</p>
    </div>
  );
}
