import Link from 'next/link';
import { formatMinutes } from '@/lib/time/format';
import { FileLink } from '@/components/files/file-link';
import { FilePreview } from '@/components/files/file-preview';
import type { Actor } from '@/lib/authz';
import { canPlanTeam } from '@/lib/authz';
import { formatBytes, formatDateTime, statusLabel } from '@/lib/workspace/format';
import type { Workspace, WorkspaceDeliverable, WorkspaceTeam, WorkspaceVersion } from '@/lib/workspace/workspace';
import type { ProjectAttachment } from '@/lib/files/attachments';
import { mayAttachToAssignment } from '@/lib/files/access';
import { AttachButton } from '@/components/files/attach-button';
import { AttachmentList } from '@/components/files/attachment-list';
import { DeleteFileButton } from '@/components/files/delete-file-button';
import { CommentForm, VersionCommentForm } from './comment-form';
import { UploadButton } from './upload-button';

/**
 * The shared workspace on the project page (brief §9, §10): every team, who
 * is doing what, each slot with its versions, and the thread. The same
 * component serves every role — what differs is which upload buttons appear.
 */
export function WorkspaceSection({
  actor, workspace, attachments, canAttach, canDelete: mayDelete, canDownload, canComment, canRevise,
}: {
  actor: Actor;
  workspace: Workspace;
  attachments: ProjectAttachment[];
  /**
   * False while the month is closed or the project is held, cancelled or
   * completed — and for a rep the project is only shared with (§23).
   */
  canAttach: boolean;
  /**
   * Holds files.delete on a project that is theirs to work on — not one
   * merely shared with them (§23), where DELETE /api/files refuses too.
   */
  canDelete: boolean;
  /**
   * Holds files.download (§43): file names link to the bytes. Without it
   * they are plain text — Preview and inline viewing stay.
   */
  canDownload: boolean;
  /** False for a rep the project is only shared with: they read the thread, they do not join it (§23). */
  canComment: boolean;
  /**
   * Whether this person may open a revision here (§15): the project's own
   * Sales rep, not a rep it is merely shared with (§23), who reads it only.
   */
  canRevise: boolean;
}) {
  const readOnly = workspace.monthClosed;
  const canDelete = !readOnly && mayDelete;
  // The version threads (§10, §19) take the same rule as the project thread below.
  const mayComment = !readOnly && canComment;
  const references = (assignmentId: number) =>
    attachments.filter((a) => a.parent.kind === 'assignment' && a.parent.id === assignmentId);
  // The same rule the planning page and createAssignment apply (§6, §7): a
  // co-lead of the department plans the team too, once it has a lead.
  const mayPlan = (team: WorkspaceTeam) =>
    !readOnly && canPlanTeam(actor, { departmentId: team.departmentId, teamLeadId: team.teamLeadId });

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
          {!readOnly && canRevise && allSlots.length > 0 ? (
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
                {/* An Executive reads a previous project's revisions here (§8) but
                    opens only those on their current work (§16): no dead link. */}
                {r.canOpen ? (
                  <Link href={`/revisions/${r.id}`} className="font-medium hover:underline">
                    Revision #{String(r.revisionNo).padStart(2, '0')} — {r.title}
                  </Link>
                ) : (
                  <span className="font-medium">
                    Revision #{String(r.revisionNo).padStart(2, '0')} — {r.title}
                  </span>
                )}
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
            <TeamBlock key={team.projectDepartmentId} team={team} canPlan={mayPlan(team)}
              projectId={workspace.projectId} references={references} canDelete={canDelete}
              canDownload={canDownload} canComment={mayComment}
              mayAttach={(a) => canAttach && mayAttachToAssignment(actor, { assigneeId: a.assigneeId, departmentId: team.departmentId })} />
          ))
        )}
      </section>

      <section id="comments" className="mt-8 scroll-mt-6">
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
        ) : !canComment ? (
          <p className="mt-3 text-xs text-muted">This project is shared with you to view; the thread is read-only.</p>
        ) : (
          <CommentForm projectId={workspace.projectId} deliverables={allSlots} />
        )}
      </section>
    </>
  );
}

function TeamBlock({ team, canPlan, projectId, references, canDelete, canDownload, canComment, mayAttach }: {
  team: WorkspaceTeam;
  canPlan: boolean;
  projectId: number;
  references: (assignmentId: number) => ProjectAttachment[];
  canDelete: boolean;
  canDownload: boolean;
  /** Whether the version threads (§10, §19) take a new comment from this person now. */
  canComment: boolean;
  mayAttach: (assignment: WorkspaceTeam['assignments'][number]) => boolean;
}) {
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
                  {/* Progress counts approved slots; the uploads say how far the work itself is (§7, §11). */}
                  {' · '}<span className="tabular-nums">{a.uploaded}/{a.total} uploaded</span>
                  {a.effort && (a.effort.loggedMinutes > 0 || a.effort.estimatedMinutes !== null) ? (
                    <>
                      {' · '}
                      <span className={`tabular-nums ${a.effort.estimatedMinutes !== null
                        && a.effort.loggedMinutes > a.effort.estimatedMinutes ? 'text-red-600 dark:text-red-400' : ''}`}>
                        {formatMinutes(a.effort.loggedMinutes)} logged
                        {a.effort.estimatedMinutes !== null ? ` of ${formatMinutes(a.effort.estimatedMinutes)}` : ''}
                      </span>
                    </>
                  ) : null}
                </div>
              </div>
              {a.instructions ? (
                <p className="mt-1 whitespace-pre-wrap text-xs text-muted">{a.instructions}</p>
              ) : null}
              {references(a.id).length > 0 || mayAttach(a) ? (
                <div className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-1">
                  <AttachmentList items={references(a.id)} canDelete={canDelete} canDownload={canDownload} />
                  {mayAttach(a) ? <AttachButton projectId={projectId} assignmentId={a.id} label="Add references" /> : null}
                </div>
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
            {team.deliverables.map((d) => (
              <SlotRow key={d.id} slot={d} projectId={projectId} canDelete={canDelete}
                canDownload={canDownload} canComment={canComment} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * What a version was judged, what its uploader said about it, and the thread
 * on it (§10, §19). Anchored by version id, so a notice about a comment
 * lands on the version it was left on.
 */
function VersionHistory({ version, projectId, canComment }: {
  version: WorkspaceVersion;
  projectId: number;
  canComment: boolean;
}) {
  if (!version.notes && version.reviews.length === 0 && version.comments.length === 0 && !canComment) return null;
  return (
    <ul id={`version-${version.id}`} className="ml-3 mt-0.5 scroll-mt-6 space-y-0.5 border-l border-border pl-2">
      {version.notes ? (
        <li className="whitespace-pre-wrap">
          <span className="font-medium text-foreground">{version.uploadedBy}:</span> {version.notes}
        </li>
      ) : null}
      {version.reviews.map((r, i) => (
        <li key={i} className="whitespace-pre-wrap">
          <span className="font-medium text-foreground">{r.reviewer}</span>
          {' '}
          {r.decision === 'approved' ? 'approved' : r.decision === 'rejected' ? 'rejected' : 'requested changes'}
          {r.stage === 'project_manager' ? ' (PM QA)' : ''}, {formatDateTime(r.reviewedAt)}
          {r.comments ? <>: {r.comments}</> : null}
        </li>
      ))}
      {version.comments.map((c) => (
        <li key={c.id} className="whitespace-pre-wrap">
          <span className="font-medium text-foreground">{c.author}</span>, {formatDateTime(c.createdAt)}: {c.body}
        </li>
      ))}
      {canComment ? (
        <li><VersionCommentForm projectId={projectId} versionId={version.id} /></li>
      ) : null}
    </ul>
  );
}

function SlotRow({ slot, projectId, canDelete, canDownload, canComment }: {
  slot: WorkspaceDeliverable;
  projectId: number;
  canDelete: boolean;
  canDownload: boolean;
  canComment: boolean;
}) {
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
            {slot.openRevision.canOpen ? (
              <Link href={`/revisions/${slot.openRevision.id}`} className="font-medium hover:underline">
                Revision #{String(slot.openRevision.revisionNo).padStart(2, '0')}
              </Link>
            ) : (
              <span className="font-medium">
                Revision #{String(slot.openRevision.revisionNo).padStart(2, '0')}
              </span>
            )}
            {slot.openRevision.deadline ? <span className="text-muted"> · due {slot.openRevision.deadline}</span> : null}
            <p className="mt-0.5 whitespace-pre-wrap text-muted">{slot.openRevision.clientFeedback}</p>
          </div>
        ) : null}
        {/* The newest verdict, when it is about an earlier version than the
            one now on the slot — a v2 waiting on QA still shows why v1 came
            back. A verdict on the current version sits under the file. */}
        {slot.lastReview && slot.lastReview.versionNo !== current?.versionNo
          && !(slot.openRevision && slot.status === 'changes_requested' && slot.lastReview.decision === 'approved') ? (
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
            <FileLink href={current.downloadUrl} filename={current.originalFilename} canDownload={canDownload} />
            <div className="text-xs text-muted">
              v{current.versionNo} · {formatBytes(current.sizeBytes)} · {current.uploadedBy},{' '}
              {formatDateTime(current.uploadedAt)}
              {canDelete ? <> · <DeleteFileButton downloadUrl={current.downloadUrl} filename={current.originalFilename} /></> : null}
            </div>
            {/* The uploader's note, every QA round on this version (§19) —
                so a lead's approval is still there once the PM has rejected
                it — and the thread on it (§10). */}
            <div className="max-w-xs text-xs text-muted">
              <VersionHistory version={current} projectId={projectId} canComment={canComment} />
            </div>
            <FilePreview url={current.downloadUrl} filename={current.originalFilename} mimeType={current.mimeType} />
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
                        <FileLink href={v.downloadUrl} filename={v.originalFilename} canDownload={canDownload} />
                      )}
                      {' '}· {v.uploadedBy}, {formatDateTime(v.uploadedAt)}
                      {canDelete && !v.isDeleted ? <> · <DeleteFileButton downloadUrl={v.downloadUrl} filename={v.originalFilename} /></> : null}
                      <VersionHistory version={v} projectId={projectId} canComment={canComment} />
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
