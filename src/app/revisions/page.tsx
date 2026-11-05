import Link from 'next/link';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { revisionList } from '@/lib/revisions/queries';
import { statusLabel } from '@/lib/workspace/format';

function getPriorityBadgeClass(priority: string): string {
  const p = priority.toLowerCase();
  if (p === 'urgent') return 'border-rose-500/30 bg-rose-500/10 text-rose-400 font-bold';
  if (p === 'high') return 'border-amber-500/30 bg-amber-500/10 text-amber-400 font-semibold';
  if (p === 'low') return 'border-border/60 bg-background/60 text-muted';
  return 'border-border/80 bg-background/80 text-foreground font-medium';
}

function getStatusBadgeClass(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('closed') || s.includes('delivered') || s.includes('approved')) {
    return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400 font-semibold';
  }
  if (s.includes('qa') || s.includes('review') || s.includes('waiting')) {
    return 'border-amber-500/25 bg-amber-500/10 text-amber-400 font-semibold';
  }
  if (s.includes('reject') || s.includes('changes_requested')) {
    return 'border-rose-500/25 bg-rose-500/10 text-rose-400 font-semibold';
  }
  return 'border-sky-500/25 bg-sky-500/10 text-sky-400 font-semibold';
}

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
      {/* Page Header */}
      <div className="flex flex-col gap-3 border-b border-border/70 pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">Revisions</h1>
            <span className="rounded-full border border-accent/25 bg-accent/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-accent">
              Feedback Rounds
            </span>
          </div>
          <p className="mt-1 text-xs text-muted sm:text-sm">
            Client feedback on delivered work, slot redo requirements, and sign-off status.
          </p>
        </div>

        <div className="flex items-center gap-2 self-start text-xs sm:self-auto">
          {projectId !== undefined ? (
            <Link
              href={includeClosed ? '/revisions?all=1' : '/revisions'}
              className="rounded-lg border border-border/80 bg-background/80 px-3 py-1.5 font-medium text-foreground hover:border-accent hover:text-accent transition-colors"
            >
              All projects
            </Link>
          ) : null}
          <Link
            href={listHref(!includeClosed)}
            className="rounded-lg border border-border/80 bg-background/80 px-3 py-1.5 font-medium text-foreground hover:border-accent hover:text-accent transition-colors"
          >
            {includeClosed ? 'Hide closed' : 'Show closed'}
          </Link>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="mt-6 rounded-xl border border-border/80 bg-surface/90 px-6 py-8 text-center text-sm text-muted">
          {projectId !== undefined ? 'No open revisions on this project. ' : 'No open revisions. '}
          Sales opens one from a delivered file when the client requests modifications.
        </div>
      ) : (
        <div className="mt-6 overflow-hidden rounded-xl border border-border/80 bg-surface/90 shadow-xs backdrop-blur-xs">
          <div className="flex items-center justify-between border-b border-border/70 bg-background/35 px-5 py-3.5">
            <h2 className="text-sm font-semibold tracking-tight text-foreground">Revision Rounds</h2>
            <span className="rounded-full border border-border/80 bg-background/80 px-2.5 py-0.5 text-xs font-medium text-muted">
              {rows.length} {rows.length === 1 ? 'revision' : 'revisions'}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[850px] text-sm">
              <thead className="border-b border-border/70 bg-background/50 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-5 py-3">Revision</th>
                  <th className="px-4 py-3">Project</th>
                  <th className="px-4 py-3">Deliverables</th>
                  <th className="px-3 py-3 text-center">Priority</th>
                  <th className="px-4 py-3">Deadline</th>
                  <th className="px-5 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {rows.map((r) => (
                  <tr key={r.id} className="transition-colors hover:bg-background/40 align-top">
                    {/* Revision Title & Client Feedback */}
                    <td className="px-5 py-3.5 min-w-[15rem]">
                      <div className="flex items-center gap-2">
                        <span className="shrink-0 rounded border border-border/80 bg-background/90 px-1.5 py-0.2 font-mono text-xs font-bold text-foreground">
                          #{String(r.revisionNo).padStart(2, '0')}
                        </span>
                        <Link href={`/revisions/${r.id}`} className="font-semibold text-foreground hover:text-accent hover:underline">
                          {r.title}
                        </Link>
                      </div>
                      {r.clientFeedback ? (
                        <div
                          className="mt-1.5 line-clamp-2 max-w-sm rounded-md border border-border/60 bg-background/40 px-2.5 py-1 text-xs text-muted"
                          title={r.clientFeedback}
                        >
                          <span className="text-foreground/70 italic">&ldquo;{r.clientFeedback}&rdquo;</span>
                        </div>
                      ) : null}
                    </td>

                    {/* Project & Client */}
                    <td className="px-4 py-3.5">
                      <Link href={`/projects/${r.projectId}`} className="font-semibold text-foreground hover:text-accent hover:underline">
                        {r.projectTitle}
                      </Link>
                      <div className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                        <span className="rounded border border-border/80 bg-background/80 px-1.5 py-0.2 font-mono text-[11px]">
                          {r.projectCode}
                        </span>
                        <span>·</span>
                        <span>{r.clientName}</span>
                      </div>
                    </td>

                    {/* Deliverables List */}
                    <td className="px-4 py-3.5">
                      <div className="space-y-1.5">
                        {r.deliverables.map((d) => (
                          <div
                            key={d.id}
                            className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border/60 bg-background/40 px-2.5 py-1 text-xs"
                          >
                            <span className="font-medium text-foreground">{d.name}</span>
                            <span className="text-muted/60">·</span>
                            <span className="text-muted">{d.department}</span>
                            <span
                              className={`rounded px-1.5 py-0.2 text-[10px] font-medium capitalize ${
                                d.status.includes('requested')
                                  ? 'bg-amber-500/10 text-amber-400'
                                  : d.status.includes('qa')
                                    ? 'bg-sky-500/10 text-sky-400'
                                    : 'bg-surface text-muted'
                              }`}
                            >
                              {statusLabel(d.status)}
                            </span>
                            {d.assignee ? (
                              <span className="text-muted/80">({d.assignee})</span>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </td>

                    {/* Priority */}
                    <td className="px-3 py-3.5 text-center">
                      <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs capitalize ${getPriorityBadgeClass(r.priority)}`}>
                        {r.priority}
                      </span>
                    </td>

                    {/* Deadline */}
                    <td className="px-4 py-3.5 text-xs whitespace-nowrap">
                      {r.deadline ? (
                        <span className="font-medium text-foreground">{r.deadline}</span>
                      ) : (
                        <span className="text-muted/60">—</span>
                      )}
                    </td>

                    {/* Status */}
                    <td className="px-5 py-3.5 whitespace-nowrap">
                      <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs capitalize ${getStatusBadgeClass(r.status)}`}>
                        {statusLabel(r.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </AppShell>
  );
}
