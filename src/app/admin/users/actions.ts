'use server';

import { randomBytes } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { departmentMembers, userPermissions, users } from '@/db/schema';
import { recordActivity } from '@/lib/auth/audit';
import { requireActor } from '@/lib/auth/dal';
import { hashPassword, passwordProblem } from '@/lib/auth/password';
import { destroyAllSessionsFor } from '@/lib/auth/session';
import { assertCan, type Permission, type Role } from '@/lib/authz';

const ROLES: Role[] = ['ceo', 'coo', 'admin', 'sales', 'project_manager', 'team_lead', 'executive'];
const PERMISSIONS: Permission[] = [
  'view_pricing', 'manage_users', 'close_month', 'reopen_month',
  'delete_files', 'export_reports', 'view_all_clients',
];

export interface FormState {
  error?: string;
  notice?: string;
  temporaryPassword?: string;
}

export async function createUser(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor();
  assertCan(actor, 'users.manage');

  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const fullName = String(formData.get('fullName') ?? '').trim();
  const role = String(formData.get('role') ?? '') as Role;
  const password = String(formData.get('password') ?? '');

  if (!email.includes('@')) return { error: 'Enter a valid email address.' };
  if (!fullName) return { error: 'Enter the person’s name.' };
  if (!ROLES.includes(role)) return { error: 'Choose a role.' };

  const problem = passwordProblem(password);
  if (problem) return { error: problem };

  const db = getDb();
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  if (existing.length > 0) return { error: 'A user with that email already exists.' };

  const [created] = await db
    .insert(users)
    .values({
      email,
      fullName,
      role,
      passwordHash: await hashPassword(password),
      mustChangePassword: true,
    })
    .returning({ id: users.id });

  await recordActivity({
    actorId: actor.id,
    action: 'user.created',
    entityType: 'user',
    entityId: created.id,
    metadata: { email, role },
  });

  revalidatePath('/admin/users');
  return { notice: `Created ${fullName}. They must change this password at first login.` };
}

export async function updateUser(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor();
  assertCan(actor, 'users.manage');

  const userId = Number(formData.get('userId'));
  const fullName = String(formData.get('fullName') ?? '').trim();
  const role = String(formData.get('role') ?? '') as Role;
  const isActive = formData.get('isActive') === 'on';

  if (!Number.isInteger(userId)) return { error: 'Unknown user.' };
  if (!fullName) return { error: 'Enter the person’s name.' };
  if (!ROLES.includes(role)) return { error: 'Choose a role.' };

  // Guard against locking the last administrator out of their own portal.
  if (userId === actor.id && !isActive) {
    return { error: 'You cannot deactivate your own account.' };
  }
  if (userId === actor.id && role !== actor.role) {
    return { error: 'You cannot change your own role. Ask another administrator.' };
  }

  const db = getDb();
  await db.update(users).set({ fullName, role, isActive }).where(eq(users.id, userId));

  // A deactivated or demoted user must lose access immediately, not when their
  // cookie happens to expire.
  if (!isActive) await destroyAllSessionsFor(userId);

  await recordActivity({
    actorId: actor.id,
    action: 'user.updated',
    entityType: 'user',
    entityId: userId,
    metadata: { role, isActive },
  });

  revalidatePath(`/admin/users/${userId}`);
  revalidatePath('/admin/users');
  return { notice: 'Saved.' };
}

export async function setDepartments(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor();
  assertCan(actor, 'users.manage');

  const userId = Number(formData.get('userId'));
  if (!Number.isInteger(userId)) return { error: 'Unknown user.' };

  const memberOf = formData.getAll('department').map(Number).filter(Number.isInteger);
  const leadOf = formData.getAll('lead').map(Number).filter(Number.isInteger);

  // Leading a department implies belonging to it.
  const all = new Set([...memberOf, ...leadOf]);

  const db = getDb();
  await db.delete(departmentMembers).where(eq(departmentMembers.userId, userId));
  if (all.size > 0) {
    await db.insert(departmentMembers).values(
      [...all].map((departmentId) => ({
        userId,
        departmentId,
        isLead: leadOf.includes(departmentId),
      })),
    );
  }

  await recordActivity({
    actorId: actor.id,
    action: 'user.departments_changed',
    entityType: 'user',
    entityId: userId,
    metadata: { memberOf: [...all], leadOf },
  });

  revalidatePath(`/admin/users/${userId}`);
  return { notice: 'Team membership updated.' };
}

export async function setPermissions(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor();
  assertCan(actor, 'users.manage');

  const userId = Number(formData.get('userId'));
  if (!Number.isInteger(userId)) return { error: 'Unknown user.' };

  const granted = formData
    .getAll('permission')
    .map(String)
    .filter((p): p is Permission => PERMISSIONS.includes(p as Permission));

  // Do not let an administrator revoke their own ability to administer.
  if (userId === actor.id && !granted.includes('manage_users') && actor.role !== 'ceo' && actor.role !== 'coo' && actor.role !== 'admin') {
    return { error: 'You cannot remove your own user-management permission.' };
  }

  const db = getDb();
  await db.delete(userPermissions).where(eq(userPermissions.userId, userId));
  if (granted.length > 0) {
    await db.insert(userPermissions).values(
      granted.map((permission) => ({ userId, permission, grantedBy: actor.id })),
    );
  }

  await recordActivity({
    actorId: actor.id,
    action: 'user.permissions_changed',
    entityType: 'user',
    entityId: userId,
    metadata: { granted },
  });

  revalidatePath(`/admin/users/${userId}`);
  return { notice: 'Permissions updated.' };
}

export async function resetPassword(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor();
  assertCan(actor, 'users.manage');

  const userId = Number(formData.get('userId'));
  if (!Number.isInteger(userId)) return { error: 'Unknown user.' };

  // 18 bytes of base64url: comfortably above the 12-character policy and
  // readable enough to hand over in person.
  const temporary = randomBytes(18).toString('base64url');

  const db = getDb();
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(temporary), mustChangePassword: true })
    .where(eq(users.id, userId));
  await destroyAllSessionsFor(userId);

  await recordActivity({
    actorId: actor.id,
    action: 'user.password_reset',
    entityType: 'user',
    entityId: userId,
  });

  revalidatePath(`/admin/users/${userId}`);
  return {
    temporaryPassword: temporary,
    notice: 'Password reset. Give this to them directly — it is shown only once.',
  };
}

/** Used by the edit page to render current state. */
export async function loadUserDetail(userId: number) {
  const actor = await requireActor();
  assertCan(actor, 'users.view');

  const db = getDb();
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      isActive: users.isActive,
      mustChangePassword: users.mustChangePassword,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) return null;

  const [memberships, grants] = await Promise.all([
    db
      .select({ departmentId: departmentMembers.departmentId, isLead: departmentMembers.isLead })
      .from(departmentMembers)
      .where(eq(departmentMembers.userId, userId)),
    db
      .select({ permission: userPermissions.permission })
      .from(userPermissions)
      .where(and(eq(userPermissions.userId, userId))),
  ]);

  return { user, memberships, grants: grants.map((g) => g.permission) };
}
