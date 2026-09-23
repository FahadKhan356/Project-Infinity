import Link from 'next/link';
import { asc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { departments } from '@/db/schema';
import { requireActor } from '@/lib/auth/dal';
import { AccessDenied } from '@/components/access-denied';
import { AppShell } from '@/components/app-shell';
import { can, clientScope } from '@/lib/authz';
import { monthOptions } from '@/lib/projects/intake';
import { NewProjectForm } from './new-project-form';

export default async function NewProjectPage(props: PageProps<'/projects/new'>) {
  const actor = await requireActor();
  if (!can(actor, 'projects.create')) {
    return (
      <AppShell actor={actor}>
        <AccessDenied what="filing projects" />
      </AppShell>
    );
  }

  const db = getDb();
  const [clientList, departmentList] = await Promise.all([
    db.execute<{ id: number; name: string; company_name: string | null }>(sql`
      SELECT c.id, c.name, c.company_name FROM clients c
      WHERE ${clientScope(actor, 'c')} ORDER BY c.name
    `),
    db.select({ id: departments.id, name: departments.name })
      .from(departments)
      .where(eq(departments.isProduction, true))
      .orderBy(asc(departments.sortOrder)),
  ]);

  const { client } = await props.searchParams;
  const preselected = Number(Array.isArray(client) ? client[0] : client);

  return (
    <AppShell actor={actor}>
      <Link href="/projects" className="text-sm text-muted hover:text-foreground">← Projects</Link>
      <h1 className="mt-2 text-lg font-semibold tracking-tight">New project</h1>
      <p className="mt-1 max-w-prose text-sm text-muted">
        Once filed, this appears in the Project Manager’s intake queue for assignment.
      </p>

      <div className="mt-6 max-w-2xl">
        <NewProjectForm
          clients={clientList.map((c) => ({
            id: Number(c.id),
            name: c.name,
            companyName: c.company_name,
          }))}
          departments={departmentList}
          months={monthOptions()}
          canSetPricing={can(actor, 'pricing.view')}
          canCreateClients={can(actor, 'clients.manage')}
          preselectedClientId={Number.isInteger(preselected) ? preselected : null}
        />
      </div>
    </AppShell>
  );
}
