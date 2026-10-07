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
export const FEED_ACTIONS = [
  'project.created', 'project.triaged', 'project.notes_updated',
  'project.status_changed', 'project.details_edited', 'opportunity.won',
  'assignment.created', 'file.uploaded', 'file.deleted',
  'qa.reviewed', 'delivery.received', 'delivery.updated', 'delivery.client_decision', 'comment.posted',
  'revision.created', 'revision.assigned', 'revision.closed',
  // Who was given read access, and when it was taken back (§23, §25).
  'project.shared', 'project.unshared',
];

/** A log row as the feed queries read it (a type, not an interface, so it satisfies execute<T>). */
export type ActivityRow = {
  id: number;
  at: string;
  actor_name: string | null;
  action: string;
  metadata: Record<string, unknown> | null;
};

/**
 * Turns log rows into feed lines. A price change is not news to someone who
 * cannot see the price (§23): the field is dropped, and the line with it
 * when nothing else changed. Shared with the month view (lib/reports).
 */
export function toActivityLines(rows: ActivityRow[], opts: { showPricing?: boolean } = {}): ActivityLine[] {
  const lines: ActivityLine[] = [];
  for (const r of rows) {
    let metadata = (r.metadata ?? {}) as Record<string, unknown>;
    if (r.action === 'project.details_edited' && !opts.showPricing && Array.isArray(metadata.fields)) {
      const fields = metadata.fields.filter((f) => f !== 'price');
      if (fields.length === 0) continue;
      metadata = { ...metadata, fields };
    }
    lines.push({
      id: Number(r.id),
      at: r.at,
      actorName: r.actor_name,
      action: r.action,
      text: describeActivity({ action: r.action, actorName: r.actor_name, metadata }),
    });
  }
  return lines;
}

/**
 * Oldest first, so it reads like the example in the brief. The limit trims
 * the *start* of a long history: what a reader needs is what happened
 * lately, so the newest rows are fetched and then put back in order.
 */
export async function projectActivity(
  projectId: number,
  opts: { showPricing?: boolean; limit?: number } = {},
): Promise<ActivityLine[]> {
  const limit = opts.limit ?? 500;
  const rows = await getDb().execute<ActivityRow>(sql`
    SELECT * FROM (
      SELECT al.id,
             to_char(al.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
             u.full_name AS actor_name, al.action, al.metadata, al.created_at
      FROM activity_log al
      LEFT JOIN users u ON u.id = al.actor_id
      WHERE al.project_id = ${projectId}
        AND al.action IN (${sql.join(FEED_ACTIONS.map((a) => sql`${a}`), sql`, `)})
      ORDER BY al.created_at DESC, al.id DESC
      LIMIT ${limit}
    ) newest
    ORDER BY created_at, id
  `);
  return toActivityLines(rows, opts);
}
