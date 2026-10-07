import Link from 'next/link';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { can, clientScope } from '@/lib/authz';
import { EditClientForm } from './edit-client-form';

export default async function EditClientPage(props: PageProps<'/clients/[id]/edit'>) {
  const actor = await requireActor();
  const { id } = await props.params;
  const clientId = Number(id);
  if (!Number.isInteger(clientId) || !can(actor, 'clients.manage')) notFound();

  const db = getDb();
  const [client] = await db.execute<{
    id: number; name: string; company_name: string | null; status: string; client_type: string;
    started_on: string | null; notes: string | null; owner_user_id: number | null;
  }>(sql`
    SELECT c.id, c.name, c.company_name, c.status::text AS status, c.client_type::text AS client_type,
           c.started_on::text AS started_on, c.notes, c.owner_user_id
    FROM clients c
    WHERE c.id = ${clientId} AND ${clientScope(actor, 'c')}
  `);
  if (!client) notFound();

  // Moving a client between reps changes who can see it, so only those who
  // see every client are offered the choice.
  const canReassign = can(actor, 'clients.viewAll');
  const reps = canReassign
    ? await db.execute<{ id: number; full_name: string }>(sql`
        SELECT id, full_name FROM users
        WHERE role = 'sales' AND (is_active OR id = ${client.owner_user_id})
        ORDER BY full_name
      `)
    : [];

  return (
    <AppShell actor={actor}>
      <Link href={`/clients/${client.id}`} className="text-sm text-muted hover:text-foreground">← {client.name}</Link>
      <h1 className="mt-2 text-lg font-semibold tracking-tight">Edit client</h1>
      <p className="mt-1 text-sm text-muted">
        The permanent record every month and project hangs off (brief §31). Contacts and services
        are edited on the client page.
      </p>
      <div className="mt-6 max-w-2xl">
        <EditClientForm
          client={{
            id: Number(client.id),
            name: client.name,
            companyName: client.company_name,
            status: client.status,
            clientType: client.client_type,
            startedOn: client.started_on,
            notes: client.notes,
            ownerUserId: client.owner_user_id === null ? null : Number(client.owner_user_id),
          }}
          reps={canReassign ? reps.map((r) => ({ id: Number(r.id), name: r.full_name })) : null}
        />
      </div>
    </AppShell>
  );
}
