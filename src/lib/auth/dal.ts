import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { and, eq, gt } from 'drizzle-orm';
import { getDb } from '@/db';
import { departmentMembers, sessions, userPermissions, users } from '@/db/schema';
import type { Actor, Permission, Role } from '@/lib/authz';
import { readSessionToken } from './session';

/**
 * The data access layer. Every page, server action and route handler resolves
 * the current user through here — the proxy's cookie check is optimistic only
 * and is never the thing that grants access.
 *
 * Memoised per render pass, so a page and its layouts share one query.
 */
export const getActor = cache(async (): Promise<Actor | null> => {
  const token = await readSessionToken();
  if (!token) return null;

  const db = getDb();

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      isActive: users.isActive,
      mustChangePassword: users.mustChangePassword,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, token), gt(sessions.expiresAt, new Date())))
    .limit(1);

  const user = rows[0];
  // A deactivated user's session stops working immediately, without waiting
  // for the cookie to expire.
  if (!user || !user.isActive) return null;

  const [memberships, grants] = await Promise.all([
    db
      .select({ departmentId: departmentMembers.departmentId, isLead: departmentMembers.isLead })
      .from(departmentMembers)
      .where(eq(departmentMembers.userId, user.id)),
    db
      .select({ permission: userPermissions.permission })
      .from(userPermissions)
      .where(eq(userPermissions.userId, user.id)),
  ]);

  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role as Role,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    departmentIds: memberships.map((m) => m.departmentId),
    leadDepartmentIds: memberships.filter((m) => m.isLead).map((m) => m.departmentId),
    permissions: new Set(grants.map((g) => g.permission as Permission)),
  };
});

/**
 * Use in every protected page and action. Redirects rather than throwing, so
 * an expired session lands on the login screen instead of an error page.
 */
export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (actor.mustChangePassword) redirect('/change-password');
  return actor;
}

/**
 * For the change-password screen itself, which must be reachable while the
 * must-change flag is still set.
 */
export async function requireActorAllowingPasswordChange(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect('/login');
  return actor;
}
