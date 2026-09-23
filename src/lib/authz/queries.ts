import 'server-only';
import { sql } from 'drizzle-orm';
import type { getDb } from '@/db';
import { projectScope } from './scope';
import type { Actor } from './types';

type Db = ReturnType<typeof getDb>;

/**
 * Is this project within the actor's scope?
 *
 * Deliberately built on the same projectScope() used by every list query, so
 * a single rule governs both "what appears in a list" and "what can be fetched
 * directly by URL". If these ever diverge, object references become a way to
 * read past the policy.
 */
export async function isProjectVisible(
  db: Db,
  actor: Actor,
  projectId: number,
): Promise<boolean> {
  const rows = await db.execute<{ ok: number }>(
    sql`SELECT 1 AS ok FROM projects WHERE projects.id = ${projectId} AND ${projectScope(actor)} LIMIT 1`,
  );
  return rows.length > 0;
}
