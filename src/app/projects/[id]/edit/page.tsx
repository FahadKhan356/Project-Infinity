import Link from 'next/link';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { can, projectScope } from '@/lib/authz';
import { EditProjectForm } from './edit-project-form';

export default async function EditProjectPage(props: PageProps<'/projects/[id]/edit'>) {
  const actor = await requireActor();
  const { id } = await props.params;
  const projectId = Number(id);
  if (!Number.isInteger(projectId) || !can(actor, 'projects.edit')) notFound();

  const showPricing = can(actor, 'pricing.view');
  const [project] = await getDb().execute<{
    id: number; project_code: string; title: string; status: string; month_status: string;
    project_type: string | null; objective: string | null; description: string | null;
    po_reference: string | null; requirements: string | null; client_notes: string | null;
    other_info: string | null; price_amount: string | null; price_currency: string; recurs_monthly: boolean;
  }>(sql`
    SELECT p.id, p.project_code, p.title, p.status, cm.status AS month_status,
           p.project_type, p.objective, p.description, p.po_reference, p.requirements,
           p.client_notes, p.other_info, p.price_currency, p.recurs_monthly,
           ${showPricing ? sql`p.price_amount::text` : sql`NULL::text`} AS price_amount
    FROM projects p
    JOIN client_months cm ON cm.id = p.client_month_id
    WHERE p.id = ${projectId} AND ${projectScope(actor, 'p')}
  `);
  if (!project) notFound();

  const locked = project.month_status === 'closed'
    ? 'This project’s month is closed, so its details are read-only.'
    : project.status === 'completed' || project.status === 'cancelled'
      ? `This project is ${project.status}; its details can no longer change.`
      : null;

  // Each team's QA route (brief §13) is the one routing choice editable here.
  const teams = locked ? [] : (await getDb().execute<{
    department_id: number; name: string; requires_pm_qa: boolean;
  }>(sql`
    SELECT pd.department_id, d.name, pd.requires_pm_qa
    FROM project_departments pd
    JOIN departments d ON d.id = pd.department_id
    WHERE pd.project_id = ${projectId}
    ORDER BY d.sort_order
  `)).map((t) => ({
    departmentId: Number(t.department_id),
    name: t.name,
    requiresPmQa: t.requires_pm_qa === true,
  }));

  return (
    <AppShell actor={actor}>
      <Link href={`/projects/${project.id}`} className="text-sm text-muted hover:text-foreground">
        ← {project.project_code}
      </Link>
      <h1 className="mt-2 text-lg font-semibold tracking-tight">Edit project details</h1>
      <p className="mt-1 text-sm text-muted">
        What Sales filed (brief §3). Teams, deliverable counts, priority, deadline and internal
        notes are set by the Project Manager when routing, on the project page; whether each
        team’s files also go to the Project Manager for QA can be changed here.
      </p>
      <div className="mt-6 max-w-2xl">
        {locked ? (
          <p role="status" className="rounded-md border border-border bg-surface px-4 py-3 text-sm">{locked}</p>
        ) : (
          <EditProjectForm
            project={{
              id: Number(project.id),
              title: project.title,
              projectType: project.project_type,
              objective: project.objective,
              description: project.description,
              poReference: project.po_reference,
              requirements: project.requirements,
              clientNotes: project.client_notes,
              otherInfo: project.other_info,
              priceAmount: project.price_amount,
              priceCurrency: project.price_currency,
              recursMonthly: project.recurs_monthly === true,
            }}
            teams={teams}
            canSetPricing={showPricing}
          />
        )}
      </div>
    </AppShell>
  );
}
