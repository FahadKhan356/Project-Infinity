import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { can, clientScope } from '@/lib/authz';

export default async function ClientsPage(props: PageProps<'/clients'>) {
  const actor = await requireActor();
  const params = await props.searchParams;
  const q = String((Array.isArray(params.q) ? params.q[0] : params.q) ?? '').trim().slice(0, 200);
  const pattern = q === '' ? null : `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

  // The same scope fragment every other client query uses.
  const rows = await getDb().execute<{
    id: number; name: string; company_name: string | null; status: string;
    client_type: string; active_projects: number; total_projects: number;
    months: number; owner: string | null;
  }>(sql`
    SELECT c.id, c.name, c.company_name, c.status, c.client_type,
           owner.full_name AS owner,
           (SELECT count(*) FROM projects p WHERE p.client_id = c.id
              AND p.status NOT IN ('completed','cancelled'))::int AS active_projects,
           (SELECT count(*) FROM projects p WHERE p.client_id = c.id)::int AS total_projects,
           (SELECT count(*) FROM client_months cm WHERE cm.client_id = c.id)::int AS months
    FROM clients c
    LEFT JOIN users owner ON owner.id = c.owner_user_id
    WHERE ${clientScope(actor, 'c')}
      ${pattern === null ? sql`` : sql`AND (c.name ILIKE ${pattern} OR c.company_name ILIKE ${pattern})`}
    ORDER BY c.name
  `);

  return (
    <AppShell actor={actor}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Clients</h1>
          <p className="mt-1 text-sm text-muted">
            {rows.length} client(s) {q ? `matching “${q}”` : 'visible to you'}
          </p>
        </div>
        {can(actor, 'clients.manage') ? (
          <Link href="/clients/new" className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white">
            Add client
          </Link>
        ) : null}
      </div>

      <form method="get" action="/clients" className="mt-4 flex items-center gap-2">
        <label htmlFor="q" className="sr-only">Find a client</label>
        <input id="q" name="q" type="search" defaultValue={q} placeholder="Find a client by name or company"
          className="w-full max-w-sm rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-accent" />
        <button type="submit" className="rounded-md border border-border px-3 py-1.5 text-sm">Find</button>
        {q ? <Link href="/clients" className="text-sm text-muted hover:underline">Clear</Link> : null}
      </form>

      {rows.length === 0 ? (
        <p className="mt-6 rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">
          {q ? 'No client matches.' : 'No clients yet.'}
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Client</th>
                <th className="px-4 py-2.5 font-medium">Type</th>
                <th className="px-4 py-2.5 font-medium">Sales</th>
                <th className="px-4 py-2.5 font-medium text-right">Active</th>
                <th className="px-4 py-2.5 font-medium text-right">Total</th>
                <th className="px-4 py-2.5 font-medium text-right">Months</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5">
                    <Link href={`/clients/${c.id}`} className="font-medium hover:underline">
                      {c.name}
                    </Link>
                    {c.company_name ? (
                      <div className="text-xs text-muted">{c.company_name}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {c.client_type === 'retainer' ? 'Retainer' : 'One-off'}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{c.owner ?? '—'}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{c.active_projects}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted">{c.total_projects}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted">{c.months}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
