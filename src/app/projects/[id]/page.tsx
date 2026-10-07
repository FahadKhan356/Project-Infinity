import Link from 'next/link';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { can, projectScope } from '@/lib/authz';
import { formatMoney, formatMonth } from '@/lib/projects/intake';
import { projectActivity } from '@/lib/activity/feed';
import { formatDateTime, statusLabel } from '@/lib/workspace/format';
import { loadWorkspace } from '@/lib/workspace/workspace';
import { listProjectAttachments } from '@/lib/files/attachments';
import { mayAttachToProject } from '@/lib/files/access';
import { plannedDeliverablesTotal } from '@/lib/projects/queries';
import { AttachButton } from '@/components/files/attach-button';
import { AttachmentList } from '@/components/files/attachment-list';
import { TriagePanel, type TriageDepartment } from '@/app/triage/triage-panel';
import { StatusPanel } from './status-panel';
import { SummaryButton } from './insights-panel';
import { forecasts } from '@/lib/insights/forecast';
import { canGenerateSummary, storedSummary } from '@/lib/insights/summary';
import { WorkspaceSection } from './workspace-section';
import { SharePanel } from './share-panel';
import { projectViewers, shareCandidates } from '@/lib/projects/viewers';

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
    client_notes: string | null; other_info: string | null; internal_notes: string | null;
    deadline: string | null; price_amount: string | null; price_currency: string;
    client_id: number; client_name: string;
    period_year: number; period_month: number; month_status: string; sales_owner: string | null;
    project_manager: string | null; created_at: Date; recurs_monthly: boolean; owned: boolean;
    planned_total: number;
  }>(sql`
    SELECT p.id, p.project_code, p.title, p.status, p.priority, p.objective, p.description,
           p.project_type, p.po_reference, p.requirements, p.client_notes, p.other_info, p.deadline,
           p.client_id, p.created_at, p.price_currency, p.recurs_monthly,
           -- theirs, as opposed to shared with them to read (§23)
           ${projectScope(actor, 'p')} AS owned,
           -- brief §3 "number of deliverables": the teams' counts summed, never stored
           ${plannedDeliverablesTotal('p')} AS planned_total,
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
    WHERE p.id = ${projectId} AND ${projectScope(actor, 'p', { shared: true })}
  `);
  if (!project) notFound();

  // The project is visible, so the workspace resolves; null only if it was
  // deleted between the two queries.
  const [workspace, activity, attachments, forecastMap, summary] = await Promise.all([
    loadWorkspace(actor, projectId),
    projectActivity(projectId, { showPricing }),
    listProjectAttachments(actor, projectId),
    forecasts(actor, [projectId]),
    storedSummary(actor, projectId),
  ]);
  const forecast = forecastMap.get(projectId) ?? null;
  const mayGenerate = canGenerateSummary(actor);
  const monthOpen = project.month_status !== 'closed';
  const finished = project.status === 'completed' || project.status === 'cancelled';
  // A rep the project is merely shared with reads it (§23): every control
  // that would change it is kept off the page, as the server would refuse it.
  const owned = project.owned === true;
  // Deleting is a change too (DELETE /api/files decides it the same way).
  const canDeleteFiles = owned && can(actor, 'files.delete');
  // Keeping a copy of a file is a right of its own (§43); seeing it is not.
  const canDownload = can(actor, 'files.download');
  // The one rule canAttachToProject applies, in its pure form: an open month,
  // theirs to work on, and not held, cancelled or completed (§18).
  const canAttach = mayAttachToProject({ owned, monthOpen, status: project.status });
  // The PO document (§3) has its own block beside the PO reference; every
  // other file stays where it was. Split by kind, never by the free purpose
  // label, so a PO filed as "brief" is not lost from the attachments.
  const poDocs = attachments.filter((a) => a.kind === 'po');
  const references = attachments.filter((a) => a.kind !== 'po');
  // The same people who edit the order file its PO (canAttachToProject).
  const canAttachPo = canAttach && can(actor, 'projects.edit');
  const plannedTotal = Number(project.planned_total);
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

  // Who else in Sales may view it (brief §23), for those who decide that.
  const mayShare = can(actor, 'projects.share');
  const [viewers, shareWith] = mayShare
    ? await Promise.all([projectViewers(actor, projectId), shareCandidates(actor, projectId)])
    : [[], []];

  // Routing controls appear inline on the project, so the Project Manager
  // reads the objective, PO and requirements right above the decision.
  let triageDepartments: TriageDepartment[] = [];
  if (can(actor, 'projects.triage')) {
    const rows = await db.execute<{
      id: number; name: string; selected: boolean; team_lead_id: number | null;
      planned: number; has_work: boolean; requires_pm_qa: boolean;
      leads: { id: number; name: string }[] | null;
    }>(sql`
      SELECT d.id, d.name,
             (pd.id IS NOT NULL) AS selected,
             pd.team_lead_id,
             COALESCE(pd.planned_deliverables, 0) AS planned,
             COALESCE(
               EXISTS (SELECT 1 FROM assignments a WHERE a.project_department_id = pd.id)
               OR EXISTS (SELECT 1 FROM deliverables dv WHERE dv.project_department_id = pd.id),
               false) AS has_work,
             -- Per team (§13); a team not yet on the project starts from the
             -- intake default, exactly as triage would seed it.
             COALESCE(pd.requires_pm_qa, p.requires_pm_qa) AS requires_pm_qa,
             (SELECT json_agg(json_build_object('id', u.id, 'name', u.full_name) ORDER BY u.full_name)
                FROM department_members dm
                JOIN users u ON u.id = dm.user_id
               WHERE dm.department_id = d.id AND dm.is_lead AND u.is_active) AS leads
      FROM departments d
      JOIN projects p ON p.id = ${projectId}
      LEFT JOIN project_departments pd
        ON pd.department_id = d.id AND pd.project_id = p.id
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
      requiresPmQa: r.requires_pm_qa === true,
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
            {' · '}
            {plannedTotal} deliverable{plannedTotal === 1 ? '' : 's'} planned
            {project.recurs_monthly ? (
              <span className="ml-2 rounded bg-accent/10 px-1.5 py-0.5 text-xs text-accent"
                title="Copied into each new month automatically">repeats monthly</span>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {owned && can(actor, 'projects.edit') && monthOpen && !finished ? (
            <Link href={`/projects/${project.id}/edit`}
              className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-surface">
              Edit details
            </Link>
          ) : null}
          <span className={`rounded-md border px-2.5 py-1 text-xs ${
            project.status === 'on_hold' || project.status === 'cancelled'
              ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950' : 'border-border'}`}>
            {statusLabel(project.status)}
          </span>
        </div>
      </div>

      {!owned ? (
        <p role="status" className="mt-4 rounded-md border border-border bg-surface px-4 py-3 text-sm">
          <span className="font-medium">Shared with you to view.</span>{' '}
          <span className="text-muted">
            You can read this project, its files and its activity, but not change it; that stays
            with its Sales owner{project.sales_owner ? `, ${project.sales_owner}` : ''}.
          </span>
        </p>
      ) : null}

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

      {project.status === 'on_hold' || project.status === 'cancelled' ? (
        <p role="status" className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm dark:border-amber-800 dark:bg-amber-950">
          <span className="font-medium">
            {project.status === 'on_hold' ? 'This project is on hold.' : 'This project was cancelled.'}
          </span>{' '}
          <span className="text-muted">
            {project.status === 'on_hold'
              ? 'Nothing new can be assigned or uploaded until it resumes.'
              : 'Unfinished work was withdrawn; approved files remain in the delivery queue.'}
          </span>
        </p>
      ) : null}

      {owned && can(actor, 'projects.changeStatus') && monthOpen && !finished ? (
        <StatusPanel projectId={project.id} status={project.status} />
      ) : null}

      <div className={showPricing ? 'mt-6 grid gap-4 sm:grid-cols-5' : 'mt-6 grid gap-4 sm:grid-cols-4'}>
        <Stat label="Deadline" value={project.deadline ?? '—'} />
        <Stat label="Priority" value={project.priority} />
        <Stat label="Sales owner" value={project.sales_owner ?? '—'} />
        <Stat label="Project Manager" value={project.project_manager ?? 'not assigned'} />
        {showPricing ? (
          <Stat label="Price" value={formatMoney(project.price_amount, project.price_currency)} />
        ) : null}
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

      {can(actor, 'projects.triage') && monthOpen && !finished ? (
        <TriagePanel
          projectId={project.id}
          departments={triageDepartments}
          priority={project.priority}
          deadline={project.deadline}
          internalNotes={project.internal_notes}
        />
      ) : null}

      {mayShare ? (
        <SharePanel projectId={project.id} viewers={viewers} candidates={shareWith} />
      ) : null}

      {forecast && forecast.status !== 'done' ? (
        <section className="mt-8 rounded-lg border border-border bg-surface px-4 py-3 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-semibold">Delivery forecast</h2>
            <span className={forecast.status === 'at_risk' ? 'font-medium text-red-600 dark:text-red-400' : 'text-muted'}>
              {forecast.status === 'no_history' ? 'Not enough recent history to forecast'
                : forecast.status === 'at_risk' ? `Finishes about ${forecast.finish}, ${forecast.daysLate}d after the deadline`
                : `Finishes about ${forecast.finish}${forecast.deadline ? ', within the deadline' : ''}`}
            </span>
          </div>
          <ul className="mt-2 space-y-0.5 text-xs text-muted">
            {forecast.teams.map((t) => (
              <li key={t.departmentId}>
                {t.name}: {t.remaining} to finish{t.ahead > t.remaining ? `, ${t.ahead - t.remaining} ahead of it in the queue` : ''} ·{' '}
                {t.status === 'no_history' ? 'too little history' : `${t.perWeek} a week lately`}
                {t.finish && t.status !== 'done' ? ` → ${t.finish}` : ''}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">
            From each team’s pace over the last 30 days, with earlier deadlines served first. An estimate, not a promise.
          </p>
        </section>
      ) : null}

      {summary || mayGenerate ? (
        <section className="mt-8 rounded-lg border border-border bg-surface px-4 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">Summary</h2>
            {mayGenerate ? <SummaryButton projectId={project.id} hasSummary={summary !== null} /> : null}
          </div>
          {summary ? (
            <>
              <p className="mt-2 whitespace-pre-wrap text-sm">{summary.text}</p>
              <p className="mt-2 text-xs text-muted">
                Written by AI ({summary.model}) for {summary.generatedBy}, {formatDateTime(summary.generatedAt)}. Check it against the record below.
              </p>
            </>
          ) : (
            <p className="mt-2 text-xs text-muted">
              Asks Claude, Anthropic’s AI service, to summarise this project. The project’s details
              {showPricing ? ', including price and internal notes,' : ''} are sent over the internet to Anthropic.
            </p>
          )}
        </section>
      ) : null}

      <section className="mt-8 grid gap-6 lg:grid-cols-2">
        <Panel title="Objective" body={project.objective} />
        <Panel title="Description" body={project.description} />
        <div className="rounded-lg border border-border bg-surface p-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h3 className="text-sm font-semibold">PO</h3>
            {canAttachPo ? <AttachButton projectId={project.id} kind="po" label="Add PO document" /> : null}
          </div>
          <p className="mt-2 whitespace-pre-wrap text-sm text-muted">{project.po_reference || '—'}</p>
          <div className="mt-3">
            {poDocs.length === 0
              ? <p className="text-xs text-muted">No PO document attached.</p>
              : <AttachmentList items={poDocs} canDelete={canDeleteFiles && monthOpen} canDownload={canDownload} />}
          </div>
        </div>
        <Panel title="Requirements" body={project.requirements} />
        <Panel title="Client notes" body={project.client_notes} />
        <Panel title="Other relevant information" body={project.other_info} />
        {project.internal_notes !== null ? (
          <Panel title="Internal notes" body={project.internal_notes} />
        ) : null}
      </section>

      <section className="mt-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Attachments</h2>
            <p className="mt-1 text-xs text-muted">
              Briefs and references (brief §3); the PO document is shown with the PO reference above.
              Files for one assignment or revision are listed here too.
            </p>
          </div>
          {canAttach ? <AttachButton projectId={project.id} /> : null}
        </div>
        <div className="mt-3 rounded-lg border border-border bg-surface px-4 py-3">
          {references.length === 0
            ? <p className="text-sm text-muted">Nothing attached yet.</p>
            : <AttachmentList items={references} canDelete={canDeleteFiles && monthOpen} canDownload={canDownload} showParent />}
        </div>
      </section>

      <WorkspaceSection actor={actor} workspace={workspace} attachments={references}
        canAttach={canAttach}
        canDelete={canDeleteFiles}
        canDownload={canDownload}
        canComment={owned}
        canRevise={owned && can(actor, 'revisions.create')} />

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
