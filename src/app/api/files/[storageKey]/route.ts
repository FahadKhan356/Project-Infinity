import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { files } from '@/db/schema';
import { recordActivity } from '@/lib/auth/audit';
import { can } from '@/lib/authz';
import { decideFileAccess, loadFileContext } from '@/lib/files/access';
import { errorResponse, isResponse, requireApiActor } from '@/lib/files/api';
import { absolutePath, contentDisposition } from '@/lib/files/storage';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The only way bytes leave the server (brief §43).
 *
 * There is no static route to the file store, so browsing the server's shares
 * is not an alternative path to the same data. Every hit — allowed or refused
 * — is written to the activity log.
 */
export async function GET(request: Request, ctx: RouteContext<'/api/files/[storageKey]'>) {
  const actor = await requireApiActor();
  if (isResponse(actor)) return actor;

  try {
    const { storageKey } = await ctx.params;
    if (!UUID_RE.test(storageKey)) {
      return Response.json({ error: 'Not found.' }, { status: 404 });
    }

    const file = await loadFileContext(storageKey);
    if (!file) {
      await recordActivity({
        actorId: actor.id,
        action: 'file.download_denied',
        entityType: 'file',
        metadata: { storageKey, reason: 'not_found' },
      });
      return Response.json({ error: 'Not found.' }, { status: 404 });
    }

    const decision = await decideFileAccess(actor, file);
    if (!decision.allowed) {
      await recordActivity({
        actorId: actor.id,
        action: 'file.download_denied',
        entityType: 'file',
        entityId: file.fileId,
        projectId: file.projectId,
        metadata: { storageKey, reason: decision.reason },
      });
      // Indistinguishable from a file that does not exist, so the endpoint
      // cannot be used to probe for other departments' work.
      return Response.json({ error: 'Not found.' }, { status: 404 });
    }

    const absolute = absolutePath(file.storagePath);
    const size = file.sizeBytes;
    const range = parseRange(request.headers.get('range'), size);

    if (range === 'invalid') {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      });
    }

    await recordActivity({
      actorId: actor.id,
      action: 'file.downloaded',
      entityType: 'file',
      entityId: file.fileId,
      projectId: file.projectId,
      metadata: {
        storageKey,
        deliverableId: file.deliverableId,
        partial: range !== null,
        ...(range ? { start: range.start, end: range.end } : {}),
      },
    });

    const headers = new Headers({
      'Content-Type': file.mimeType || 'application/octet-stream',
      'Content-Disposition': contentDisposition(file.originalFilename),
      // Files are permission-gated, so no shared cache may hold them.
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      // Range support is what makes previewing a multi-gigabyte master usable.
      'Accept-Ranges': 'bytes',
    });

    if (range) {
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      headers.set('Content-Length', String(range.end - range.start + 1));
      const stream = createReadStream(absolute, { start: range.start, end: range.end });
      return new Response(Readable.toWeb(stream) as ReadableStream, { status: 206, headers });
    }

    headers.set('Content-Length', String(size));
    const stream = createReadStream(absolute);
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: 200, headers });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Soft delete. The bytes stay on disk until the retention sweep removes them,
 * so an accidental delete is recoverable (scripts/sweep-files.ts).
 */
export async function DELETE(_request: Request, ctx: RouteContext<'/api/files/[storageKey]'>) {
  const actor = await requireApiActor();
  if (isResponse(actor)) return actor;

  try {
    const { storageKey } = await ctx.params;
    if (!UUID_RE.test(storageKey)) {
      return Response.json({ error: 'Not found.' }, { status: 404 });
    }

    const file = await loadFileContext(storageKey);
    if (!file) return Response.json({ error: 'Not found.' }, { status: 404 });

    if (!can(actor, 'files.delete')) {
      await recordActivity({
        actorId: actor.id,
        action: 'file.delete_denied',
        entityType: 'file',
        entityId: file.fileId,
        projectId: file.projectId,
        metadata: { storageKey },
      });
      return Response.json({ error: 'You are not permitted to delete files.' }, { status: 403 });
    }

    await getDb()
      .update(files)
      .set({ deletedAt: new Date(), deletedBy: actor.id })
      .where(eq(files.id, file.fileId));

    await recordActivity({
      actorId: actor.id,
      action: 'file.deleted',
      entityType: 'file',
      entityId: file.fileId,
      projectId: file.projectId,
      metadata: { storageKey, softDelete: true },
    });

    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

type Range = { start: number; end: number };

/** Single-range `bytes=` only, which is all browsers send for media. */
function parseRange(header: string | null, size: number): Range | null | 'invalid' {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'invalid';

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return 'invalid';

  let start: number;
  let end: number;

  if (rawStart === '') {
    // Suffix form: the last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return 'invalid';
    if (start > end || start >= size) return 'invalid';
    end = Math.min(end, size - 1);
  }

  if (size === 0) return 'invalid';
  return { start, end };
}
