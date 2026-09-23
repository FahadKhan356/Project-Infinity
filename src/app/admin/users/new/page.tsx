import Link from 'next/link';
import { requireActor } from '@/lib/auth/dal';
import { AccessDenied } from '@/components/access-denied';
import { AppShell } from '@/components/app-shell';
import { can } from '@/lib/authz';
import { NewUserForm } from './new-user-form';

export default async function NewUserPage() {
  const actor = await requireActor();
  if (!can(actor, 'users.manage')) {
    return (
      <AppShell actor={actor}>
        <AccessDenied what="creating users" />
      </AppShell>
    );
  }

  return (
    <AppShell actor={actor}>
      <Link href="/admin/users" className="text-sm text-muted hover:text-foreground">
        ← Users
      </Link>
      <h1 className="mt-2 text-lg font-semibold tracking-tight">Add user</h1>
      <p className="mt-1 text-sm text-muted">
        Set a temporary password. They will be required to change it at first login.
      </p>
      <div className="mt-6 max-w-md">
        <NewUserForm />
      </div>
    </AppShell>
  );
}
