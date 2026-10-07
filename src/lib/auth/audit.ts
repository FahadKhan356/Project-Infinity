import 'server-only';
import { isIP } from 'node:net';
import { headers } from 'next/headers';
import { getDb } from '@/db';
import { activityLog } from '@/db/schema';

/**
 * The address the current request came from, for the record. A scheduled
 * job (or a test) has no request, and so no address; it still leaves one.
 */
export async function requestIpAddress(): Promise<string | null> {
  try {
    return forwardedAddress((await headers()).get('x-forwarded-for'));
  } catch {
    return null;
  }
}

/**
 * The first hop of an X-Forwarded-For header as an address the inet column
 * takes, or null. A proxy may write "unknown" there, or the address with
 * its port, or an IPv6 address with its zone ("fe80::1%lo0", which
 * node accepts and inet does not); bound to the column as it came, any of
 * these would fail the action being recorded, and the record is worth more
 * than where it came from.
 */
export function forwardedAddress(forwardedFor: string | null | undefined): string | null {
  const hop = forwardedFor?.split(',')[0]?.trim() ?? '';
  const withPort = /^\[([^\]]+)\]:\d+$/.exec(hop) ?? /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(hop);
  const address = (withPort ? withPort[1] : hop).replace(/%.*$/, '');
  return isIP(address) ? address : null;
}

/**
 * Append-only record of anything worth answering "who did that?" about
 * (brief §25). Failures here must never break the action being recorded, but
 * they must be visible in the server log.
 */
export async function recordActivity(entry: {
  actorId: number | null;
  action: string;
  entityType: string;
  entityId?: number | null;
  projectId?: number | null;
  clientId?: number | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await getDb().insert(activityLog).values({
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      projectId: entry.projectId ?? null,
      clientId: entry.clientId ?? null,
      metadata: entry.metadata ?? {},
      ipAddress: await requestIpAddress(),
    });
  } catch (error) {
    console.error('[audit] failed to record activity', entry.action, error);
  }
}
