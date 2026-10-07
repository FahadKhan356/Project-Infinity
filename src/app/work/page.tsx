import Link from 'next/link';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { formatDateTime, statusLabel } from '@/lib/workspace/format';
import { myWork, type WorkItem } from '@/lib/workspace/my-work';

/**
 * An Executive's landing page (brief §8): what is on their desk now, and what
 * they have done before, each one a click from the project workspace.
 */
export default async function WorkPage() {
  const actor = await requireActor();
  const { current, today, previous } = await myWork(actor);

  return (
    <AppShell actor={actor}>
      <h1 className="text-lg font-semibold tracking-tight">My work</h1>
      <p className="mt-1 max-w-prose text-sm text-muted">
        Work assigned to you. Open a project to read the brief, see what other teams have
        uploaded, and add your deliverables.
      </p>

      {today.length > 0 ? (
        <section className="mt-6">
          <h2 className="text-sm font-semibold">Today</h2>
          <p className="mt-1 text-xs text-muted">
            Assignments whose planned dates include today.
          </p>
          <WorkTable items={today} />
        </section>
      ) : null}

      <section className="mt-6">
        <h2 className="text-sm font-semibold">Current projects</h2>
        {current.length === 0 ? (
          <p className="mt-3 rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">
            Nothing assigned to you right now.
          </p>
        ) : (
          <WorkTable items={current} />
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Previous projects</h2>
        {previous.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No completed work yet.</p>
        ) : (
          <WorkTable items={previous} muted />
        )}
      </section>
    </AppShell>
  );
}

function WorkTable({ items, muted = false }: { items: WorkItem[]; muted?: boolean }) {
  return (
    <div className={`mt-3 overflow-x-auto rounded-lg border border-border bg-surface ${muted ? 'opacity-80' : ''}`}>
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-4 py-2.5 font-medium">Project</th>
            <th className="px-4 py-2.5 font-medium">Assignment</th>
            <th className="px-4 py-2.5 font-medium">Dates</th>
            <th className="px-4 py-2.5 font-medium">Deadline</th>
            <th className="px-4 py-2.5 font-medium">Priority</th>
            <th className="px-4 py-2.5 font-medium text-right">Progress</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium">Revision</th>
            <th className="px-4 py-2.5 font-medium">Comments</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.assignmentId} className="border-b border-border align-top last:border-0">
              <td className="min-w-[16rem] px-4 py-2.5">
                <Link href={`/projects/${item.projectId}#workspace`} className="font-medium hover:underline">
                  {item.projectTitle}
                </Link>
                <div className="text-xs text-muted">
                  <span className="font-mono">{item.projectCode}</span> · {item.clientName} · {item.department}
                </div>
              </td>
              <td className="px-4 py-2.5">
                <div>{item.assignmentTitle}</div>
                {item.instructions ? (
                  <div className="mt-0.5 max-w-xs truncate text-xs text-muted" title={item.instructions}>
                    {item.instructions}
                  </div>
                ) : null}
              </td>
              <td className="px-4 py-2.5 whitespace-nowrap text-muted">
                {item.startDate ?? '—'} → {item.endDate ?? '—'}
              </td>
              <td className="px-4 py-2.5 text-muted">{item.deadline ?? '—'}</td>
              <td className="px-4 py-2.5 capitalize">{item.priority}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">
                {item.approved}/{item.total}
                {/* The counter is approved slots; the uploads are the executive's own progress (§7, §11). */}
                <div className="text-xs text-muted">{item.uploaded}/{item.total} uploaded</div>
                {item.changesRequested > 0 ? (
                  <div className="text-xs text-red-600 dark:text-red-400">
                    {item.changesRequested} to redo
                  </div>
                ) : item.inQa > 0 ? (
                  <div className="text-xs text-muted">{item.inQa} in QA</div>
                ) : null}
                {item.slots.length > 0 ? (
                  <details className="mt-1 text-left text-xs text-muted">
                    <summary className="cursor-pointer">
                      {item.slots.length} slot{item.slots.length === 1 ? '' : 's'}
                    </summary>
                    <ul className="mt-1 space-y-0.5">
                      {item.slots.map((s) => (
                        <li key={s.id} title={s.description ?? undefined} className="whitespace-nowrap">
                          {s.name} · {statusLabel(s.status)}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </td>
              <td className="px-4 py-2.5 text-muted">
                {statusLabel(item.status)}
                {item.projectStatus === 'completed' || item.projectStatus === 'cancelled' ? (
                  <div className="text-xs">project {statusLabel(item.projectStatus)}</div>
                ) : null}
              </td>
              <td className="px-4 py-2.5 text-muted">
                {item.latestRevisionNo === null ? (
                  '—'
                ) : (
                  <Link href={`/revisions?project=${item.projectId}`} className="hover:underline">
                    <span className={item.openRevisions > 0 ? 'font-medium text-red-600 dark:text-red-400' : ''}>
                      #{String(item.latestRevisionNo).padStart(2, '0')} {statusLabel(item.latestRevisionStatus ?? '')}
                    </span>
                    {item.openRevisions > 1 ? <div className="text-xs">{item.openRevisions} open</div> : null}
                  </Link>
                )}
              </td>
              <td className="px-4 py-2.5 text-muted">
                {item.commentCount === 0 ? (
                  '—'
                ) : (
                  <Link href={`/projects/${item.projectId}#comments`} className="hover:underline">
                    {item.commentCount}
                    {item.lastCommentAt ? <div className="text-xs">{formatDateTime(item.lastCommentAt)}</div> : null}
                  </Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
