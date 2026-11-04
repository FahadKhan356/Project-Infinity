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
import { getOpportunity } from '@/lib/pipeline/opportunities';

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

  const { client, opportunity: rawOpportunity } = await props.searchParams;
  const opportunityId = Number(Array.isArray(rawOpportunity) ? rawOpportunity[0] : rawOpportunity);
  // Filing from a pipeline deal starts from what Sales already knows (brief §29).
  const opportunity = Number.isInteger(opportunityId) && opportunityId > 0
    ? await getOpportunity(actor, opportunityId) : null;
  const openDeal = opportunity && ['lead', 'qualified', 'proposal', 'negotiation'].includes(opportunity.stage)
    ? opportunity : null;
  const preselected = openDeal ? openDeal.clientId : Number(Array.isArray(client) ? client[0] : client);

  return (
    <AppShell actor={actor}>
      <Link href="/projects" className="text-sm text-muted hover:text-foreground">← Projects</Link>
      <h1 className="mt-2 text-lg font-semibold tracking-tight">New project</h1>
      <p className="mt-1 max-w-prose text-sm text-muted">
        Once filed, this appears in the Project Manager’s Project Closure Report for assignment.
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
          opportunity={openDeal ? {
            id: openDeal.id, title: openDeal.title, clientName: openDeal.clientName,
            value: can(actor, 'pricing.view') && openDeal.estimatedValue !== null ? openDeal.estimatedValue.toFixed(2) : null,
            currency: openDeal.currency,
          } : null}
        />
      </div>
    </AppShell>
  );
}
