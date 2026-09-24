import Link from 'next/link';
import { notFound } from 'next/navigation';
import { asc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { departments } from '@/db/schema';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { can, clientScope, projectScope } from '@/lib/authz';
import { monthSummaries } from '@/lib/months/queries';
import { formatMoney, formatMonth } from '@/lib/projects/intake';
import { ClientPanels } from './client-panels';
import { MonthControls } from './month-controls';

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
  // structure of §32–§36: one client, many months, many projects per month —
  // and the §39 numbers for each.
  const months = await monthSummaries(actor, clientId);

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

  // "Current" is the newest month still open; closed ones are the archive (§36).
  const currentMonth = months.find((m) => m.status === 'open') ?? null;
  const canCopy = can(actor, 'projects.create');
  const canClose = can(actor, 'month.close');
  const canReopen = can(actor, 'month.reopen');
  const { copied } = await props.searchParams;
  const copiedCount = Number(Array.isArray(copied) ? copied[0] : copied);

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
        <Stat label="Current month" value={currentMonth ? formatMonth(currentMonth.year, currentMonth.month) : '—'} />
        <Stat label="Projects visible to you" value={String(projectRows.length)} />
        <Stat label="Months on record" value={String(months.length)} />
      </div>

      {Number.isInteger(copiedCount) && copiedCount > 0 ? (
        <p role="status" className="mt-6 rounded-md bg-accent/10 px-3 py-2 text-sm">
          Copied {copiedCount} project{copiedCount === 1 ? '' : 's'}. Each is filed as new and waits for
          the Project Manager.
        </p>
      ) : null}

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Months</h2>
        {months.length === 0 ? (
          <p className="mt-3 rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">
            No months yet. Filing the first project opens one.
          </p>
        ) : (
          <div className="mt-3 space-y-4">
            {months.map((m) => {
              const list = byMonth.get(m.id) ?? [];
              const isCurrent = currentMonth !== null && m.id === currentMonth.id;
              return (
                <div key={m.id} className="overflow-hidden rounded-lg border border-border bg-surface">
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-2.5">
                    <div>
                      <h3 className="text-sm font-medium">
                        {formatMonth(m.year, m.month)}
                        {isCurrent ? <span className="ml-2 text-xs text-accent">current</span> : null}
                        {m.status === 'closed' ? (
                          <span className="ml-2 rounded border border-border px-1.5 py-0.5 text-xs text-muted">
                            closed{m.closedBy ? ` by ${m.closedBy}` : ''}
                          </span>
                        ) : null}
                      </h3>
                      <p className="mt-0.5 text-xs text-muted">
                        {m.projects} project{m.projects === 1 ? '' : 's'}
                        {m.deliverables > 0 ? (
                          <>
                            {' · '}<span className="tabular-nums">{m.completed}/{m.deliverables}</span> delivered
                            {m.inQa > 0 ? ` · ${m.inQa} in QA` : ''}
                            {m.inRevision > 0 ? ` · ${m.inRevision} in revision` : ''}
                            {m.pending > 0 ? ` · ${m.pending} pending` : ''}
                          </>
                        ) : null}
                        {m.departments.length > 0 ? ` · ${m.departments.join(', ')}` : ''}
                      </p>
                    </div>
                    <div className="flex items-start gap-2">
                      {canCopy && m.projects > 0 ? (
                        <Link href={`/clients/${client.id}/months/${m.id}/copy`}
                          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-background">
                          Copy to next month →
                        </Link>
                      ) : null}
                      <MonthControls clientMonthId={m.id} status={m.status}
                        canClose={canClose} canReopen={canReopen} />
                    </div>
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
