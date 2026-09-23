import Link from 'next/link';
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
 */
export default async function DeliveriesPage(props: PageProps<'/deliveries'>) {
  const actor = await requireActor();
  if (!can(actor, 'delivery.manage')) {
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
                  <a href={d.downloadUrl} className="mt-1 inline-block font-medium hover:underline">{d.originalFilename}</a>
                  <div className="text-xs text-muted">v{d.versionNo} · {formatBytes(d.sizeBytes)}</div>
                </div>
                <div className="text-sm">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted">QA</div>
                  <div className="mt-1 text-xs text-muted">approved {formatDateTime(d.approvedAt)}</div>
                  {d.qaComments ? <p className="mt-1 whitespace-pre-wrap text-xs">{d.qaComments}</p> : null}
                  {d.deliveredAt ? (
                    <div className="mt-2 text-xs text-muted">
                      delivered {formatDateTime(d.deliveredAt)}{d.deliveredBy ? ` by ${d.deliveredBy}` : ''}
                    </div>
                  ) : null}
                  {d.clientFeedback ? (
                    <p className="mt-2 whitespace-pre-wrap text-xs"><span className="text-muted">Client: </span>{d.clientFeedback}</p>
                  ) : null}
                </div>
                <DeliveryForm
                  deliveryId={d.deliveryId}
                  next={[...DELIVERY_TRANSITIONS[d.status]]}
                  notes={d.notes}
                  clientFeedback={d.clientFeedback}
                />
              </div>
            </li>
          ))}
        </ol>
      )}
    </AppShell>
  );
}
