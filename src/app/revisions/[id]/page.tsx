import Link from 'next/link';
import { FileLink } from '@/components/files/file-link';
import { FilePreview } from '@/components/files/file-preview';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { can } from '@/lib/authz';
import { isProjectVisible } from '@/lib/authz/queries';
import { loadRevision } from '@/lib/revisions/queries';
import { listProjectAttachments } from '@/lib/files/attachments';
import { isProjectMonthClosed } from '@/lib/months/lifecycle';
import { mayAttachToProject } from '@/lib/files/access';
import { reworkBlockedReason } from '@/lib/revisions/revisions';
import { AttachButton } from '@/components/files/attach-button';
import { AttachmentList } from '@/components/files/attachment-list';
import { formatDateTime, statusLabel } from '@/lib/workspace/format';
import { EndRevisionForm, HandOffForm, RevisionCommentForm } from './revision-panels';

/**
 * One revision (brief §15–17): the client's words, the slots it touches and
 * where each stands, who is reworking it, the versions that answer it, and
 * the conversation. What a person can do here depends on their role — the
 * lead hands it out, Sales or the PM close it.
 */
export default async function RevisionPage(props: PageProps<'/revisions/[id]'>) {
  const actor = await requireActor();
  const { id } = await props.params;
  const revisionId = Number(id);
  if (!Number.isInteger(revisionId)) notFound();

  const revision = await loadRevision(actor, revisionId);
  if (!revision) notFound();

  const isOpen = revision.status !== 'closed' && revision.status !== 'cancelled';
  const [allAttachments, monthClosed, owned] = await Promise.all([
    listProjectAttachments(actor, revision.projectId),
    isProjectMonthClosed(getDb(), revision.projectId),
    // Theirs to work on, as opposed to a project shared with them to read
    // (§23): the page opens either way, the controls only on the first.
    isProjectVisible(getDb(), actor, revision.projectId),
  ]);
  const references = allAttachments.filter((a) => a.parent.kind === 'revision' && a.parent.id === revision.id);
  // Ending a revision changes slots, deliveries and the project; an archived
  // month offers no such button, and the server refuses the call anyway.
  const mayClose = owned && isOpen && !monthClosed && (can(actor, 'revisions.create') || can(actor, 'projects.triage'));
  // The buttons follow the server's two rules (§18), so the page offers
  // each exactly where the call would go through: a hand-off is refused on
  // a held or cancelled project (assignRevision) — a completed one still
  // takes rework — and a reference file on a completed one as well
  // (canAttachToProject).
  const noHandOff = reworkBlockedReason(revision.projectStatus);
  const takesWork = owned && isOpen && !monthClosed && noHandOff === null;
  const mayAttach = isOpen && mayAttachToProject({ owned, monthOpen: !monthClosed, status: revision.projectStatus });
  const mayDelete = owned && !monthClosed && can(actor, 'files.delete');
  const canDownload = can(actor, 'files.download');
  const planAll = can(actor, 'planning.viewAllDepartments');

  // Members of each team the actor may hand work out on, for the pickers.
  const assignableDepartments = [...new Set(
    revision.deliverables
      .filter((d) => planAll || actor.leadDepartmentIds.includes(d.departmentId))
      .map((d) => d.departmentId),
  )];
  const membersByDepartment = new Map<number, { id: number; name: string }[]>();
  if (takesWork && can(actor, 'assignments.create') && assignableDepartments.length > 0) {
    const rows = await getDb().execute<{ department_id: number; id: number; name: string }>(sql`
      SELECT dm.department_id, u.id, u.full_name AS name
      FROM department_members dm JOIN users u ON u.id = dm.user_id AND u.is_active
      WHERE dm.department_id IN (${sql.join(assignableDepartments.map((d) => sql`${d}`), sql`, `)})
      ORDER BY u.full_name
    `);
    for (const r of rows) {
      const list = membersByDepartment.get(Number(r.department_id)) ?? [];
      list.push({ id: Number(r.id), name: r.name });
      membersByDepartment.set(Number(r.department_id), list);
    }
  }

  return (
    <AppShell actor={actor}>
      <Link href="/revisions" className="text-sm text-muted hover:text-foreground">← Revisions</Link>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Revision #{String(revision.revisionNo).padStart(2, '0')} — {revision.title}
          </h1>
          <p className="mt-1 text-sm text-muted">
            <Link href={`/projects/${revision.projectId}#workspace`} className="hover:underline">{revision.projectTitle}</Link>
            {' · '}<span className="font-mono">{revision.projectCode}</span>
            {' · '}{revision.clientName}
            {' · '}opened by {revision.createdBy}, {formatDateTime(revision.createdAt)}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="rounded-md border border-border px-2.5 py-1 capitalize">{revision.priority} priority</span>
          <span className={`rounded-md border px-2.5 py-1 ${isOpen ? 'border-accent/40 bg-accent/5' : 'border-border text-muted'}`}>
            {statusLabel(revision.status)}
          </span>
        </div>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Deadline" value={revision.deadline ?? '—'} />
        <Stat label="Deliverables" value={String(revision.deliverables.length)} />
        <Stat label={revision.closedAt ? 'Closed' : 'Versions uploaded'}
          value={revision.closedAt ? formatDateTime(revision.closedAt) : String(revision.versions.length)} />
      </div>

      <section className="mt-6 rounded-lg border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold">Client feedback</h2>
        <p className="mt-2 whitespace-pre-wrap text-sm">{revision.clientFeedback}</p>
        {revision.details ? (
          <>
            <h3 className="mt-4 text-sm font-semibold">Details</h3>
            <p className="mt-1.5 whitespace-pre-wrap text-sm text-muted">{revision.details}</p>
          </>
        ) : null}
        {references.length > 0 || mayAttach ? (
          <>
            <h3 className="mt-4 text-sm font-semibold">Reference files</h3>
            <div className="mt-1.5 flex flex-col items-start gap-2">
              <AttachmentList items={references} canDelete={mayDelete} canDownload={canDownload} />
              {mayAttach ? (
                <AttachButton projectId={revision.projectId} revisionId={revision.id} label="Attach reference files" />
              ) : null}
            </div>
          </>
        ) : null}
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Deliverables to rework</h2>
        <div className="mt-3 overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Slot</th>
                <th className="px-4 py-2.5 font-medium">Team</th>
                <th className="px-4 py-2.5 font-medium">Working on it</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Version</th>
                <th className="px-4 py-2.5 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {revision.deliverables.map((d) => {
                const members = membersByDepartment.get(d.departmentId);
                return (
                  <tr key={d.id} className="border-b border-border align-top last:border-0">
                    <td className="px-4 py-2.5 font-medium">{d.name}</td>
                    <td className="px-4 py-2.5 text-muted">{d.department}</td>
                    <td className="px-4 py-2.5 text-muted">{d.assignee ?? 'unassigned'}</td>
                    <td className="px-4 py-2.5">{statusLabel(d.status)}</td>
                    <td className="px-4 py-2.5 text-muted">{d.currentVersionNo === null ? '—' : `v${d.currentVersionNo}`}</td>
                    <td className="min-w-[18rem] px-4 py-2.5">
                      {members && members.length > 0 ? (
                        <HandOffForm revisionId={revision.id} deliverableId={d.id}
                          members={members} currentAssigneeId={d.assigneeId} />
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {isOpen && noHandOff ? (
          <p className="mt-2 text-xs text-muted">{noHandOff}</p>
        ) : null}
        <p className="mt-2 text-xs text-muted">
          Executives upload the reworked file on the project workspace; it becomes the next version of the same slot and goes through QA as usual.
        </p>
      </section>

      {revision.versions.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-sm font-semibold">Versions uploaded for this revision</h2>
          <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-surface text-sm">
            {revision.versions.map((v) => (
              <li key={v.id} className="px-4 py-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>
                    <span className="font-medium">{v.deliverableName}</span> v{v.versionNo} ·{' '}
                    <FileLink href={v.downloadUrl} filename={v.originalFilename} canDownload={canDownload} />
                    {v.isCurrent ? null : <span className="ml-2 text-xs text-muted">superseded</span>}
                  </span>
                  <span className="text-xs text-muted">{v.uploadedBy}, {formatDateTime(v.uploadedAt)}</span>
                </div>
                {/* What QA made of this version (§19): every round, in order. */}
                {v.reviews.length === 0 ? (
                  <p className="mt-1 text-xs text-muted">Awaiting QA</p>
                ) : (
                  <ul className="mt-1 space-y-0.5 border-l border-border pl-2 text-xs text-muted">
                    {v.reviews.map((r, i) => (
                      <li key={i} className="whitespace-pre-wrap">
                        <span className="font-medium text-foreground">{r.reviewer}</span>
                        {' '}
                        {r.decision === 'approved' ? 'approved' : r.decision === 'rejected' ? 'rejected' : 'requested changes'}
                        {r.stage === 'project_manager' ? ' (PM QA)' : ''}, {formatDateTime(r.at)}
                        {r.comments ? <>: {r.comments}</> : null}
                      </li>
                    ))}
                  </ul>
                )}
                <FilePreview url={v.downloadUrl} filename={v.originalFilename} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {mayClose ? (
        <section className="mt-8 rounded-lg border border-border bg-surface p-5">
          <h2 className="text-sm font-semibold">Finish</h2>
          <p className="mt-1 mb-3 max-w-prose text-xs text-muted">
            Close it once the client has accepted the reworked files. Cancelling withdraws it. Either way,
            a slot whose rework has not cleared QA gets back its delivered state.
          </p>
          <EndRevisionForm revisionId={revision.id} />
        </section>
      ) : null}

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Comments</h2>
        {revision.comments.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Nothing said yet.</p>
        ) : (
          <ol className="mt-3 space-y-3">
            {revision.comments.map((c) => (
              <li key={c.id} className="rounded-lg border border-border bg-surface px-4 py-3">
                <div className="text-xs text-muted">
                  <span className="font-medium text-foreground">{c.author}</span> {formatDateTime(c.createdAt)}
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm">{c.body}</p>
              </li>
            ))}
          </ol>
        )}
        {owned ? (
          <RevisionCommentForm revisionId={revision.id} />
        ) : (
          <p className="mt-3 text-xs text-muted">This project is shared with you to view; the thread is read-only.</p>
        )}
      </section>
    </AppShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="text-sm font-medium">{value}</div>
      <div className="mt-0.5 text-xs text-muted">{label}</div>
    </div>
  );
}
