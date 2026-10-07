import Link from 'next/link';
import { asc, sql, ne } from 'drizzle-orm';
import { getDb } from '@/db';
import { users } from '@/db/schema';
import { requireActor } from '@/lib/auth/dal';
import { AccessDenied } from '@/components/access-denied';
import { AppShell } from '@/components/app-shell';
import { can } from '@/lib/authz';

export default async function UsersPage() {
  const actor = await requireActor();
  if (!can(actor, 'users.view')) {
    return (
      <AppShell actor={actor}>
        <AccessDenied what="user administration" />
      </AppShell>
    );
  }

  const db = getDb();
  const rows = await db
    .select({
      id: users.id,
      fullName: users.fullName,
      email: users.email,
      role: users.role,
      isActive: users.isActive,
      lastLoginAt: users.lastLoginAt,
      // Written out in full: interpolating ${users.id} here renders an
      // unqualified "id", which is ambiguous against the subquery's own tables.
      teams: sql<string | null>`(
        SELECT string_agg(d.name || CASE WHEN dm.is_lead THEN ' (lead)' ELSE '' END, ', ' ORDER BY d.sort_order)
        FROM department_members dm
        JOIN departments d ON d.id = dm.department_id
        WHERE dm.user_id = users.id
      )`,
    })
    .from(users)
    // Client portal logins are managed on their client's page, not here.
    .where(ne(users.role, 'client'))
    .orderBy(asc(users.fullName));

  return (
    <AppShell actor={actor}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Users</h1>
          <p className="mt-1 text-sm text-muted">{rows.length} account(s)</p>
        </div>
        <Link
          href="/admin/users/new"
          className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white"
        >
          Add user
        </Link>
      </div>

      <div className="mt-6 overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">Name</th>
              <th className="px-4 py-2.5 font-medium">Role</th>
              <th className="px-4 py-2.5 font-medium">Teams</th>
              <th className="px-4 py-2.5 font-medium">Last login</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} className="border-b border-border last:border-0">
                <td className="px-4 py-2.5">
                  <Link href={`/admin/users/${u.id}`} className="font-medium hover:underline">
                    {u.fullName}
                  </Link>
                  <div className="text-xs text-muted">{u.email}</div>
                </td>
                <td className="px-4 py-2.5">{u.role.replace(/_/g, ' ')}</td>
                <td className="px-4 py-2.5 text-muted">{u.teams ?? '—'}</td>
                <td className="px-4 py-2.5 text-muted">
                  {u.lastLoginAt ? u.lastLoginAt.toLocaleDateString('en-GB') : 'never'}
                </td>
                <td className="px-4 py-2.5">
                  <span className={u.isActive ? 'text-accent' : 'text-muted'}>
                    {u.isActive ? 'Active' : 'Deactivated'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
