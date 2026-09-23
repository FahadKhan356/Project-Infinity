import 'server-only';
import { headers } from 'next/headers';
import { getDb } from '@/db';
import { activityLog } from '@/db/schema';

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
    const headerList = await headers();
    const forwardedFor = headerList.get('x-forwarded-for');

    await getDb().insert(activityLog).values({
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      projectId: entry.projectId ?? null,
      clientId: entry.clientId ?? null,
      metadata: entry.metadata ?? {},
      ipAddress: forwardedFor?.split(',')[0]?.trim() || null,
    });
  } catch (error) {
    console.error('[audit] failed to record activity', entry.action, error);
  }
}
