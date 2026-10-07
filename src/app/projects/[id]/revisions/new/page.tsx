import Link from 'next/link';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { requireActor } from '@/lib/auth/dal';
import { AccessDenied } from '@/components/access-denied';
import { AppShell } from '@/components/app-shell';
import { can, projectScope } from '@/lib/authz';
import { NewRevisionForm } from './new-revision-form';

/** Sales opens a revision on a project (brief §15). `?deliverable=` preselects a slot. */
export default async function NewRevisionPage(props: PageProps<'/projects/[id]/revisions/new'>) {
  const actor = await requireActor();
  const { id } = await props.params;
  const projectId = Number(id);
  if (!Number.isInteger(projectId)) notFound();

  if (!can(actor, 'revisions.create')) {
    return (
      <AppShell actor={actor}>
        <AccessDenied what="opening revisions" />
      </AppShell>
    );
  }

  const db = getDb();
  const [project] = await db.execute<{ id: number; title: string; project_code: string; next_no: number }>(sql`
    SELECT p.id, p.title, p.project_code,
           (SELECT COALESCE(MAX(revision_no), 0) + 1 FROM revisions r WHERE r.project_id = p.id) AS next_no
    FROM projects p
    WHERE p.id = ${projectId} AND ${projectScope(actor, 'p')}
  `);
  if (!project) notFound();

  const params = await props.searchParams;
  const preselected = Number(params.deliverable);

  const slots = await db.execute<{ id: number; name: string; department: string; status: string }>(sql`
    SELECT d.id, d.name, dept.name AS department, d.status
    FROM deliverables d
    JOIN project_departments pd ON pd.id = d.project_department_id
    JOIN departments dept ON dept.id = pd.department_id
    WHERE d.project_id = ${projectId} AND d.status <> 'cancelled'
    ORDER BY dept.sort_order, d.sequence_no
  `);

  return (
    <AppShell actor={actor}>
      <Link href={`/projects/${projectId}#workspace`} className="text-sm text-muted hover:text-foreground">
        ← {project.title}
      </Link>
      <h1 className="mt-2 text-lg font-semibold tracking-tight">Open a revision</h1>
      <p className="mt-1 max-w-prose text-sm text-muted">
        <span className="font-mono">{project.project_code}</span> · The teams whose deliverables you pick will
        see it; the slots go back to the Executive as work to redo.
      </p>

      <div className="mt-6">
        {slots.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">
            This project has no deliverables yet.
          </p>
        ) : (
          <NewRevisionForm
            projectId={projectId}
            nextNumber={Number(project.next_no)}
            deliverables={slots.map((s) => ({
              id: Number(s.id),
              label: `${s.department} — ${s.name}`,
              status: s.status,
              preselected: Number(s.id) === preselected,
            }))}
          />
        )}
      </div>
    </AppShell>
  );
}
