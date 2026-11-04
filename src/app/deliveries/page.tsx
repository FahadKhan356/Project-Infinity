import Link from 'next/link';
import { FileLink } from '@/components/files/file-link';
import { FilePreview } from '@/components/files/file-preview';
import { requireActor } from '@/lib/auth/dal';
import { AccessDenied } from '@/components/access-denied';
import { AppShell } from '@/components/app-shell';
import { can } from '@/lib/authz';
import { DELIVERY_TRANSITIONS, deliveryQueue } from '@/lib/delivery/deliveries';
import { formatBytes, formatDateTime, statusLabel } from '@/lib/workspace/format';
import { DeliveryForm } from './delivery-form';

/**
 * Sales → Deliveries (brief §14). Everything that has cleared QA, with the
 * file, the version, who approved it and what the client said. The portal
 * records that a person delivered the file; it does not send it (§14, v1).
 * The Project Manager reads the same list (§5, §23); only Sales marks it.
 */
export default async function DeliveriesPage(props: PageProps<'/deliveries'>) {
  const actor = await requireActor();
  const canDownload = can(actor, 'files.download');
  if (!can(actor, 'delivery.view')) {
    return (
      <AppShell actor={actor}>
        <AccessDenied what="client deliveries" />
      </AppShell>
    );
  }

  const params = await props.searchParams;
  const includeCompleted = params.all === '1';
  const rows = await deliveryQueue(actor, { includeCompleted });

  return (
    <AppShell actor={actor}>
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-surface px-5 py-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-foreground">Deliveries</h1>
          <p className="mt-1 max-w-prose text-xs text-muted">
            Approved deliverables waiting to go to the client, and what came back.
            {can(actor, 'delivery.manage') ? '' : ' Sales records each delivery; you see the list read-only.'}
          </p>
        </div>
        <Link
          href={includeCompleted ? '/deliveries' : '/deliveries?all=1'}
          className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-accent/40 hover:text-accent"
        >
          {includeCompleted ? 'Hide completed' : 'Show completed'}
        </Link>
      </div>

      {rows.length === 0 ? (
        <p className="mt-6 rounded-xl border border-border bg-surface px-5 py-8 text-sm text-muted">
          Nothing to deliver yet. Files appear here once they pass QA.
        </p>
      ) : (
        <ol className="mt-6 space-y-5">
          {rows.map((d) => (
            <li key={d.deliveryId} className="overflow-hidden rounded-xl border border-border bg-surface shadow-2xs">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background/40 px-5 py-3.5">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[15px] font-semibold text-foreground">{d.deliverableName}</span>
                    <span className="rounded-md border border-border bg-surface px-2 py-0.5 text-xs font-medium text-muted">
                      {d.department}
                    </span>
                    <span className="rounded-md border border-accent/25 bg-accent/10 px-2 py-0.5 font-mono text-xs font-semibold text-accent">
                      {d.projectCode}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <Link href={`/projects/${d.projectId}#workspace`} className="font-medium text-foreground/85 hover:text-accent hover:underline">
                      {d.projectTitle}
                    </Link>
                    <span>·</span>
                    <span>Client: <strong className="font-medium text-foreground/80">{d.clientName}</strong></span>
                  </div>
                </div>
                <span
                  className={`rounded-md border px-2.5 py-1 text-xs font-semibold ${
                    d.status === 'pending_delivery'
                      ? 'border-accent/40 bg-accent/10 text-accent'
                      : d.status === 'revision_required'
                        ? 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400'
                        : 'border-emerald-500/35 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  }`}
                >
                  {statusLabel(d.status)}
                </span>
              </div>

              <div className="grid gap-5 p-5 lg:grid-cols-[1fr_1.15fr_19rem]">
                {/* File Column */}
                <div className="rounded-lg border border-border/70 bg-background/35 p-4 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted">File</span>
                    <span className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted">
                      v{d.versionNo} · {formatBytes(d.sizeBytes)}
                    </span>
                  </div>
                  <FileLink
                    href={d.downloadUrl}
                    filename={d.originalFilename}
                    canDownload={canDownload}
                    className="mt-2 inline-block font-semibold text-foreground hover:text-accent hover:underline"
                  />
                  <div className="mt-2">
                    <FilePreview url={d.downloadUrl} filename={d.originalFilename} />
                  </div>
                </div>

                {/* QA Column */}
                <div className="rounded-lg border border-border/70 bg-background/35 p-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted">QA History</span>
                    <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                      Approved · {formatDateTime(d.approvedAt)}
                    </span>
                  </div>
                  {d.qaApprovals.length > 0 ? (
                    <ul className="mt-3 space-y-2.5">
                      {d.qaApprovals.map((a, i) => (
                        <li
                          key={`${i}-${a.stage}`}
                          className="rounded-lg border border-border/70 bg-surface px-3 py-2 text-xs"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-1.5">
                            <span className="font-semibold text-foreground">
                              {a.reviewer}{' '}
                              <span className="ml-1 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-accent">
                                {a.stage === 'team_lead' ? 'Team Lead' : 'Project Manager'}
                              </span>
                            </span>
                            <span className="tabular-nums text-[11px] text-sky-600 dark:text-sky-400">
                              {formatDateTime(a.at)}
                            </span>
                          </div>
                          {a.comments ? (
                            <p className="mt-1.5 whitespace-pre-wrap text-muted">{a.comments}</p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {d.deliveredAt ? (
                    <div className="mt-3 text-xs text-muted">
                      Delivered <span className="font-medium text-foreground">{formatDateTime(d.deliveredAt)}</span>
                      {d.deliveredBy ? ` by ${d.deliveredBy}` : ''}
                    </div>
                  ) : null}
                  {d.clientDecision ? (
                    <p className="mt-2.5 text-xs font-semibold text-foreground">
                      {d.clientDecision.decision === 'approved' ? 'Approved' : 'Changes requested'} in the portal by{' '}
                      {d.clientDecision.by}, {formatDateTime(d.clientDecision.at)}
                    </p>
                  ) : null}
                  {d.clientFeedback ? (
                    <p className="mt-2 whitespace-pre-wrap rounded-md border border-border bg-surface p-2.5 text-xs">
                      <span className="font-semibold text-muted">Client: </span>
                      {d.clientFeedback}
                    </p>
                  ) : null}
                  {d.canRevise && (d.status === 'delivered' || d.status === 'client_feedback_received') ? (
                    <Link
                      href={`/projects/${d.projectId}/revisions/new?deliverable=${d.deliverableId}`}
                      className="mt-3 inline-block text-xs font-semibold text-accent hover:underline"
                    >
                      Open a revision on this file →
                    </Link>
                  ) : null}
                </div>

                {/* Delivery Action Form Column */}
                <div className="rounded-lg border border-border/70 bg-background/35 p-4">
                  {d.canUpdate ? (
                    <DeliveryForm
                      deliveryId={d.deliveryId}
                      status={d.status}
                      next={[...DELIVERY_TRANSITIONS[d.status]]}
                      notes={d.notes}
                      clientFeedback={d.clientFeedback}
                    />
                  ) : (
                    <div className="text-xs">
                      {d.notes ? (
                        <p className="whitespace-pre-wrap">
                          <span className="font-semibold text-muted">Notes: </span>
                          {d.notes}
                        </p>
                      ) : null}
                      <p className={`text-muted ${d.notes ? 'mt-2' : ''}`}>
                        Read-only. The project’s Sales rep records delivery.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </AppShell>
  );
}
