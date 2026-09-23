'use server';

import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { users } from '@/db/schema';
import { recordActivity } from '@/lib/auth/audit';
import { hashPassword, passwordProblem, verifyPassword } from '@/lib/auth/password';
import { requireActorAllowingPasswordChange } from '@/lib/auth/dal';
import { createSession, destroyAllSessionsFor } from '@/lib/auth/session';

export interface ChangePasswordState {
  error?: string;
}

export async function changePassword(
  _prev: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const actor = await requireActorAllowingPasswordChange();

  const current = String(formData.get('currentPassword') ?? '');
  const next = String(formData.get('newPassword') ?? '');
  const confirm = String(formData.get('confirmPassword') ?? '');

  if (next !== confirm) return { error: 'The new passwords do not match.' };

  const problem = passwordProblem(next);
  if (problem) return { error: problem };

  if (next === current) return { error: 'The new password must be different from the old one.' };

  const db = getDb();
  const [row] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, actor.id))
    .limit(1);

  if (!row || !(await verifyPassword(row.passwordHash, current))) {
    return { error: 'Your current password is not correct.' };
  }

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(next), mustChangePassword: false })
    .where(eq(users.id, actor.id));

  // Changing a password ends every other session, then issues a fresh one for
  // this browser — a stolen session cannot outlive the password it used.
  await destroyAllSessionsFor(actor.id);
  await createSession(actor.id);

  await recordActivity({
    actorId: actor.id,
    action: 'auth.password_changed',
    entityType: 'user',
    entityId: actor.id,
  });

  redirect('/dashboard');
}
