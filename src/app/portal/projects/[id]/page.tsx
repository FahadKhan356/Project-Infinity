import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireClientActor } from '@/lib/auth/dal';
import { FilePreview } from '@/components/files/file-preview';
import { formatMonth } from '@/lib/projects/intake';
import { markProjectNewsRead, portalClientName, portalProject } from '@/lib/portal/portal';
import { formatBytes, formatDateTime } from '@/lib/workspace/format';
import { DecisionForm } from '../../decision-form';
import { PortalShell } from '../../portal-shell';

const decisionLabel = (d: 'approved' | 'changes_requested' | null, status: string) =>
  d === 'approved' ? 'You approved this'
    : d === 'changes_requested' ? 'You asked for changes'
    : status === 'completed' ? 'Completed'
    : status === 'delivered' ? 'Waiting for your review'
    : 'With the team';

export default async function PortalProjectPage(props: PageProps<'/portal/projects/[id]'>) {
  const actor = await requireClientActor();
  const { id } = await props.params;
  const projectId = Number(id);
  if (!Number.isInteger(projectId)) notFound();
  const [project, clientName] = await Promise.all([portalProject(actor, projectId), portalClientName(actor)]);
  if (!project) notFound();
  await markProjectNewsRead(actor, projectId);

  return (
    <PortalShell actor={actor} clientName={clientName}>
      <Link href="/portal" className="text-sm text-muted hover:text-foreground">← All projects</Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{project.title}</h1>
          <p className="mt-1 text-sm text-muted">
            <span className="font-mono">{project.projectCode}</span> · {formatMonth(project.period.year, project.period.month)}
            {project.deadline ? ` · due ${project.deadline}` : ''}
          </p>
        </div>
        <span className="rounded-md border border-border px-2.5 py-1 text-xs">{project.status}</span>
      </div>
      {project.objective ? <p className="mt-4 max-w-prose whitespace-pre-wrap text-sm text-muted">{project.objective}</p> : null}

      <p className="mt-4 text-sm tabular-nums">
        {project.delivered} of {project.deliverables} deliverable{project.deliverables === 1 ? '' : 's'} delivered
      </p>

      <section className="mt-6 space-y-4">
        {project.items.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">
            Nothing has been delivered yet. You will be notified here as soon as a file is ready.
          </p>
        ) : project.items.map((item) => {
          const [current, ...earlier] = item.files;
          return (
            <article key={item.id} className="rounded-lg border border-border bg-surface p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold">{item.name}</h2>
                <span className={`text-xs ${current.canDecide ? 'font-medium text-accent' : 'text-muted'}`}>
                  {decisionLabel(current.decision, current.status)}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                <a href={current.downloadUrl} className="font-medium hover:underline">{current.filename}</a>
                <span className="text-xs text-muted">
                  version {current.versionNo} · {formatBytes(current.sizeBytes)} · delivered {formatDateTime(current.deliveredAt)}
                </span>
                <FilePreview url={current.downloadUrl} filename={current.filename} mimeType={current.mimeType} />
              </div>
              {current.feedback && current.decision === 'changes_requested' ? (
                <p className="mt-2 rounded-md bg-background px-3 py-2 text-sm text-muted">Your notes: {current.feedback}</p>
              ) : null}
              {current.canDecide ? <DecisionForm deliveryId={current.deliveryId} /> : null}
              {project.monthClosed && current.status === 'delivered' && !current.decision ? (
                <p className="mt-2 text-xs text-muted">This month is closed. Contact your account manager about this file.</p>
              ) : null}
              {earlier.length > 0 ? (
                <details className="mt-3 text-xs">
                  <summary className="cursor-pointer text-muted">Earlier versions ({earlier.length})</summary>
                  <ul className="mt-1 space-y-0.5">
                    {earlier.map((f) => (
                      <li key={f.deliveryId} className="text-muted">
                        v{f.versionNo} <a href={f.downloadUrl} className="hover:underline">{f.filename}</a>
                        {' '}· {formatDateTime(f.deliveredAt)} · {decisionLabel(f.decision, f.status).toLowerCase()}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </article>
          );
        })}
      </section>
    </PortalShell>
  );
}
