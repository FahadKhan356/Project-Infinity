import Link from 'next/link';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { formatMonth } from '@/lib/projects/intake';
import {
  DELIVERY_STATUSES, PROJECT_STATUSES, hasAnyFilter, parseSearchParams, searchClients, searchOptions, searchProjects,
  type MatchedOn,
} from '@/lib/search/search';
import { statusLabel } from '@/lib/workspace/format';

const field =
  'mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-accent';

const MATCH_LABEL: Record<MatchedOn, string> = {
  code: 'code', title: 'name', client: 'client', team_lead: 'team lead', executive: 'executive',
  deliverable: 'deliverable', file: 'file name', revision: 'revision',
};

/**
 * Global search and filters (brief §22). The form is a plain GET so every
 * search is a URL that can be shared; the results are the same scoped
 * query as every other list, so nothing appears here that would not appear
 * elsewhere.
 */
export default async function SearchPage(props: PageProps<'/search'>) {
  const actor = await requireActor();
  const params = await props.searchParams;
  const filters = parseSearchParams(params);
  const [options, hits, clients] = await Promise.all([
    searchOptions(actor), searchProjects(actor, filters), searchClients(actor, filters.q),
  ]);
  const active = hasAnyFilter(filters);

  return (
    <AppShell actor={actor}>
      <h1 className="text-lg font-semibold tracking-tight">Search</h1>
      <p className="mt-1 max-w-prose text-sm text-muted">
        Find a project by name, code, client, team, person, deliverable, file, revision or date. Only
        what you could open anyway is found.
      </p>

      <form method="get" action="/search" className="mt-6 rounded-lg border border-border bg-surface p-4">
        <label className="block text-sm font-medium" htmlFor="q">Search for</label>
        <input id="q" name="q" type="search" defaultValue={filters.q ?? ''} autoFocus
          placeholder="ABC Company, AKT-2026-0001, Ahmed, Video 01, logo, Revision #03…" className={field} />

        <details className="mt-3" open={active && !filters.q ? true : undefined}>
          <summary className="cursor-pointer text-xs font-medium text-muted">Filters</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-xs font-medium" htmlFor="status">Status</label>
              <select id="status" name="status" multiple size={5} defaultValue={filters.status ?? []} className={field}>
                {PROJECT_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
              </select>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium" htmlFor="team">Team</label>
                <select id="team" name="team" defaultValue={filters.departmentId ?? ''} className={field}>
                  <option value="">Any</option>
                  {options.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium" htmlFor="client">Client</label>
                <select id="client" name="client" defaultValue={filters.clientId ?? ''} className={field}>
                  <option value="">Any</option>
                  {options.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              {options.canFilterByPeople ? (
                <>
                  <div>
                    <label className="block text-xs font-medium" htmlFor="lead">Team Lead</label>
                    <select id="lead" name="lead" defaultValue={filters.teamLeadId ?? ''} className={field}>
                      <option value="">Any</option>
                      {options.teamLeads.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium" htmlFor="executive">Executive</label>
                    <select id="executive" name="executive" defaultValue={filters.executiveId ?? ''} className={field}>
                      <option value="">Any</option>
                      {options.executives.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  </div>
                </>
              ) : null}
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium" htmlFor="delivery">Delivery status</label>
                <select id="delivery" name="delivery" defaultValue={filters.deliveryStatus ?? ''} className={field}>
                  <option value="">Any</option>
                  {DELIVERY_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium" htmlFor="period">Month</label>
                <input id="period" name="period" type="month" defaultValue={filters.period ?? ''} className={field} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium" htmlFor="from">Deadline from</label>
                  <input id="from" name="from" type="date" defaultValue={filters.deadlineFrom ?? ''} className={field} />
                </div>
                <div>
                  <label className="block text-xs font-medium" htmlFor="to">to</label>
                  <input id="to" name="to" type="date" defaultValue={filters.deadlineTo ?? ''} className={field} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium" htmlFor="created_from">Created from</label>
                  <input id="created_from" name="created_from" type="date" defaultValue={filters.createdFrom ?? ''} className={field} />
                </div>
                <div>
                  <label className="block text-xs font-medium" htmlFor="created_to">to</label>
                  <input id="created_to" name="created_to" type="date" defaultValue={filters.createdTo ?? ''} className={field} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium" htmlFor="delivered_from">Delivered from</label>
                  <input id="delivered_from" name="delivered_from" type="date" defaultValue={filters.deliveredFrom ?? ''} className={field} />
                </div>
                <div>
                  <label className="block text-xs font-medium" htmlFor="delivered_to">to</label>
                  <input id="delivered_to" name="delivered_to" type="date" defaultValue={filters.deliveredTo ?? ''} className={field} />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="revisions" value="open" defaultChecked={filters.openRevisions} />
                Has an open revision
              </label>
            </div>
          </div>
        </details>

        <div className="mt-4 flex items-center gap-3">
          <button type="submit" className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white">
            Search
          </button>
          {active ? <Link href="/search" className="text-sm text-muted hover:underline">Clear</Link> : null}
        </div>
      </form>

      {clients.length > 0 ? (
        <section className="mt-6">
          <h2 className="text-sm font-semibold">Clients</h2>
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border bg-surface">
            {clients.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
                <div>
                  <Link href={`/clients/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                  {c.companyName ? <span className="ml-2 text-xs text-muted">{c.companyName}</span> : null}
                </div>
                <div className="text-xs text-muted">
                  {c.activeProjects} active · {c.totalProjects} total · {c.status}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="mt-6 text-sm text-muted">
        {hits.length === 0
          ? active ? 'Nothing matches.' : 'Nothing visible to you yet.'
          : `${hits.length} project${hits.length === 1 ? '' : 's'}${active ? ' match' : ' visible to you'}`}
      </p>

      {hits.length > 0 ? (
        <div className="mt-3 overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Project</th>
                <th className="px-4 py-2.5 font-medium">Client · month</th>
                <th className="px-4 py-2.5 font-medium">Teams · people</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium text-right">Progress</th>
                <th className="px-4 py-2.5 font-medium">Deadline</th>
              </tr>
            </thead>
            <tbody>
              {hits.map((h) => (
                <tr key={h.id} className="border-b border-border align-top last:border-0">
                  <td className="px-4 py-2.5">
                    <Link href={`/projects/${h.id}`} className="font-medium hover:underline">{h.title}</Link>
                    <div className="font-mono text-xs text-muted">{h.projectCode}</div>
                    {h.matchedOn.length > 0 ? (
                      <div className="mt-0.5 text-xs text-accent">
                        matched {h.matchedOn.map((m) => MATCH_LABEL[m]).join(', ')}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    <Link href={`/clients/${h.clientId}`} className="hover:underline">{h.clientName}</Link>
                    <div className="text-xs">{formatMonth(h.year, h.month)}</div>
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {h.teams.join(', ') || '—'}
                    {h.teamLeads.length > 0 || h.executives.length > 0 ? (
                      <div className="text-xs">
                        {[...h.teamLeads, ...h.executives].join(', ')}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5">
                    {statusLabel(h.status)}
                    {h.latestDeliveryStatus ? (
                      <div className="text-xs text-muted">delivery: {statusLabel(h.latestDeliveryStatus)}</div>
                    ) : null}
                    {h.openRevisions > 0 ? (
                      <div className="text-xs text-muted">{h.openRevisions} open revision{h.openRevisions === 1 ? '' : 's'}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted">{h.approved}/{h.total}</td>
                  <td className="px-4 py-2.5 text-muted">{h.deadline ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </AppShell>
  );
}
