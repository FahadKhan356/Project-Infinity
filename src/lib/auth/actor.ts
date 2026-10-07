import 'server-only';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { departmentMembers, userPermissions, users } from '@/db/schema';
import type { Actor, Permission, Role } from '@/lib/authz';

type ActorUser = Pick<Actor, 'id' | 'email' | 'fullName' | 'isActive' | 'mustChangePassword'> & {
  role: string;
  clientId: number | null;
};

export async function actorFor(user: ActorUser): Promise<Actor> {
  const db = getDb();
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
    clientId: user.clientId,
  };
}

/**
 * The Actor for a user outside any request — a scheduled job acting on
 * someone's behalf. Carries the same permissions they would have signed in,
 * so a job can never do more than its user could. Null if there is no such
 * user; an inactive one comes back with isActive false and can do nothing.
 */
export async function loadActorById(userId: number): Promise<Actor | null> {
  const [user] = await getDb()
    .select({
      id: users.id, email: users.email, fullName: users.fullName, role: users.role,
      isActive: users.isActive, mustChangePassword: users.mustChangePassword, clientId: users.clientId,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user ? actorFor(user) : null;
}
