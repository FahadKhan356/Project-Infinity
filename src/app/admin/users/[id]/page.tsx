import Link from 'next/link';
import { notFound } from 'next/navigation';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { departments } from '@/db/schema';
import { requireActor } from '@/lib/auth/dal';
import { AccessDenied } from '@/components/access-denied';
import { AppShell } from '@/components/app-shell';
import { can } from '@/lib/authz';
import { loadUserDetail } from '../actions';
import { EditUserForms } from './edit-user-forms';

export default async function UserDetailPage(props: PageProps<'/admin/users/[id]'>) {
  const actor = await requireActor();
  if (!can(actor, 'users.view')) {
    return (
      <AppShell actor={actor}>
        <AccessDenied what="user administration" />
      </AppShell>
    );
  }

  const { id } = await props.params;
  const userId = Number(id);
  if (!Number.isInteger(userId)) notFound();

  const detail = await loadUserDetail(userId);
  if (!detail) notFound();

  const allDepartments = await getDb()
    .select({ id: departments.id, name: departments.name, isProduction: departments.isProduction })
    .from(departments)
    .where(eq(departments.isActive, true))
    .orderBy(asc(departments.sortOrder));

  return (
    <AppShell actor={actor}>
      <Link href="/admin/users" className="text-sm text-muted hover:text-foreground">
        ← Users
      </Link>
      <h1 className="mt-2 text-lg font-semibold tracking-tight">{detail.user.fullName}</h1>
      <p className="mt-1 text-sm text-muted">
        {detail.user.email}
        {detail.user.mustChangePassword ? ' · must change password at next login' : ''}
      </p>

      <EditUserForms
        canManage={actor.role === 'ceo' || actor.role === 'coo' || actor.role === 'admin' || actor.permissions.has('manage_users')}
        isSelf={actor.id === detail.user.id}
        user={detail.user}
        memberships={detail.memberships}
        grants={detail.grants}
        departments={allDepartments}
      />
    </AppShell>
  );
}
