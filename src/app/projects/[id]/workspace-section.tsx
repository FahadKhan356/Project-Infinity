import Link from 'next/link';
import type { Actor } from '@/lib/authz';
import { can } from '@/lib/authz';
import { formatBytes, formatDateTime, statusLabel } from '@/lib/workspace/format';
import type { Workspace, WorkspaceDeliverable, WorkspaceTeam } from '@/lib/workspace/workspace';
import { CommentForm } from './comment-form';
import { UploadButton } from './upload-button';

/**
 * The shared workspace on the project page (brief §9, §10): every team, who
 * is doing what, each slot with its versions, and the thread. The same
 * component serves every role — what differs is which upload buttons appear.
 */
export function WorkspaceSection({ actor, workspace }: { actor: Actor; workspace: Workspace }) {
  const readOnly = workspace.monthClosed;
  const mayPlan = (team: WorkspaceTeam) =>
    !readOnly && (team.teamLeadId === actor.id || can(actor, 'planning.viewAllDepartments'));

  const allSlots = workspace.teams.flatMap((t) =>
    t.deliverables.map((d) => ({ id: d.id, label: `${t.department} — ${d.name}` })),
  );

  return (
    <>
      <section id="workspace" className="mt-8 scroll-mt-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Workspace</h2>
            <p className="mt-1 max-w-prose text-xs text-muted">
              Everyone assigned to this project sees the same workspace. Files stay attached to
              their slot as numbered versions; a new upload never replaces an old one.
            </p>
          </div>
          {!readOnly && can(actor, 'revisions.create') && allSlots.length > 0 ? (
            <Link href={`/projects/${workspace.projectId}/revisions/new`}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-background">
              Open a revision
            </Link>
          ) : null}
        </div>

        {workspace.revisions.length > 0 ? (
          <ul className="mt-3 space-y-1.5">
            {workspace.revisions.map((r) => (
              <li key={r.id} className={`flex flex-wrap items-baseline gap-x-3 rounded-md border px-3 py-2 text-xs ${
                r.status === 'closed' || r.status === 'cancelled' ? 'border-border text-muted' : 'border-accent/40 bg-accent/5'}`}>
                <Link href={`/revisions/${r.id}`} className="font-medium hover:underline">
                  Revision #{String(r.revisionNo).padStart(2, '0')} — {r.title}
                </Link>
                <span>{r.deliverableNames.join(', ')}</span>
                <span className="ml-auto">{statusLabel(r.status)}{r.deadline ? ` · due ${r.deadline}` : ''}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {workspace.teams.length === 0 ? (
          <p className="mt-3 rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">
            No teams on this project yet.
          </p>
        ) : (
          workspace.teams.map((team) => (
            <TeamBlock key={team.projectDepartmentId} team={team} canPlan={mayPlan(team)} />
          ))
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Comments</h2>
        {workspace.comments.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Nothing said yet.</p>
        ) : (
          <ol className="mt-3 space-y-3">
            {workspace.comments.map((c) => (
              <li key={c.id} className="rounded-lg border border-border bg-surface px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
                  <span className="font-medium text-foreground">{c.author}</span>
                  <span>{formatDateTime(c.createdAt)}</span>
                  {c.deliverableName ? <span>· on {c.deliverableName}</span> : null}
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm">{c.body}</p>
              </li>
            ))}
          </ol>
        )}
        {readOnly ? (
          <p className="mt-3 text-xs text-muted">The thread is closed with the month.</p>
        ) : (
          <CommentForm projectId={workspace.projectId} deliverables={allSlots} />
        )}
      </section>
    </>
  );
}

function TeamBlock({ team, canPlan }: { team: WorkspaceTeam; canPlan: boolean }) {
  const approved = team.deliverables.filter((d) => d.status === 'approved' || d.status === 'delivered').length;

  return (
    <div className="mt-4 rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold">{team.department}</h3>
          <p className="text-xs text-muted">
            Lead: {team.teamLead ?? 'not assigned'}
            {team.members.length > 0
              ? ` · Working: ${team.members.map((m) => m.name).join(', ')}`
              : ' · Nobody assigned yet'}
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted">
          <span className="tabular-nums">{approved}/{team.deliverables.length} approved</span>
          {canPlan ? (
            <Link href={`/planning/${team.projectDepartmentId}`} className="hover:underline">
              Plan this team →
            </Link>
          ) : null}
        </div>
      </div>

      {team.assignments.length > 0 ? (
        <ul className="divide-y divide-border border-b border-border">
          {team.assignments.map((a) => (
            <li key={a.id} className="px-4 py-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="font-medium">{a.title}</span>
                  <span className="text-muted"> — {a.assignee}</span>
                  {a.isMine ? (
                    <span className="ml-2 rounded bg-accent/10 px-1.5 py-0.5 text-xs text-accent">you</span>
                  ) : null}
                </div>
                <div className="text-xs text-muted">
                  {a.startDate ?? '—'} → {a.endDate ?? '—'} · {a.priority} · {statusLabel(a.status)}
                  {' · '}<span className="tabular-nums">{a.approved}/{a.total}</span>
                </div>
              </div>
              {a.instructions ? (
                <p className="mt-1 whitespace-pre-wrap text-xs text-muted">{a.instructions}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {team.deliverables.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted">No deliverable slots opened yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Slot</th>
              <th className="px-4 py-2 font-medium">Assigned to</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Current file</th>
              <th className="px-4 py-2 font-medium">Due</th>
              <th className="px-4 py-2 text-right font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {team.deliverables.map((d) => <SlotRow key={d.id} slot={d} />)}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SlotRow({ slot }: { slot: WorkspaceDeliverable }) {
  const current = slot.currentVersion;
  const nextVersion = (current?.versionNo ?? 0) + 1;

  return (
    <tr className="border-t border-border align-top">
      <td className="px-4 py-2.5">
        <div className="font-medium">{slot.name}</div>
        {slot.description ? <div className="text-xs text-muted">{slot.description}</div> : null}
      </td>
      <td className="px-4 py-2.5 text-muted">{slot.assignee ?? 'unassigned'}</td>
      <td className="px-4 py-2.5">
        <span className={slot.status === 'changes_requested' ? 'text-red-600 dark:text-red-400' : ''}>
          {statusLabel(slot.status)}
        </span>
        {slot.openRevision ? (
          <div className="mt-1 max-w-xs rounded-md border border-accent/40 bg-accent/5 px-2 py-1 text-xs">
            <Link href={`/revisions/${slot.openRevision.id}`} className="font-medium hover:underline">
              Revision #{String(slot.openRevision.revisionNo).padStart(2, '0')}
            </Link>
            {slot.openRevision.deadline ? <span className="text-muted"> · due {slot.openRevision.deadline}</span> : null}
            <p className="mt-0.5 whitespace-pre-wrap text-muted">{slot.openRevision.clientFeedback}</p>
          </div>
        ) : null}
        {slot.lastReview && !(slot.openRevision && slot.status === 'changes_requested' && slot.lastReview.decision === 'approved') ? (
          <div className="mt-1 max-w-xs text-xs text-muted">
            <span className="font-medium text-foreground">{slot.lastReview.reviewer}</span>
            {' '}
            {slot.lastReview.decision === 'approved' ? 'approved'
              : slot.lastReview.decision === 'rejected' ? 'rejected'
              : 'requested changes on'}
            {' '}v{slot.lastReview.versionNo}
            {slot.lastReview.comments ? <>: <span className="whitespace-pre-wrap">{slot.lastReview.comments}</span></> : null}
          </div>
        ) : null}
      </td>
      <td className="px-4 py-2.5">
        {current ? (
          <>
            <a href={current.downloadUrl} className="hover:underline">
              {current.originalFilename}
            </a>
            <div className="text-xs text-muted">
              v{current.versionNo} · {formatBytes(current.sizeBytes)} · {current.uploadedBy},{' '}
              {formatDateTime(current.uploadedAt)}
            </div>
            {slot.versions.length > 1 ? (
              <details className="mt-1 text-xs">
                <summary className="cursor-pointer text-muted">
                  {slot.versions.length - 1} earlier version{slot.versions.length > 2 ? 's' : ''}
                </summary>
                <ul className="mt-1 space-y-0.5">
                  {slot.versions.filter((v) => v.id !== current.id).map((v) => (
                    <li key={v.id} className="text-muted">
                      v{v.versionNo}{' '}
                      {v.isDeleted ? (
                        <span className="line-through">{v.originalFilename}</span>
                      ) : (
                        <a href={v.downloadUrl} className="hover:underline">{v.originalFilename}</a>
                      )}
                      {' '}· {v.uploadedBy}, {formatDateTime(v.uploadedAt)}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        ) : (
          <span className="text-muted">nothing uploaded</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-muted">{slot.dueDate ?? '—'}</td>
      <td className="px-4 py-2.5 text-right">
        {slot.canUpload ? <UploadButton deliverableId={slot.id} nextVersion={nextVersion} /> : null}
      </td>
    </tr>
  );
}
