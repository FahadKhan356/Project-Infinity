import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { describeActivity } from './describe';

export interface ActivityLine {
  id: number;
  /** ISO-8601, UTC. */
  at: string;
  actorName: string | null;
  action: string;
  text: string;
}

/**
 * The actions worth reading on a project page (brief §25). Downloads and
 * refused attempts stay in the log for an administrator's query; they would
 * only bury the decisions here.
 */
const FEED_ACTIONS = [
  'project.created', 'project.triaged', 'project.notes_updated',
  'assignment.created', 'file.uploaded', 'file.deleted',
  'qa.reviewed', 'delivery.updated', 'comment.posted',
  'revision.created', 'revision.assigned', 'revision.closed',
];

/** Oldest first, so it reads like the example in the brief. */
export async function projectActivity(projectId: number, limit = 500): Promise<ActivityLine[]> {
  const rows = await getDb().execute<{
    id: number; at: string; actor_name: string | null; action: string; metadata: Record<string, unknown>;
  }>(sql`
    SELECT al.id,
           to_char(al.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
           u.full_name AS actor_name, al.action, al.metadata
    FROM activity_log al
    LEFT JOIN users u ON u.id = al.actor_id
    WHERE al.project_id = ${projectId}
      AND al.action IN (${sql.join(FEED_ACTIONS.map((a) => sql`${a}`), sql`, `)})
    ORDER BY al.created_at, al.id
    LIMIT ${limit}
  `);

  return rows.map((r) => ({
    id: Number(r.id),
    at: r.at,
    actorName: r.actor_name,
    action: r.action,
    text: describeActivity({
      action: r.action,
      actorName: r.actor_name,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
    }),
  }));
}
