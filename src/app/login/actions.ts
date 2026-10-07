'use server';

import { redirect } from 'next/navigation';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { users } from '@/db/schema';
import { recordActivity } from '@/lib/auth/audit';
import { verifyPassword } from '@/lib/auth/password';
import { clearFailedLogins, loginBlockedFor, recordFailedLogin } from '@/lib/auth/rate-limit';
import { createSession } from '@/lib/auth/session';
import { homePath } from '@/lib/dashboard/home';

export interface LoginState {
  error?: string;
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');

  if (!email || !password) {
    return { error: 'Enter your email and password.' };
  }

  const blockedSeconds = loginBlockedFor(email);
  if (blockedSeconds > 0) {
    const minutes = Math.ceil(blockedSeconds / 60);
    return { error: `Too many failed attempts. Try again in ${minutes} minute(s).` };
  }

  const db = getDb();
  const [user] = await db
    .select({
      id: users.id,
      role: users.role,
      passwordHash: users.passwordHash,
      isActive: users.isActive,
      mustChangePassword: users.mustChangePassword,
    })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);

  // One message and one code path for "no such user", "wrong password" and
  // "deactivated", so the form cannot be used to enumerate staff accounts.
  const digest = user?.passwordHash ?? FALLBACK_HASH;
  const passwordMatches = await verifyPassword(digest, password);

  if (!user || !user.isActive || !passwordMatches) {
    recordFailedLogin(email);
    await recordActivity({
      actorId: user?.id ?? null,
      action: 'auth.login_failed',
      entityType: 'user',
      entityId: user?.id ?? null,
      metadata: { email, reason: !user ? 'unknown_user' : !user.isActive ? 'inactive' : 'bad_password' },
    });
    return { error: 'Those details are not correct.' };
  }

  clearFailedLogins(email);
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await createSession(user.id);
  await recordActivity({
    actorId: user.id,
    action: 'auth.login',
    entityType: 'user',
    entityId: user.id,
  });

  // Each role has its own first page (brief §8): an Executive opens their work.
  redirect(user.mustChangePassword ? '/change-password' : homePath(user.role));
}

/**
 * A real argon2id digest of a random value. Verifying against it when the
 * account does not exist keeps the response time of a missing user close to
 * that of a wrong password.
 */
const FALLBACK_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$ciyCsT7rUwjKk51F0q49HQ$jTq+R4N36w0gi5psdFA1lxlaAxT8mdNnpB5/p6ZIWs8';
