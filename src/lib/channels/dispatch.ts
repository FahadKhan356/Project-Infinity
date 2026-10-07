import { sql } from 'drizzle-orm';
import type { getDb } from '@/db';
import type { Channel } from './config';
import type { Sender } from './senders';

type Db = ReturnType<typeof getDb>;

export const MAX_ATTEMPTS = 5;
/** Notifications older than this are not sent outwards: stale news is noise. */
export const FRESH_HOURS = 48;

export interface DispatchResult {
  queued: number;
  sent: number;
  retrying: number;
  failed: number;
}

/**
 * Sends inbox notifications out over the connected channels (brief §29).
 *
 *   1. queue — every fresh notification for someone who opted in to a
 *      connected channel gets one dispatch row per channel (idempotent);
 *      only notifications created after they opted in, so switching a
 *      channel on does not replay the past.
 *   2. claim — due rows are leased for ten minutes, so two dispatchers never
 *      send the same copy.
 *   3. send — success is recorded; a failure is retried with backoff (2, 4,
 *      8, 16 minutes) and given up after MAX_ATTEMPTS.
 *
 * Senders are passed in, so this is tested without any real service.
 */
export async function dispatchDue(
  db: Db,
  senders: Partial<Record<Channel, Sender>>,
  opts: { baseUrl: string; limit?: number },
): Promise<DispatchResult> {
  const channels = Object.keys(senders) as Channel[];
  const result: DispatchResult = { queued: 0, sent: 0, retrying: 0, failed: 0 };
  if (channels.length === 0) return result;
  const channelList = sql.join(channels.map((c) => sql`${c}`), sql`, `);

  const queued = await db.execute<{ notification_id: number }>(sql`
    INSERT INTO notification_dispatches (notification_id, channel)
    SELECT n.id, p.channel
    FROM notifications n
    JOIN user_channel_prefs p ON p.user_id = n.user_id AND p.enabled
    JOIN users u ON u.id = n.user_id AND u.is_active
    WHERE p.channel IN (${channelList})
      AND n.created_at > now() - make_interval(hours => ${FRESH_HOURS})
      AND n.created_at >= p.updated_at
    ON CONFLICT DO NOTHING
    RETURNING notification_id
  `);
  result.queued = queued.length;

  // Someone who switched a channel off since a copy was queued does not get it.
  await db.execute(sql`
    UPDATE notification_dispatches d SET status = 'failed', last_error = 'Channel switched off.'
    FROM notifications n
    WHERE n.id = d.notification_id AND d.status = 'pending'
      AND NOT EXISTS (SELECT 1 FROM user_channel_prefs p
                      WHERE p.user_id = n.user_id AND p.channel = d.channel AND p.enabled)
  `);

  const due = await db.execute<{
    notification_id: number; channel: Channel; attempts: number;
    title: string; body: string | null; link_path: string | null; email: string; address: string | null;
  }>(sql`
    WITH claimed AS (
      SELECT d.notification_id, d.channel FROM notification_dispatches d
      WHERE d.status = 'pending' AND d.next_attempt_at <= now() AND d.channel IN (${channelList})
      ORDER BY d.next_attempt_at
      LIMIT ${opts.limit ?? 100}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE notification_dispatches d
    SET next_attempt_at = now() + interval '10 minutes'
    FROM claimed c, notifications n, users u, user_channel_prefs p
    WHERE d.notification_id = c.notification_id AND d.channel = c.channel
      AND n.id = d.notification_id AND u.id = n.user_id
      AND p.user_id = u.id AND p.channel = d.channel
    RETURNING d.notification_id, d.channel, d.attempts, n.title, n.body, n.link_path, u.email, p.address
  `);

  for (const row of due) {
    const send = senders[row.channel]!;
    const to = row.channel === 'email' ? (row.address || row.email) : row.address;
    try {
      if (!to) throw new Error('No address on file.');
      await send(to, {
        title: row.title,
        body: row.body,
        link: row.link_path && opts.baseUrl ? `${opts.baseUrl}${row.link_path}` : null,
      });
      await db.execute(sql`
        UPDATE notification_dispatches
        SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL
        WHERE notification_id = ${row.notification_id} AND channel = ${row.channel}
      `);
      result.sent++;
    } catch (error) {
      const attempts = Number(row.attempts) + 1;
      const giveUp = attempts >= MAX_ATTEMPTS;
      await db.execute(sql`
        UPDATE notification_dispatches
        SET attempts = ${attempts}, last_error = ${String((error as Error).message ?? error).slice(0, 500)},
            status = ${giveUp ? 'failed' : 'pending'},
            next_attempt_at = now() + make_interval(mins => ${2 ** attempts})
        WHERE notification_id = ${row.notification_id} AND channel = ${row.channel}
      `);
      if (giveUp) result.failed++;
      else result.retrying++;
    }
  }
  return result;
}
