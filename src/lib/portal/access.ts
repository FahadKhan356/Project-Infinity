import 'server-only';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { hashPassword } from '@/lib/auth/password';
import { destroyAllSessionsFor } from '@/lib/auth/session';
import type { Actor } from '@/lib/authz';
import { can } from '@/lib/authz';
import { isClientVisible } from '@/lib/projects/queries';

export class PortalAccessError extends Error {}

/**
 * Who at a client may sign in to the portal (brief §29, client login), and
 * whether their files are delivered there automatically. Managed from the
 * client page by whoever manages the client — Sales for their own, and
 * management — not by user administration, because a client login belongs
 * to a client, not to a department.
 */
async function assertManages(actor: Actor, clientId: number) {
  if (!can(actor, 'clients.manage')) throw new PortalAccessError('You are not permitted to manage portal access.');
  if (!(await isClientVisible(getDb(), actor, clientId))) throw new PortalAccessError('Unknown client.');
}

const temporaryPassword = () => randomBytes(18).toString('base64url');

export interface PortalLogin {
  id: number;
  fullName: string;
  email: string;
  isActive: boolean;
  lastLoginAt: string | null;
}

export async function listPortalLogins(actor: Actor, clientId: number): Promise<PortalLogin[] | null> {
  if (!can(actor, 'clients.manage') || !(await isClientVisible(getDb(), actor, clientId))) return null;
  const rows = await getDb().execute<{
    id: number; full_name: string; email: string; is_active: boolean; last_login_at: string | null;
  }>(sql`
    SELECT id, full_name, email, is_active,
           to_char(last_login_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS last_login_at
    FROM users WHERE role = 'client' AND client_id = ${clientId}
    ORDER BY is_active DESC, full_name
  `);
  return rows.map((r) => ({
    id: Number(r.id), fullName: r.full_name, email: r.email, isActive: r.is_active === true, lastLoginAt: r.last_login_at,
  }));
}

/** Creates a login and returns its one-time password, to be handed over directly. */
export async function createPortalLogin(
  actor: Actor,
  input: { clientId: number; fullName: string; email: string },
): Promise<{ userId: number; temporaryPassword: string }> {
  await assertManages(actor, input.clientId);
  const email = input.email.trim().toLowerCase();
  const fullName = input.fullName.trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new PortalAccessError('Enter a valid email address.');
  if (!fullName) throw new PortalAccessError('Enter the person’s name.');
  const db = getDb();
  const [existing] = await db.execute<{ id: number }>(sql`SELECT id FROM users WHERE lower(email) = ${email}`);
  if (existing) throw new PortalAccessError('Someone already signs in with that email.');
  const password = temporaryPassword();
  const [row] = await db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, full_name, role, client_id, must_change_password)
    VALUES (${email}, ${await hashPassword(password)}, ${fullName}, 'client', ${input.clientId}, true)
    RETURNING id
  `);
  return { userId: Number(row.id), temporaryPassword: password };
}

async function loadLogin(actor: Actor, userId: number): Promise<{ clientId: number }> {
  const [row] = await getDb().execute<{ client_id: number }>(sql`
    SELECT client_id FROM users WHERE id = ${userId} AND role = 'client'
  `);
  if (!row) throw new PortalAccessError('Unknown login.');
  await assertManages(actor, Number(row.client_id));
  return { clientId: Number(row.client_id) };
}

export async function setPortalLoginActive(
  actor: Actor,
  input: { userId: number; active: boolean },
): Promise<{ clientId: number }> {
  const login = await loadLogin(actor, input.userId);
  await getDb().execute(sql`
    UPDATE users SET is_active = ${input.active},
           deactivated_at = ${input.active ? null : sql`now()`}
    WHERE id = ${input.userId}
  `);
  if (!input.active) await destroyAllSessionsFor(input.userId);
  return login;
}

export async function resetPortalPassword(
  actor: Actor,
  userId: number,
): Promise<{ clientId: number; temporaryPassword: string }> {
  const login = await loadLogin(actor, userId);
  const password = temporaryPassword();
  await getDb().execute(sql`
    UPDATE users SET password_hash = ${await hashPassword(password)}, must_change_password = true WHERE id = ${userId}
  `);
  await destroyAllSessionsFor(userId);
  return { ...login, temporaryPassword: password };
}

export async function setAutoDeliver(actor: Actor, input: { clientId: number; on: boolean }): Promise<void> {
  await assertManages(actor, input.clientId);
  await getDb().execute(sql`UPDATE clients SET portal_auto_deliver = ${input.on} WHERE id = ${input.clientId}`);
}
