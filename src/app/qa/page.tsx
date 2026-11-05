import Link from 'next/link';
import { FileLink } from '@/components/files/file-link';
import { FilePreview } from '@/components/files/file-preview';
import { requireActor } from '@/lib/auth/dal';
import { AccessDenied } from '@/components/access-denied';
import { AppShell } from '@/components/app-shell';
import { can } from '@/lib/authz';
import { qaQueue } from '@/lib/qa/queue';
import { formatBytes, formatDateTime } from '@/lib/workspace/format';
import { ReviewForm } from './review-form';

function getPriorityBadgeClass(priority: string): string {
  const p = priority.toLowerCase();
  if (p === 'urgent') return 'border-rose-500/30 bg-rose-500/10 text-rose-400 font-bold';
  if (p === 'high') return 'border-amber-500/30 bg-amber-500/10 text-amber-400 font-semibold';
  if (p === 'low') return 'border-border/60 bg-background/60 text-muted';
  return 'border-border/80 bg-background/80 text-foreground font-medium';
}

/**
 * The QA panel (brief §12, §13). A Team Lead sees their teams' uploads; the
 * Project Manager sees what has passed a lead and needs the second signature.
 */
export default async function QaPage() {
  const actor = await requireActor();
  const reviewsAsPm = can(actor, 'qa.reviewAsProjectManager');
  const canDownload = can(actor, 'files.download');
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
      {/* Page Header */}
      <div className="flex flex-col gap-2 border-b border-border/70 pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">Quality Assurance (QA)</h1>
            <span className="rounded-full border border-accent/25 bg-accent/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-accent">
              {reviewsAsPm ? 'PM Review Queue' : 'Team Lead Review Queue'}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted sm:text-sm">
            {reviewsAsPm
              ? 'Deliverables that have passed their Team Lead and need your sign-off before Sales can deliver them.'
              : 'Deliverables uploaded by your team members. Approve to pass them on, or request revisions with feedback.'}
          </p>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-border/80 bg-background/80 px-3 py-1 text-xs font-medium text-muted">
            <span className="h-2 w-2 rounded-full bg-amber-500" />
            <span>{queue.length} pending review{queue.length === 1 ? '' : 's'}</span>
          </span>
        </div>
      </div>

      {queue.length === 0 ? (
        <div className="mt-6 rounded-xl border border-border/80 bg-surface/90 px-6 py-8 text-center text-sm text-muted">
          Nothing waiting for your review. When team members upload files to deliverable slots, they will appear here.
        </div>
      ) : (
        <ol className="mt-6 space-y-6">
          {queue.map((item) => (
            <li
              key={item.deliverableId}
              className="overflow-hidden rounded-xl border border-border/80 bg-surface/90 shadow-xs backdrop-blur-xs"
            >
              {/* Deliverable Header Card */}
              <div className="border-b border-border/70 bg-background/35 px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-bold text-foreground">{item.deliverableName}</h3>
                      <span className="rounded-md border border-accent/25 bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">
                        {item.department}
                      </span>
                      <span className="text-xs text-muted">
                        assigned to <span className="font-semibold text-foreground">{item.assignee ?? 'unassigned'}</span>
                      </span>
                    </div>

                    {/* Project & Client Context */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                      <Link href={`/projects/${item.projectId}#workspace`} className="font-medium text-foreground hover:text-accent hover:underline">
                        {item.projectTitle}
                      </Link>
                      <span>·</span>
                      <span className="rounded border border-border/80 bg-background/80 px-1.5 py-0.2 font-mono text-[11px]">
                        {item.projectCode}
                      </span>
                      <span>·</span>
                      <span>{item.clientName}</span>
                      {item.dueDate ? (
                        <>
                          <span>·</span>
                          <span className="font-medium text-foreground">due {item.dueDate}</span>
                        </>
                      ) : null}
                    </div>

                    {item.description ? (
                      <div className="mt-2 rounded-md border border-border/60 bg-background/40 px-3 py-1.5 text-xs text-muted">
                        {item.description}
                      </div>
                    ) : null}
                  </div>

                  {/* Status & Priority Badges */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full border border-border/80 bg-background/80 px-2.5 py-0.5 text-xs font-medium text-foreground">
                      {item.stage === 'project_manager' ? 'PM review' : 'Team Lead review'}
                    </span>
                    <span className={`rounded-full border px-2.5 py-0.5 text-xs capitalize ${getPriorityBadgeClass(item.priority)}`}>
                      {item.priority}
                    </span>
                    {item.previousRounds > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-2.5 py-0.5 text-xs font-semibold text-rose-400">
                        <span aria-hidden="true">↺</span>
                        <span>sent back {item.previousRounds}× before</span>
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* Review Workspace Grid */}
              <div className="grid gap-5 p-5 lg:grid-cols-2">
                {/* Left Card: File To Review */}
                <div className="flex flex-col justify-between rounded-xl border border-border/70 bg-background/40 p-4">
                  <div>
                    <div className="flex items-center justify-between border-b border-border/60 pb-2.5">
                      <div className="flex items-center gap-2">
                        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/10 text-accent">
                          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5" aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 6A1.5 1.5 0 015 4.5h7A1.5 1.5 0 0113.5 6v8a1.5 1.5 0 01-1.5 1.5H5A1.5 1.5 0 013.5 14V6z" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 8.5l3.5-2v7l-3.5-2" />
                          </svg>
                        </span>
                        <span className="text-xs font-semibold uppercase tracking-wider text-muted">File to review</span>
                      </div>
                      <span className="rounded border border-border/80 bg-background/90 px-1.5 py-0.2 font-mono text-xs font-semibold text-accent">
                        v{item.versionNo}
                      </span>
                    </div>

                    <div className="mt-3">
                      <FileLink
                        href={item.downloadUrl}
                        filename={item.originalFilename}
                        canDownload={canDownload}
                        className="text-sm font-semibold text-foreground hover:text-accent hover:underline"
                      />
                      <div className="mt-1 flex items-center gap-2 text-xs text-muted flex-wrap">
                        <span>{formatBytes(item.sizeBytes)}</span>
                        <span>·</span>
                        <span>Uploaded by <strong className="font-medium text-foreground">{item.uploadedBy}</strong></span>
                        <span>·</span>
                        <span>{formatDateTime(item.uploadedAt)}</span>
                      </div>
                    </div>

                    <div className="mt-3">
                      <FilePreview url={item.downloadUrl} filename={item.originalFilename} />
                    </div>

                    {item.notes ? (
                      <div className="mt-3.5 rounded-lg border border-border/70 bg-surface/80 p-3">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-muted">Uploader’s note</div>
                        <p className="mt-1 whitespace-pre-wrap text-xs text-foreground/90 italic">
                          &ldquo;{item.notes}&rdquo;
                        </p>
                      </div>
                    ) : null}
                  </div>
                </div>

                {/* Right Card: QA Decision & Comments */}
                <div className="rounded-xl border border-border/70 bg-background/40 p-4">
                  <ReviewForm deliverableId={item.deliverableId} stage={item.stage} />
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </AppShell>
  );
}
