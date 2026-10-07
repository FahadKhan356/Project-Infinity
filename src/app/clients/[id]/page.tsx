import Link from 'next/link';
import { notFound } from 'next/navigation';
import { asc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { departments } from '@/db/schema';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { can, clientScope } from '@/lib/authz';
import { loadClientMonths, nextMonthToOpen } from '@/lib/months/queries';
import { formatMonth } from '@/lib/projects/intake';
import { canViewReports } from '@/lib/reports/monthly';
import { ClientPanels } from './client-panels';
import { CreateMonthForm } from './create-month-form';
import { MonthCard } from './month-card';
import { PortalPanel } from './portal-panel';
import { listPortalLogins } from '@/lib/portal/access';

export default async function ClientPage(props: PageProps<'/clients/[id]'>) {
  const actor = await requireActor();
  const { id } = await props.params;
  const clientId = Number(id);
  if (!Number.isInteger(clientId)) notFound();

  const db = getDb();

  const [client] = await db.execute<{
    id: number; name: string; company_name: string | null; status: string;
    client_type: string; notes: string | null; owner: string | null; started_on: string | null;
    portal_auto_deliver: boolean; owned: boolean;
  }>(sql`
    SELECT c.id, c.name, c.company_name, c.status, c.client_type, c.notes, c.started_on::text AS started_on,
           c.portal_auto_deliver,
           owner.full_name AS owner,
           -- theirs to work, as opposed to opened to them by a shared project (§23)
           ${clientScope(actor, 'c')} AS owned
    FROM clients c
    LEFT JOIN users owner ON owner.id = c.owner_user_id
    WHERE c.id = ${clientId} AND ${clientScope(actor, 'c', { shared: true })}
  `);
  if (!client) notFound();
  // A rep who reaches the client only through a shared project reads it:
  // the controls that would change it or file into it stay off the page,
  // as the server refuses them (lib/months/lifecycle, lib/projects/file-project).
  const owned = client.owned === true;

  // Months newest first, each with the projects visible to this actor — the
  // structure of §32–§36: one client, many months, many projects per month —
  // the §39 numbers for each, and the §35 layout: the current month on top,
  // months opened ahead apart, everything earlier folded away as previous.
  const overview = await loadClientMonths(actor, clientId);
  const { months, projects: projectRows, showPricing } = overview;

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

  // "Current" is the open month that holds today; a month opened early for
  // planning (§37) must not push this month out of view. With nothing open
  // this month, the newest open one stands in. Closed ones are the archive (§36).
  const currentMonth = overview.current?.month ?? null;
  // "+ Create October 2026" (§37) offers the month after the newest on record.
  const next = nextMonthToOpen(months);
  const nextMonth = { ...next, label: formatMonth(next.year, next.month) };
  const canOpenMonth = owned && can(actor, 'projects.create');
  const canCopy = canOpenMonth;
  const showReports = canViewReports(actor);
  const portalLogins = await listPortalLogins(actor, clientId);
  const canClose = owned && can(actor, 'month.close');
  const canReopen = owned && can(actor, 'month.reopen');
  const { copied } = await props.searchParams;
  const copiedCount = Number(Array.isArray(copied) ? copied[0] : copied);
  // Everything a month card needs beyond its own month.
  const cardProps = { clientId: client.id, showPricing, showReports, canCopy, canClose, canReopen };

  return (
    <AppShell actor={actor}>
      <Link href="/clients" className="text-sm text-muted hover:text-foreground">← Clients</Link>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{client.name}</h1>
          <p className="mt-1 text-sm text-muted">
            {[client.company_name, client.client_type === 'retainer' ? 'Retainer' : 'One-off',
              client.status.charAt(0).toUpperCase() + client.status.slice(1),
              client.started_on ? `Client since ${client.started_on}` : null,
              client.owner ? `Sales: ${client.owner}` : null]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <div className="flex gap-2">
          {owned && can(actor, 'clients.manage') ? (
            <Link href={`/clients/${client.id}/edit`}
              className="rounded-md border border-border px-3 py-2 text-sm font-medium">
              Edit client
            </Link>
          ) : null}
          {owned && can(actor, 'projects.create') ? (
            <Link href={`/projects/new?client=${client.id}`}
              className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white">
              New project
            </Link>
          ) : null}
        </div>
      </div>

      {!owned ? (
        <p role="status" className="mt-4 rounded-md border border-border bg-surface px-4 py-3 text-sm">
          <span className="font-medium">Shared with you to view.</span>{' '}
          <span className="text-muted">
            A project of this client was shared with you, so you can read the client and the
            projects you were given; filing work, editing the client and closing months stay
            with {client.owner ? `${client.owner}, its Sales representative` : 'its Sales representative'}.
          </span>
        </p>
      ) : null}

      {/* The §35 overview. Counts cover the projects this viewer can open. */}
      <div className="mt-6 grid gap-4 sm:grid-cols-4">
        <Stat label="Current month" value={currentMonth ? formatMonth(currentMonth.year, currentMonth.month) : '—'} />
        <Stat label="Active projects"
          value={String(projectRows.filter((r) => !['completed', 'cancelled'].includes(r.status)).length)} />
        <Stat label="Completed projects" value={String(projectRows.filter((r) => r.status === 'completed').length)} />
        <Stat label="Total months" value={String(months.length)} />
      </div>

      {Number.isInteger(copiedCount) && copiedCount > 0 ? (
        <p role="status" className="mt-6 rounded-md bg-accent/10 px-3 py-2 text-sm">
          Copied {copiedCount} project{copiedCount === 1 ? '' : 's'}. Each is filed as new and waits for
          the Project Manager.
        </p>
      ) : null}

      {/* §35: this month's table on top, on its own. */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold">Current month</h2>
        {overview.current ? (
          <div className="mt-3">
            <MonthCard {...cardProps} block={overview.current} isCurrent />
          </div>
        ) : (
          <div className="mt-3 rounded-lg border border-border bg-surface px-4 py-5">
            <p role="status" className="text-sm text-muted">
              {months.length === 0
                ? `No month is open for ${client.name} yet. Filing the first project opens one.`
                : `No month is open for ${client.name}. Filing a project opens one, and the earlier months are below.`}
            </p>
            {/* The same "+ Create month" Sales has in the Services card, where it is needed most (§37). */}
            {canOpenMonth ? (
              <CreateMonthForm clientId={client.id} nextMonth={nextMonth} className="mt-4 border-t border-border pt-4" />
            ) : null}
          </div>
        )}
      </section>

      {/* Months opened early for planning (§37) stay in view: they are not "previous". */}
      {overview.upcoming.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-sm font-semibold">Opened ahead</h2>
          <div className="mt-3 space-y-4">
            {overview.upcoming.map((block) => (
              <MonthCard key={block.month.id} {...cardProps} block={block} isCurrent={false} />
            ))}
          </div>
        </section>
      ) : null}

      {/* §35 "View Previous Months": folded away, server-rendered, each month with its status (§36). */}
      <details className="mt-8">
        <summary className="cursor-pointer text-sm font-semibold hover:text-accent">
          View previous months ({overview.previous.length})
        </summary>
        {overview.previous.length === 0 ? (
          <p className="mt-3 rounded-lg border border-border bg-surface px-4 py-4 text-sm text-muted">
            No previous months yet.
          </p>
        ) : (
          <div className="mt-3 space-y-4">
            {overview.previous.map((block) => (
              <MonthCard key={block.month.id} {...cardProps} block={block} isCurrent={false} />
            ))}
          </div>
        )}
      </details>

      <ClientPanels
        clientId={client.id}
        canManage={owned && can(actor, 'clients.manage')}
        canOpenMonth={canOpenMonth}
        nextMonth={nextMonth}
        contacts={contacts.map((c) => ({ ...c, id: Number(c.id) }))}
        services={services.map((s) => Number(s.department_id))}
        departments={allDepartments}
        notes={client.notes}
      />

      {portalLogins ? (
        <PortalPanel clientId={client.id} logins={portalLogins} autoDeliver={client.portal_auto_deliver === true} />
      ) : null}
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
