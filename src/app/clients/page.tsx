import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { can, clientScope } from '@/lib/authz';

export default async function ClientsPage() {
  const actor = await requireActor();

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
    ORDER BY c.name
  `);

  return (
    <AppShell actor={actor}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Clients</h1>
          <p className="mt-1 text-sm text-muted">{rows.length} client(s) visible to you</p>
        </div>
        {can(actor, 'clients.manage') ? (
          <Link href="/clients/new" className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white">
            Add client
          </Link>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="mt-6 rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">
          No clients yet.
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
