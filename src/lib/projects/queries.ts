import 'server-only';
import { sql, type SQL } from 'drizzle-orm';
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

/**
 * The "number of deliverables" of brief §3 as one figure: the sum of the
 * teams' counts (project_departments.planned_deliverables). Never stored — a
 * column of its own could disagree with the teams the moment triage changed
 * one — but computed wherever it is shown: the intake queue, the projects
 * list, the project header. `alias` names the projects row of the query.
 */
export function plannedDeliverablesTotal(alias: string): SQL {
  return sql`(SELECT COALESCE(SUM(pd.planned_deliverables), 0)
                FROM project_departments pd
               WHERE pd.project_id = ${sql.identifier(alias)}.id)::int`;
}
