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
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Deliveries</h1>
          <p className="mt-1 max-w-prose text-sm text-muted">
            Approved deliverables waiting to go to the client, and what came back.
            {can(actor, 'delivery.manage') ? '' : ' Sales records each delivery; you see the list read-only.'}
          </p>
        </div>
        <Link href={includeCompleted ? '/deliveries' : '/deliveries?all=1'} className="text-sm text-muted hover:underline">
          {includeCompleted ? 'Hide completed' : 'Show completed'}
        </Link>
      </div>

      {rows.length === 0 ? (
        <p className="mt-6 rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">
          Nothing to deliver yet. Files appear here once they pass QA.
        </p>
      ) : (
        <ol className="mt-6 space-y-4">
          {rows.map((d) => (
            <li key={d.deliveryId} className="rounded-lg border border-border bg-surface">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-3">
                <div>
                  <div className="text-sm font-semibold">
                    {d.deliverableName}
                    <span className="ml-2 font-normal text-muted">· {d.department}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    <Link href={`/projects/${d.projectId}#workspace`} className="hover:underline">{d.projectTitle}</Link>
                    {' · '}<span className="font-mono">{d.projectCode}</span>
                    {' · '}{d.clientName}
                  </div>
                </div>
                <span className={`rounded-md border px-2 py-0.5 text-xs ${
                  d.status === 'pending_delivery' ? 'border-accent/40 bg-accent/5'
                  : d.status === 'revision_required' ? 'border-red-500/40 text-red-600 dark:text-red-400'
                  : 'border-border'}`}>
                  {statusLabel(d.status)}
                </span>
              </div>

              <div className="grid gap-5 px-5 py-4 lg:grid-cols-[1fr_1fr_18rem]">
                <div className="text-sm">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted">File</div>
                  <FileLink href={d.downloadUrl} filename={d.originalFilename} canDownload={canDownload}
                    className="mt-1 inline-block font-medium hover:underline" />
                  <div className="text-xs text-muted">v{d.versionNo} · {formatBytes(d.sizeBytes)}</div>
                  <FilePreview url={d.downloadUrl} filename={d.originalFilename} />
                </div>
                <div className="text-sm">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted">QA</div>
                  <div className="mt-1 text-xs text-muted">approved {formatDateTime(d.approvedAt)}</div>
                  {d.qaApprovals.length > 0 ? (
                    <ul className="mt-1 space-y-1">
                      {d.qaApprovals.map((a, i) => (
                        <li key={`${i}-${a.stage}`} className="text-xs">
                          <span className="text-muted">
                            {a.stage === 'team_lead' ? 'Team Lead' : 'Project Manager'} · {a.reviewer} · {formatDateTime(a.at)}
                          </span>
                          {a.comments ? <p className="whitespace-pre-wrap">{a.comments}</p> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {d.deliveredAt ? (
                    <div className="mt-2 text-xs text-muted">
                      delivered {formatDateTime(d.deliveredAt)}{d.deliveredBy ? ` by ${d.deliveredBy}` : ''}
                    </div>
                  ) : null}
                  {d.clientDecision ? (
                    <p className="mt-2 text-xs font-medium">
                      {d.clientDecision.decision === 'approved' ? 'Approved' : 'Changes requested'} in the portal by{' '}
                      {d.clientDecision.by}, {formatDateTime(d.clientDecision.at)}
                    </p>
                  ) : null}
                  {d.clientFeedback ? (
                    <p className="mt-2 whitespace-pre-wrap text-xs"><span className="text-muted">Client: </span>{d.clientFeedback}</p>
                  ) : null}
                  {d.canRevise && (d.status === 'delivered' || d.status === 'client_feedback_received') ? (
                    <Link href={`/projects/${d.projectId}/revisions/new?deliverable=${d.deliverableId}`}
                      className="mt-2 inline-block text-xs font-medium text-accent hover:underline">
                      Open a revision on this file →
                    </Link>
                  ) : null}
                </div>
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
                      <p className="whitespace-pre-wrap"><span className="text-muted">Notes: </span>{d.notes}</p>
                    ) : null}
                    <p className={`text-muted ${d.notes ? 'mt-2' : ''}`}>
                      Read-only. The project’s Sales rep records delivery.
                    </p>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </AppShell>
  );
}
