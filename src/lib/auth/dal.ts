import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { and, eq, gt } from 'drizzle-orm';
import { getDb } from '@/db';
import { sessions, users } from '@/db/schema';
import type { Actor } from '@/lib/authz';
import { readSessionToken } from './session';
import { actorFor } from './actor';

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
      clientId: users.clientId,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, token), gt(sessions.expiresAt, new Date())))
    .limit(1);

  const user = rows[0];
  // A deactivated user's session stops working immediately, without waiting
  // for the cookie to expire.
  if (!user || !user.isActive) return null;

  return actorFor(user);
});

/**
 * Use in every protected page and action. Redirects rather than throwing, so
 * an expired session lands on the login screen instead of an error page.
 */
export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (actor.mustChangePassword) redirect('/change-password');
  // Every internal page and server action comes through here. A client
  // login never gets past it: its whole world is /portal (brief §29).
  if (actor.role === 'client') redirect('/portal');
  return actor;
}

/** For /portal: a signed-in client login with its client, or away. */
export async function requireClientActor(): Promise<Actor & { clientId: number }> {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (actor.mustChangePassword) redirect('/change-password');
  if (actor.role !== 'client' || !actor.clientId) redirect('/dashboard');
  return actor as Actor & { clientId: number };
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

