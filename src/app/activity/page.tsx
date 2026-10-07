import Link from 'next/link';
import { requireActor } from '@/lib/auth/dal';
import { AccessDenied } from '@/components/access-denied';
import { AppShell } from '@/components/app-shell';
import {
  activityLog, activityLogOptions, canViewActivityLog, hasAnyActivityFilter, parseActivityLogParams,
} from '@/lib/activity/log';
import { formatDateTime } from '@/lib/workspace/format';

const field =
  'mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-accent';

/** The current query with only the page changed, so a filtered log pages within itself. */
function pageHref(params: Record<string, string | string[] | undefined>, page: number): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === 'page' || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) q.append(key, v);
  }
  if (page > 1) q.set('page', String(page));
  const s = q.toString();
  return s ? `/activity?${s}` : '/activity';
}

/**
 * The management-wide activity log (brief §25). A plain GET page, like
 * search, so a filtered view is a URL that can be shared; every row links
 * to its project. Who may open it is the same rule as seeing every project.
 */
export default async function ActivityPage(props: PageProps<'/activity'>) {
  const actor = await requireActor();
  if (!canViewActivityLog(actor)) {
    return <AppShell actor={actor}><AccessDenied what="the activity log" /></AppShell>;
  }
  const params = await props.searchParams;
  const filters = parseActivityLogParams(params);
  const [options, log] = await Promise.all([activityLogOptions(actor), activityLog(actor, filters)]);
  const active = hasAnyActivityFilter(filters);

  return (
    <AppShell actor={actor}>
      <h1 className="text-lg font-semibold tracking-tight">Activity log</h1>
      <p className="mt-1 max-w-prose text-sm text-muted">
        Who did what, across every project, newest first. Narrow it by client, project, person, action or date.
      </p>

      <form method="get" action="/activity" className="mt-6 rounded-lg border border-border bg-surface p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="block text-xs font-medium" htmlFor="client">Client</label>
            <select id="client" name="client" defaultValue={filters.clientId ?? ''} className={field}>
              <option value="">Any</option>
              {options.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium" htmlFor="code">Project code</label>
            <input id="code" name="code" type="text" defaultValue={filters.projectCode ?? ''}
              placeholder="AKT-2026-0001" maxLength={40} className={field} />
          </div>
          <div>
            <label className="block text-xs font-medium" htmlFor="actor">Who</label>
            <select id="actor" name="actor" defaultValue={filters.actorId ?? ''} className={field}>
              <option value="">Anyone</option>
              {options.actors.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium" htmlFor="action">Action</label>
            <select id="action" name="action" defaultValue={filters.action ?? ''} className={field}>
              <option value="">Any</option>
              {options.actions.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium" htmlFor="from">From</label>
            <input id="from" name="from" type="date" defaultValue={filters.from ?? ''} className={field} />
          </div>
          <div>
            <label className="block text-xs font-medium" htmlFor="to">To</label>
            <input id="to" name="to" type="date" defaultValue={filters.to ?? ''} className={field} />
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button type="submit" className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white">
            Apply
          </button>
          {active ? <Link href="/activity" className="text-sm text-muted hover:underline">Clear</Link> : null}
        </div>
      </form>

      {log.rows.length === 0 ? (
        <p className="mt-6 text-sm text-muted">Nothing recorded for these filters.</p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">When</th>
                <th className="px-4 py-2.5 font-medium">Who</th>
                <th className="px-4 py-2.5 font-medium">What</th>
                <th className="px-4 py-2.5 font-medium">Project</th>
                <th className="px-4 py-2.5 font-medium">Client</th>
              </tr>
            </thead>
            <tbody>
              {log.rows.map((row) => (
                <tr key={row.id} className="border-b border-border align-top last:border-0">
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted">{formatDateTime(row.at)}</td>
                  <td className="whitespace-nowrap px-4 py-2.5">{row.actorName ?? 'System'}</td>
                  <td className="px-4 py-2.5">{row.text}</td>
                  <td className="px-4 py-2.5">
                    <Link href={`/projects/${row.projectId}`} className="font-mono text-xs hover:underline">{row.projectCode}</Link>
                    <div className="text-xs text-muted">{row.projectTitle}</div>
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    <Link href={`/clients/${row.clientId}`} className="hover:underline">{row.clientName}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {log.page > 1 || log.hasMore ? (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pages">
          {log.page > 1
            ? <Link href={pageHref(params, log.page - 1)} className="text-muted hover:underline">← Newer</Link>
            : <span />}
          <span className="text-xs text-muted">Page {log.page}</span>
          {log.hasMore
            ? <Link href={pageHref(params, log.page + 1)} className="text-muted hover:underline">Older →</Link>
            : <span />}
        </nav>
      ) : null}
    </AppShell>
  );
}
