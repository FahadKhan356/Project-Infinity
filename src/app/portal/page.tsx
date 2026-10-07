import Link from 'next/link';
import { requireClientActor } from '@/lib/auth/dal';
import { formatMonth } from '@/lib/projects/intake';
import { portalClientName, portalNews, portalProjects } from '@/lib/portal/portal';
import { formatDateTime } from '@/lib/workspace/format';
import { PortalShell } from './portal-shell';

/**
 * The client portal's home (brief §29): what is waiting for review, then
 * every project by month — the client's own view of §33's month history.
 */
export default async function PortalHome() {
  const actor = await requireClientActor();
  const [clientName, projects, news] = await Promise.all([
    portalClientName(actor), portalProjects(actor), portalNews(actor),
  ]);
  const waiting = projects.filter((p) => p.awaitingReview > 0);

  const months = new Map<string, typeof projects>();
  for (const p of projects) {
    const key = formatMonth(p.period.year, p.period.month);
    months.set(key, [...(months.get(key) ?? []), p]);
  }

  return (
    <PortalShell actor={actor} clientName={clientName}>
      <h1 className="text-lg font-semibold tracking-tight">Welcome, {actor.fullName.split(' ')[0]}</h1>
      <p className="mt-1 text-sm text-muted">
        Your projects with Aktivacity, and the files we have delivered to you. Review each file and approve it,
        or tell us what should change.
      </p>

      {waiting.length > 0 ? (
        <section className="mt-6 rounded-lg border border-accent/40 bg-accent/5 p-4">
          <h2 className="text-sm font-semibold">Waiting for your review</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {waiting.map((p) => (
              <li key={p.id}>
                <Link href={`/portal/projects/${p.id}`} className="font-medium hover:underline">{p.title}</Link>
                <span className="text-muted"> — {p.awaitingReview} file{p.awaitingReview === 1 ? '' : 's'}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {news.length > 0 ? (
        <section className="mt-6">
          <h2 className="text-sm font-semibold">What’s new</h2>
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border bg-surface text-sm">
            {news.map((n) => (
              <li key={n.id} className="px-4 py-2.5">
                {n.linkPath ? <Link href={n.linkPath} className="font-medium hover:underline">{n.title}</Link>
                  : <span className="font-medium">{n.title}</span>}
                <span className="ml-2 text-xs text-muted">{formatDateTime(n.createdAt)}</span>
                {n.body ? <div className="text-xs text-muted">{n.body}</div> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Projects</h2>
        {projects.length === 0 ? (
          <p className="mt-3 rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">
            Nothing here yet. Your projects will appear once your account manager has set them up.
          </p>
        ) : (
          <div className="mt-3 space-y-5">
            {[...months.entries()].map(([month, list]) => (
              <div key={month}>
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted">{month}</h3>
                <ul className="mt-2 divide-y divide-border rounded-lg border border-border bg-surface">
                  {list.map((p) => (
                    <li key={p.id}>
                      <Link href={`/portal/projects/${p.id}`}
                        className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-background">
                        <span>
                          <span className="font-medium">{p.title}</span>
                          <span className="ml-2 font-mono text-xs text-muted">{p.projectCode}</span>
                        </span>
                        <span className="flex items-center gap-3 text-xs">
                          <span className="tabular-nums text-muted">{p.delivered}/{p.deliverables} delivered</span>
                          <span className="rounded-md border border-border px-2 py-0.5">{p.status}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </PortalShell>
  );
}
