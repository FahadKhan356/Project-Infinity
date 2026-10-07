import { open, type FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/db';
import { files } from '@/db/schema';
import { recordActivity } from '@/lib/auth/audit';
import { can } from '@/lib/authz';
import { decideFileAccess, loadFileContext } from '@/lib/files/access';
import { errorResponse, isResponse, requireApiActor } from '@/lib/files/api';
import { absolutePath, contentDisposition, downloadFilename } from '@/lib/files/storage';
import { previewContentType } from '@/lib/files/preview';
import { UploadError } from '@/lib/files/uploads';
import { assertMonthOpen } from '@/lib/months/lifecycle';
import { clientMayReadFile } from '@/lib/portal/portal';

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
  // Client portal logins may read what was delivered to them, and nothing else.
  const actor = await requireApiActor({ allowClient: true });
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

    // ?inline=1 views the file in place, for the formats that cannot run
    // script; anything else is still a download (lib/files/preview) — and
    // so is subject to the download right below (§43).
    const inlineType = new URL(request.url).searchParams.get('inline') === '1'
      ? previewContentType(file.mimeType, file.originalFilename)
      : null;

    // A client login is governed by the portal's own rule, never by can()
    // (which is always false for it), so the download intent is staff-only.
    const decision = actor.role === 'client'
      ? ((await clientMayReadFile(actor, file.fileId))
        ? { allowed: true as const }
        : { allowed: false as const, reason: 'not_delivered_to_client' })
      : await decideFileAccess(actor, file, inlineType === null ? 'download' : 'read');
    if (!decision.allowed) {
      await recordActivity({
        actorId: actor.id,
        action: 'file.download_denied',
        entityType: 'file',
        entityId: file.fileId,
        projectId: file.projectId,
        metadata: { storageKey, reason: decision.reason },
      });
      if (decision.reason === 'download_withheld') {
        // Visibility has already passed, so there is nothing to hide: say why.
        return Response.json(
          { error: 'Downloads are not enabled for your account. You can view this file in the portal.' },
          { status: 403 },
        );
      }
      // Indistinguishable from a file that does not exist, so the endpoint
      // cannot be used to probe for other departments' work.
      return Response.json({ error: 'Not found.' }, { status: 404 });
    }

    // The retention sweep leaves a purged file's row behind with an empty
    // path (scripts/sweep-files.ts). Visibility has already passed, so the
    // answer can say what happened: the bytes are gone for good.
    if (file.storagePath === '') {
      await recordActivity({
        actorId: actor.id,
        action: 'file.download_denied',
        entityType: 'file',
        entityId: file.fileId,
        projectId: file.projectId,
        metadata: { storageKey, reason: 'purged' },
      });
      return Response.json({ error: 'This file was removed by the retention sweep.' }, { status: 410 });
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

    // Opened before anything is promised. A stream that only finds the bytes
    // missing after the Response has been returned can no longer change the
    // status: the connection is dropped with none at all. A row whose bytes
    // are gone is an integrity fault — loud in the server log — and answers
    // as a file that does not exist. Anything else is a real failure (500).
    let handle: FileHandle;
    try {
      handle = await open(absolute, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      console.error('[files] bytes missing on disk', {
        storageKey, fileId: file.fileId, storagePath: file.storagePath,
      });
      await recordActivity({
        actorId: actor.id,
        action: 'file.download_denied',
        entityType: 'file',
        entityId: file.fileId,
        projectId: file.projectId,
        metadata: { storageKey, reason: 'missing_on_disk' },
      });
      return Response.json({ error: 'Not found.' }, { status: 404 });
    }

    // Recorded once the bytes are known to be there, and before they move.
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
        inline: inlineType !== null,
        ...(range ? { start: range.start, end: range.end } : {}),
      },
    });

    // The project ID travels with the file (brief §24): AKT-2026-0001_Video_Final_v2.mp4.
    const saveAs = downloadFilename(file.originalFilename, file.versionNo, file.projectCode);
    const headers = new Headers({
      'Content-Type': inlineType ?? (file.mimeType || 'application/octet-stream'),
      'Content-Disposition': inlineType
        ? contentDisposition(saveAs).replace(/^attachment/, 'inline')
        : contentDisposition(saveAs),
      // Files are permission-gated, so no shared cache may hold them.
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      // Range support is what makes previewing a multi-gigabyte master usable.
      'Accept-Ranges': 'bytes',
    });

    if (range) {
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      headers.set('Content-Length', String(range.end - range.start + 1));
      return new Response(bodyOf(handle, file, range), { status: 206, headers });
    }

    headers.set('Content-Length', String(size));
    return new Response(bodyOf(handle, file, null), { status: 200, headers });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * The bytes, read from a handle the stream then owns (it is closed with the
 * stream). A failure once the status is on the wire cannot change it any
 * more; it is logged with the file it concerned, rather than surfacing only
 * as Next's bare "failed to pipe response".
 */
function bodyOf(
  handle: FileHandle,
  file: { storageKey: string; fileId: number },
  range: Range | null,
): ReadableStream {
  const stream = range
    ? handle.createReadStream({ start: range.start, end: range.end })
    : handle.createReadStream();
  stream.on('error', (error) => {
    console.error('[files] read failed mid-stream', { storageKey: file.storageKey, fileId: file.fileId }, error);
  });
  return Readable.toWeb(stream) as ReadableStream;
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

    // The right to delete files is not a key to every project: a file on a
    // project the actor cannot see answers exactly as a missing one does —
    // and a project merely shared with them to view (§23) counts as unseen
    // here, because the share is for reading.
    const decision = await decideFileAccess(actor, file, 'write');
    if (!decision.allowed) {
      await recordActivity({
        actorId: actor.id,
        action: 'file.delete_denied',
        entityType: 'file',
        entityId: file.fileId,
        projectId: file.projectId,
        metadata: { storageKey, reason: decision.reason },
      });
      return Response.json({ error: 'Not found.' }, { status: 404 });
    }

    // A closed month is read-only, its files included (brief §36): the month
    // is reopened first. The UI hides the button there; this is the rule.
    if (file.projectId !== null) {
      try {
        await assertMonthOpen(getDb(), { projectId: file.projectId }, (message) => new UploadError(409, message));
      } catch (error) {
        if (error instanceof UploadError) {
          await recordActivity({
            actorId: actor.id,
            action: 'file.delete_denied',
            entityType: 'file',
            entityId: file.fileId,
            projectId: file.projectId,
            metadata: { storageKey, reason: 'month_closed' },
          });
        }
        throw error;
      }
    }

    // Only a live file: deleting it again (a stale page, two people at once)
    // must not overwrite who deleted it, and when.
    const [deleted] = await getDb()
      .update(files)
      .set({ deletedAt: new Date(), deletedBy: actor.id })
      .where(and(eq(files.id, file.fileId), isNull(files.deletedAt)))
      .returning({ id: files.id });
    if (!deleted) {
      return Response.json({ error: 'This file has already been deleted.' }, { status: 409 });
    }

    await recordActivity({
      actorId: actor.id,
      action: 'file.deleted',
      entityType: 'file',
      entityId: file.fileId,
      projectId: file.projectId,
      metadata: { storageKey, softDelete: true, filename: file.originalFilename },
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
