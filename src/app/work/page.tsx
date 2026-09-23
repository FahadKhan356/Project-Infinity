import Link from 'next/link';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { statusLabel } from '@/lib/workspace/format';
import { myWork, type WorkItem } from '@/lib/workspace/my-work';

/**
 * An Executive's landing page (brief §8): what is on their desk now, and what
 * they have done before, each one a click from the project workspace.
 */
export default async function WorkPage() {
  const actor = await requireActor();
  const { current, previous } = await myWork(actor);

  return (
    <AppShell actor={actor}>
      <h1 className="text-lg font-semibold tracking-tight">My work</h1>
      <p className="mt-1 max-w-prose text-sm text-muted">
        Work assigned to you. Open a project to read the brief, see what other teams have
        uploaded, and add your deliverables.
      </p>

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
                {item.changesRequested > 0 ? (
                  <div className="text-xs text-red-600 dark:text-red-400">
                    {item.changesRequested} to redo
                  </div>
                ) : item.inQa > 0 ? (
                  <div className="text-xs text-muted">{item.inQa} in QA</div>
                ) : null}
              </td>
              <td className="px-4 py-2.5 text-muted">
                {statusLabel(item.status)}
                {item.projectStatus === 'completed' || item.projectStatus === 'cancelled' ? (
                  <div className="text-xs">project {statusLabel(item.projectStatus)}</div>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
