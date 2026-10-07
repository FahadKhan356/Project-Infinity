import Link from 'next/link';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { revisionList } from '@/lib/revisions/queries';
import { statusLabel } from '@/lib/workspace/format';

/**
 * Revisions this person can see (brief §16): the PM sees them all, a Team
 * Lead the ones touching their team, an Executive those on their current
 * work — an open assignment on the project, or a slot of theirs the
 * revision touches — and Sales their clients'.
 */
export default async function RevisionsPage(props: PageProps<'/revisions'>) {
  const actor = await requireActor();
  const params = await props.searchParams;
  const includeClosed = params.all === '1';
  // ?project= narrows the list to one project (the link from /work); the
  // scope still decides what is shown, so a wrong id shows nothing.
  const projectParam = Number(params.project);
  const projectId = Number.isInteger(projectParam) && projectParam > 0 ? projectParam : undefined;
  const rows = await revisionList(actor, { includeClosed, projectId });
  const listHref = (all: boolean) => {
    const query = new URLSearchParams();
    if (all) query.set('all', '1');
    if (projectId !== undefined) query.set('project', String(projectId));
    const qs = query.toString();
    return qs ? `/revisions?${qs}` : '/revisions';
  };

  return (
    <AppShell actor={actor}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Revisions</h1>
          <p className="mt-1 max-w-prose text-sm text-muted">
            Client feedback on delivered work, and where each round stands.
          </p>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3 text-sm text-muted">
          {projectId !== undefined ? (
            <Link href={includeClosed ? '/revisions?all=1' : '/revisions'} className="hover:underline">All projects</Link>
          ) : null}
          <Link href={listHref(!includeClosed)} className="hover:underline">
            {includeClosed ? 'Hide closed' : 'Show closed'}
          </Link>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="mt-6 rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">
          {projectId !== undefined ? 'No open revisions on this project. ' : 'No open revisions. '}
          Sales opens one from a delivered file when the client comes back.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Revision</th>
                <th className="px-4 py-2.5 font-medium">Project</th>
                <th className="px-4 py-2.5 font-medium">Deliverables</th>
                <th className="px-4 py-2.5 font-medium">Priority</th>
                <th className="px-4 py-2.5 font-medium">Deadline</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border align-top last:border-0">
                  <td className="min-w-[14rem] px-4 py-2.5">
                    <Link href={`/revisions/${r.id}`} className="font-medium hover:underline">
                      #{String(r.revisionNo).padStart(2, '0')} {r.title}
                    </Link>
                    <div className="mt-0.5 max-w-xs truncate text-xs text-muted" title={r.clientFeedback}>
                      {r.clientFeedback}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <Link href={`/projects/${r.projectId}`} className="hover:underline">{r.projectTitle}</Link>
                    <div className="text-xs text-muted"><span className="font-mono">{r.projectCode}</span> · {r.clientName}</div>
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {r.deliverables.map((d) => (
                      <div key={d.id}>
                        {d.department} · {d.name}
                        <span className="ml-1 text-xs">({statusLabel(d.status)}{d.assignee ? `, ${d.assignee}` : ''})</span>
                      </div>
                    ))}
                  </td>
                  <td className="px-4 py-2.5 capitalize">{r.priority}</td>
                  <td className="px-4 py-2.5 text-muted">{r.deadline ?? '—'}</td>
                  <td className="px-4 py-2.5">{statusLabel(r.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
