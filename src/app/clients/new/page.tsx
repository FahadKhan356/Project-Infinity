import Link from 'next/link';
import { requireActor } from '@/lib/auth/dal';
import { AccessDenied } from '@/components/access-denied';
import { AppShell } from '@/components/app-shell';
import { can } from '@/lib/authz';
import { NewClientForm } from './new-client-form';

export default async function NewClientPage(props: PageProps<'/clients/new'>) {
  const actor = await requireActor();
  if (!can(actor, 'clients.manage')) {
    return (
      <AppShell actor={actor}>
        <AccessDenied what="creating clients" />
      </AppShell>
    );
  }

  return (
    <AppShell actor={actor}>
      <Link href="/clients" className="text-sm text-muted hover:text-foreground">← Clients</Link>
      <h1 className="mt-2 text-lg font-semibold tracking-tight">Add client</h1>
      <p className="mt-1 max-w-prose text-sm text-muted">
        A client is a permanent record. Every month and every project stays attached to it, so
        check whether they already exist before creating a new one.
      </p>
      <div className="mt-6 max-w-md">
        <NewClientForm prospect={(await props.searchParams).prospect === '1'} />
      </div>
    </AppShell>
  );
}
