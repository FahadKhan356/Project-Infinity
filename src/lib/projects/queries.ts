import 'server-only';
import { sql } from 'drizzle-orm';
import type { getDb } from '@/db';
import { clientScope } from '@/lib/authz';
import type { Actor } from '@/lib/authz';

type Db = ReturnType<typeof getDb>;

/** Same rule as the client list — never a separate one. */
export async function isClientVisible(db: Db, actor: Actor, clientId: number): Promise<boolean> {
  const rows = await db.execute<{ ok: number }>(
    sql`SELECT 1 AS ok FROM clients WHERE clients.id = ${clientId} AND ${clientScope(actor)} LIMIT 1`,
  );
  return rows.length > 0;
}
