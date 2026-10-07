import 'server-only';
import { sql } from 'drizzle-orm';
import type { getDb } from '@/db';
import { projectScope, type ScopeOptions } from './scope';
import type { Actor } from './types';

type Db = ReturnType<typeof getDb>;

/**
 * Is this project within the actor's scope?
 *
 * Deliberately built on the same projectScope() used by every list query, so
 * a single rule governs both "what appears in a list" and "what can be fetched
 * directly by URL". If these ever diverge, object references become a way to
 * read past the policy.
 *
 * By default this answers "may this actor act on the project". A read-only
 * view passes `{ shared: true }` so a project shared with a rep to view
 * counts too (§23); nothing that changes the project may.
 */
export async function isProjectVisible(
  db: Db,
  actor: Actor,
  projectId: number,
  options: ScopeOptions = {},
): Promise<boolean> {
  const rows = await db.execute<{ ok: number }>(
    sql`SELECT 1 AS ok FROM projects WHERE projects.id = ${projectId} AND ${projectScope(actor, 'projects', options)} LIMIT 1`,
  );
  return rows.length > 0;
}
