import Link from 'next/link';
import { requireActor } from '@/lib/auth/dal';
import { AccessDenied } from '@/components/access-denied';
import { AppShell } from '@/components/app-shell';
import { can } from '@/lib/authz';
import { qaQueue } from '@/lib/qa/queue';
import { formatBytes, formatDateTime } from '@/lib/workspace/format';
import { ReviewForm } from './review-form';

/**
 * The QA panel (brief §12, §13). A Team Lead sees their teams' uploads; the
 * Project Manager sees what has passed a lead and needs the second signature.
 */
export default async function QaPage() {
  const actor = await requireActor();
  const reviewsAsPm = can(actor, 'qa.reviewAsProjectManager');
  if (actor.leadDepartmentIds.length === 0 && !reviewsAsPm) {
    return (
      <AppShell actor={actor}>
        <AccessDenied what="QA review" />
      </AppShell>
    );
  }

  const queue = await qaQueue(actor);

  return (
    <AppShell actor={actor}>
      <h1 className="text-lg font-semibold tracking-tight">QA</h1>
      <p className="mt-1 max-w-prose text-sm text-muted">
        {reviewsAsPm
          ? 'Deliverables that have passed their Team Lead and need your sign-off before Sales can deliver them.'
          : 'Deliverables your team has uploaded. Approve to pass them on, or send them back with a note.'}
      </p>

      {queue.length === 0 ? (
        <p className="mt-6 rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">
          Nothing waiting for your review.
        </p>
      ) : (
        <ol className="mt-6 space-y-4">
          {queue.map((item) => (
            <li key={item.deliverableId} className="rounded-lg border border-border bg-surface">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-3">
                <div>
                  <div className="text-sm font-semibold">
                    {item.deliverableName}
                    <span className="ml-2 font-normal text-muted">· {item.department} · {item.assignee ?? 'unassigned'}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    <Link href={`/projects/${item.projectId}#workspace`} className="hover:underline">{item.projectTitle}</Link>
                    {' · '}<span className="font-mono">{item.projectCode}</span>
                    {' · '}{item.clientName}
                    {item.dueDate ? ` · due ${item.dueDate}` : ''}
                  </div>
                  {item.description ? <div className="mt-1 text-xs text-muted">{item.description}</div> : null}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-md border border-border px-2 py-0.5">
                    {item.stage === 'project_manager' ? 'PM review' : 'Team Lead review'}
                  </span>
                  <span className="rounded-md border border-border px-2 py-0.5 capitalize">{item.priority}</span>
                  {item.previousRounds > 0 ? (
                    <span className="rounded-md bg-red-500/10 px-2 py-0.5 text-red-600 dark:text-red-400">
                      sent back {item.previousRounds}× before
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="grid gap-5 px-5 py-4 lg:grid-cols-2">
                <div className="text-sm">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted">File to review</div>
                  <a href={item.downloadUrl} className="mt-1 inline-block font-medium hover:underline">
                    {item.originalFilename}
                  </a>
                  <div className="text-xs text-muted">
                    v{item.versionNo} · {formatBytes(item.sizeBytes)} · uploaded by {item.uploadedBy},{' '}
                    {formatDateTime(item.uploadedAt)}
                  </div>
                  {item.notes ? (
                    <p className="mt-2 whitespace-pre-wrap text-xs text-muted">Uploader’s note: {item.notes}</p>
                  ) : null}
                </div>
                <ReviewForm deliverableId={item.deliverableId} stage={item.stage} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </AppShell>
  );
}
