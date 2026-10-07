import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { addressProblem, CHANNELS, connectedChannels, type Channel } from './config';

export class ChannelPrefError extends Error {}

export interface ChannelPref {
  channel: Channel;
  enabled: boolean;
  address: string | null;
  /** The most recent failure, so a wrong number does not fail silently. */
  lastError: string | null;
}

/** One's own channel settings, for the channels that are connected. */
export async function myChannelPrefs(actor: Actor): Promise<ChannelPref[]> {
  const connected = connectedChannels();
  if (connected.length === 0) return [];
  const rows = await getDb().execute<{ channel: Channel; enabled: boolean; address: string | null; last_error: string | null }>(sql`
    SELECT p.channel, p.enabled, p.address,
           (SELECT d.last_error FROM notification_dispatches d JOIN notifications n ON n.id = d.notification_id
             WHERE n.user_id = p.user_id AND d.channel = p.channel AND d.last_error IS NOT NULL
               AND d.created_at > now() - interval '7 days'
             ORDER BY d.created_at DESC LIMIT 1) AS last_error
    FROM user_channel_prefs p WHERE p.user_id = ${actor.id}
  `);
  return connected.map((channel) => {
    const r = rows.find((x) => x.channel === channel);
    return { channel, enabled: r?.enabled === true, address: r?.address ?? null, lastError: r?.last_error ?? null };
  });
}

/** Everyone sets their own; a client portal login may use email only. */
export async function setChannelPref(
  actor: Actor,
  input: { channel: Channel; enabled: boolean; address: string | null },
): Promise<void> {
  if (!actor.isActive) throw new ChannelPrefError('Your account is inactive.');
  if (!CHANNELS.includes(input.channel) || !connectedChannels().includes(input.channel)) {
    throw new ChannelPrefError('That channel is not connected.');
  }
  if (actor.role === 'client' && input.channel !== 'email') throw new ChannelPrefError('That channel is not available.');
  const address = input.address?.trim() || null;
  if (input.enabled) {
    const problem = addressProblem(input.channel, address);
    if (problem) throw new ChannelPrefError(problem);
  }
  await getDb().execute(sql`
    INSERT INTO user_channel_prefs (user_id, channel, enabled, address, updated_at)
    VALUES (${actor.id}, ${input.channel}, ${input.enabled}, ${address}, now())
    ON CONFLICT (user_id, channel) DO UPDATE
      SET enabled = EXCLUDED.enabled, address = EXCLUDED.address, updated_at = now()
  `);
}
