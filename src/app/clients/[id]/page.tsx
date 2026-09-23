import Link from 'next/link';
import { notFound } from 'next/navigation';
import { asc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { departments } from '@/db/schema';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { can, clientScope, projectScope } from '@/lib/authz';
import { formatMoney, formatMonth } from '@/lib/projects/intake';
import { ClientPanels } from './client-panels';

export default async function ClientPage(props: PageProps<'/clients/[id]'>) {
  const actor = await requireActor();
  const { id } = await props.params;
  const clientId = Number(id);
  if (!Number.isInteger(clientId)) notFound();

  const db = getDb();
  const showPricing = can(actor, 'pricing.view');

  const [client] = await db.execute<{
    id: number; name: string; company_name: string | null; status: string;
    client_type: string; notes: string | null; owner: string | null; started_on: string | null;
  }>(sql`
    SELECT c.id, c.name, c.company_name, c.status, c.client_type, c.notes, c.started_on,
           owner.full_name AS owner
    FROM clients c
    LEFT JOIN users owner ON owner.id = c.owner_user_id
    WHERE c.id = ${clientId} AND ${clientScope(actor, 'c')}
  `);
  if (!client) notFound();

  // Months newest first, each with the projects visible to this actor — the
  // structure of §32–§36: one client, many months, many projects per month.
  const months = await db.execute<{
    id: number; period_year: number; period_month: number; status: string; project_count: number;
  }>(sql`
    SELECT cm.id, cm.period_year, cm.period_month, cm.status,
           (SELECT count(*) FROM projects p
             WHERE p.client_month_id = cm.id AND ${projectScope(actor, 'p')})::int AS project_count
    FROM client_months cm
    WHERE cm.client_id = ${clientId}
    ORDER BY cm.period_year DESC, cm.period_month DESC
  `);

  const projectRows = await db.execute<{
    id: number; client_month_id: number; project_code: string; title: string;
    status: string; deadline: string | null; teams: string | null;
    price_amount: string | null; price_currency: string;
    total: number; approved: number;
  }>(sql`
    SELECT p.id, p.client_month_id, p.project_code, p.title, p.status, p.deadline,
           ${showPricing ? sql`p.price_amount` : sql`NULL::numeric`} AS price_amount,
           p.price_currency,
           (SELECT string_agg(d.name, ', ' ORDER BY d.sort_order)
              FROM project_departments pd JOIN departments d ON d.id = pd.department_id
             WHERE pd.project_id = p.id) AS teams,
           prog.total, prog.approved
    FROM projects p
    JOIN v_project_progress prog ON prog.project_id = p.id
    WHERE p.client_id = ${clientId} AND ${projectScope(actor, 'p')}
    ORDER BY p.created_at DESC
  `);

  type ProjectRow = (typeof projectRows)[number];
  const byMonth = new Map<number, ProjectRow[]>();
  for (const row of projectRows) {
    const list = byMonth.get(Number(row.client_month_id)) ?? [];
    list.push(row);
    byMonth.set(Number(row.client_month_id), list);
  }

  const [contacts, services, allDepartments] = await Promise.all([
    db.execute<{ id: number; name: string; email: string | null; phone: string | null; job_title: string | null; is_primary: boolean }>(
      sql`SELECT id, name, email, phone, job_title, is_primary FROM client_contacts
          WHERE client_id = ${clientId} ORDER BY is_primary DESC, name`,
    ),
    db.execute<{ department_id: number }>(
      sql`SELECT department_id FROM client_services WHERE client_id = ${clientId}`,
    ),
    db.select({ id: departments.id, name: departments.name })
      .from(departments)
      .where(eq(departments.isProduction, true))
      .orderBy(asc(departments.sortOrder)),
  ]);

  const currentMonth = months[0];

  return (
    <AppShell actor={actor}>
      <Link href="/clients" className="text-sm text-muted hover:text-foreground">← Clients</Link>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{client.name}</h1>
          <p className="mt-1 text-sm text-muted">
            {[client.company_name, client.client_type === 'retainer' ? 'Retainer' : 'One-off',
              client.owner ? `Sales: ${client.owner}` : null]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        {can(actor, 'projects.create') ? (
          <Link href={`/projects/new?client=${client.id}`}
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white">
            New project
          </Link>
        ) : null}
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Current month" value={currentMonth ? formatMonth(Number(currentMonth.period_year), Number(currentMonth.period_month)) : '—'} />
        <Stat label="Projects visible to you" value={String(projectRows.length)} />
        <Stat label="Months on record" value={String(months.length)} />
      </div>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Months</h2>
        {months.length === 0 ? (
          <p className="mt-3 rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">
            No months yet. Filing the first project opens one.
          </p>
        ) : (
          <div className="mt-3 space-y-4">
            {months.map((m, index) => {
              const list = byMonth.get(Number(m.id)) ?? [];
              return (
                <div key={m.id} className="overflow-hidden rounded-lg border border-border bg-surface">
                  <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                    <h3 className="text-sm font-medium">
                      {formatMonth(Number(m.period_year), Number(m.period_month))}
                      {index === 0 ? <span className="ml-2 text-xs text-accent">current</span> : null}
                    </h3>
                    <span className="text-xs text-muted">
                      {m.status === 'closed' ? 'Closed' : 'Open'} · {list.length} project(s)
                    </span>
                  </div>

                  {list.length === 0 ? (
                    <p className="px-4 py-4 text-sm text-muted">Nothing visible to you in this month.</p>
                  ) : (
                    <table className="w-full text-sm">
                      <tbody>
                        {list.map((p) => (
                          <tr key={p.id} className="border-b border-border last:border-0">
                            <td className="px-4 py-2.5">
                              <Link href={`/projects/${p.id}`} className="font-medium hover:underline">
                                {p.title}
                              </Link>
                              <div className="font-mono text-xs text-muted">{p.project_code}</div>
                            </td>
                            <td className="px-4 py-2.5 text-muted">{p.teams ?? '—'}</td>
                            <td className="px-4 py-2.5 text-muted">{p.status.replace(/_/g, ' ')}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-muted">
                              {Number(p.approved)}/{Number(p.total)}
                            </td>
                            {showPricing ? (
                              <td className="px-4 py-2.5 text-right tabular-nums">
                                {formatMoney(p.price_amount, p.price_currency)}
                              </td>
                            ) : null}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <ClientPanels
        clientId={client.id}
        canManage={can(actor, 'clients.manage')}
        canOpenMonth={can(actor, 'projects.create')}
        contacts={contacts.map((c) => ({ ...c, id: Number(c.id) }))}
        services={services.map((s) => Number(s.department_id))}
        departments={allDepartments}
        notes={client.notes}
      />
    </AppShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="text-sm font-medium">{value}</div>
      <div className="mt-0.5 text-xs text-muted">{label}</div>
    </div>
  );
}
