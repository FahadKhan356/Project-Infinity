import 'server-only';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, truncate } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import {
  attachments,
  deliverableVersions,
  deliverables,
  files,
  uploadSessions,
} from '@/db/schema';
import type { Actor } from '@/lib/authz';
import {
  absolutePath,
  attachmentRelativePath,
  checksumOf,
  deliverableRelativePath,
  ensureParentDirectory,
  ensureStorageLayout,
  fileSize,
  promoteTempFile,
  removeFile,
  tempRelativePath,
} from './storage';

/** Chunk size advertised to clients. Large enough to be efficient on a LAN,
 *  small enough that a dropped connection costs little. */
export const CHUNK_SIZE = 8 * 1024 * 1024;

/** A single PATCH may not exceed this, whatever the client claims. */
export const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export class UploadError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

export interface CreateSessionInput {
  target: 'deliverable' | 'attachment';
  deliverableId?: number;
  projectId?: number;
  filename: string;
  size: number;
  mimeType?: string | null;
  checksum?: string | null;
  notes?: string | null;
}

export async function createUploadSession(actor: Actor, input: CreateSessionInput) {
  if (!Number.isFinite(input.size) || input.size < 0) {
    throw new UploadError(400, 'A non-negative size is required.');
  }
  if (!input.filename.trim()) {
    throw new UploadError(400, 'A filename is required.');
  }

  await ensureStorageLayout();

  const id = randomUUID();
  const tempPath = tempRelativePath(id);
  await ensureParentDirectory(tempPath);

  // Create the sparse target up front so every chunk can be written
  // positionally into an existing file.
  const handle = await open(absolutePath(tempPath), 'w');
  await handle.close();

  const [session] = await getDb()
    .insert(uploadSessions)
    .values({
      id,
      createdBy: actor.id,
      target: input.target,
      deliverableId: input.target === 'deliverable' ? input.deliverableId! : null,
      projectId: input.target === 'attachment' ? input.projectId! : null,
      originalFilename: input.filename.slice(0, 255),
      mimeType: input.mimeType ?? null,
      declaredSize: input.size,
      tempPath,
      expectedChecksum: input.checksum ?? null,
      notes: input.notes ?? null,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    })
    .returning();

  return { session, chunkSize: CHUNK_SIZE };
}

export async function loadOwnSession(actor: Actor, uploadId: string) {
  const [session] = await getDb()
    .select()
    .from(uploadSessions)
    .where(and(eq(uploadSessions.id, uploadId), eq(uploadSessions.createdBy, actor.id)))
    .limit(1);
  return session ?? null;
}

/**
 * Appends one chunk at the offset the server recorded.
 *
 * The write is positional rather than an append, which makes a retry safe: if
 * the previous request wrote bytes but failed before recording them, the
 * client resumes from the recorded offset and overwrites exactly those bytes.
 * Nothing is ever duplicated or interleaved.
 */
export async function appendChunk(
  actor: Actor,
  uploadId: string,
  clientOffset: number,
  body: ReadableStream<Uint8Array> | null,
): Promise<{ offset: number }> {
  const session = await loadOwnSession(actor, uploadId);
  if (!session) throw new UploadError(404, 'Unknown upload.');
  if (session.completedAt) throw new UploadError(409, 'This upload is already complete.');
  if (session.expiresAt.getTime() < Date.now()) throw new UploadError(410, 'This upload expired.');

  if (clientOffset !== session.bytesReceived) {
    throw new UploadError(
      409,
      `Offset mismatch: the server holds ${session.bytesReceived} bytes.`,
    );
  }
  if (!body) throw new UploadError(400, 'A chunk body is required.');

  const remaining = session.declaredSize - session.bytesReceived;
  if (remaining <= 0) throw new UploadError(409, 'All declared bytes have already been received.');

  const absolute = absolutePath(session.tempPath);
  let received = 0;
  let overflowed = false;

  const source = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);

  // Counting happens inside the pipeline. A plain 'data' listener would put
  // the stream into flowing mode before the sink is attached, which can drop
  // bytes or stall the transfer.
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > remaining || received > MAX_CHUNK_BYTES) {
        overflowed = true;
        callback(new UploadError(413, 'Chunk exceeds the declared size or the maximum chunk size.'));
        return;
      }
      callback(null, chunk);
    },
  });

  // `r+` with `start` writes into the existing file without truncating it.
  const sink = createWriteStream(absolute, { flags: 'r+', start: session.bytesReceived });

  try {
    await pipeline(source, meter, sink);
  } catch (error) {
    // Whatever went wrong — oversize chunk, dropped connection, client abort —
    // roll the file back to the recorded offset. That keeps the invariant the
    // resume protocol depends on: on disk length always equals bytes_received,
    // so the client can safely resume from the offset the server reports.
    await truncate(absolute, session.bytesReceived).catch(() => {});
    if (overflowed) {
      throw new UploadError(413, 'Chunk exceeds the declared size or the maximum chunk size.');
    }
    throw error;
  }

  const offset = session.bytesReceived + received;
  await getDb()
    .update(uploadSessions)
    .set({ bytesReceived: offset })
    .where(and(eq(uploadSessions.id, uploadId), isNull(uploadSessions.completedAt)));

  return { offset };
}

export interface CompletedUpload {
  fileId: number;
  storageKey: string;
  storagePath: string;
  checksum: string;
  sizeBytes: number;
  deliverableId: number | null;
  deliverableName: string | null;
  versionNo: number | null;
  projectId: number | null;
}

/**
 * Finalises an upload: verify length, hash the bytes, move the file into its
 * permanent place and record it — deliverable uploads become a new version of
 * their slot, never a new slot (brief §7/§11/§19).
 */
export async function completeUpload(actor: Actor, uploadId: string): Promise<CompletedUpload> {
  const db = getDb();
  const session = await loadOwnSession(actor, uploadId);
  if (!session) throw new UploadError(404, 'Unknown upload.');
  if (session.completedAt) throw new UploadError(409, 'This upload is already complete.');

  const onDisk = await fileSize(session.tempPath);
  if (onDisk !== session.declaredSize || session.bytesReceived !== session.declaredSize) {
    throw new UploadError(
      409,
      `Incomplete upload: ${session.bytesReceived} of ${session.declaredSize} bytes received.`,
    );
  }

  const checksum = await checksumOf(session.tempPath);
  if (session.expectedChecksum && session.expectedChecksum.toLowerCase() !== checksum) {
    throw new UploadError(422, 'The uploaded bytes do not match the checksum supplied.');
  }

  const storageKey = randomUUID();
  let finalPath: string | null = null;
  let moved = false;

  try {
    return await db.transaction(async (tx) => {
      let deliverableId: number | null = null;
      let deliverableName: string | null = null;
      let versionNo: number | null = null;
      let projectId: number | null = null;

      if (session.target === 'deliverable') {
        // Lock the slot first, in its own statement: FOR UPDATE cannot be
        // combined with the GROUP BY the version lookup needs. Holding this
        // lock is what stops two simultaneous completions claiming the same
        // version number.
        const locked = await tx.execute<{ id: number }>(sql`
          SELECT id FROM deliverables WHERE id = ${session.deliverableId} FOR UPDATE
        `);
        if (locked.length === 0) throw new UploadError(404, 'That deliverable no longer exists.');

        const located = await tx.execute<{
          client_id: number; period_year: number; period_month: number;
          project_id: number; deliverable_name: string; next_version: number;
        }>(sql`
          SELECT p.client_id, cm.period_year, cm.period_month, p.id AS project_id,
                 d.name AS deliverable_name,
                 COALESCE(MAX(dv.version_no), 0) + 1 AS next_version
          FROM deliverables d
          JOIN projects p       ON p.id = d.project_id
          JOIN client_months cm ON cm.id = p.client_month_id
          LEFT JOIN deliverable_versions dv ON dv.deliverable_id = d.id
          WHERE d.id = ${session.deliverableId}
          GROUP BY p.client_id, cm.period_year, cm.period_month, p.id, d.name
        `);
        const loc = located[0];
        if (!loc) throw new UploadError(404, 'That deliverable no longer exists.');

        deliverableId = session.deliverableId;
        deliverableName = loc.deliverable_name;
        versionNo = Number(loc.next_version);
        projectId = Number(loc.project_id);

        finalPath = deliverableRelativePath({
          clientId: Number(loc.client_id),
          periodYear: Number(loc.period_year),
          periodMonth: Number(loc.period_month),
          projectId,
          deliverableId: deliverableId!,
          versionNo,
          storageKey,
          originalFilename: session.originalFilename,
        });
      } else {
        const located = await tx.execute<{ client_id: number }>(sql`
          SELECT client_id FROM projects WHERE id = ${session.projectId}
        `);
        const loc = located[0];
        if (!loc) throw new UploadError(404, 'That project no longer exists.');

        projectId = session.projectId;
        finalPath = attachmentRelativePath({
          clientId: Number(loc.client_id),
          projectId: projectId!,
          storageKey,
          originalFilename: session.originalFilename,
        });
      }

      await promoteTempFile(session.tempPath, finalPath);
      moved = true;

      const [file] = await tx
        .insert(files)
        .values({
          storageKey,
          storagePath: finalPath,
          originalFilename: session.originalFilename,
          mimeType: session.mimeType,
          sizeBytes: session.declaredSize,
          checksumSha256: checksum,
          uploadedBy: actor.id,
        })
        .returning({ id: files.id });

      if (session.target === 'deliverable') {
        await tx
          .update(deliverableVersions)
          .set({ isCurrent: false })
          .where(eq(deliverableVersions.deliverableId, deliverableId!));

        await tx.insert(deliverableVersions).values({
          deliverableId: deliverableId!,
          versionNo: versionNo!,
          fileId: file.id,
          uploadedBy: actor.id,
          notes: session.notes,
          isCurrent: true,
        });

        // A new version puts the slot back in the Team Lead's queue. The slot
        // itself is never duplicated, so progress does not double-count.
        await tx
          .update(deliverables)
          .set({ status: 'awaiting_lead_qa' })
          .where(eq(deliverables.id, deliverableId!));

        // The first file to arrive is what turns "planned" into "in progress"
        // (brief §18) — for the assignment, and for the project as a whole.
        await tx.execute(sql`
          UPDATE assignments SET status = 'in_progress'
          WHERE id = (SELECT assignment_id FROM deliverables WHERE id = ${deliverableId})
            AND status = 'planned'
        `);
        await tx.execute(sql`
          UPDATE projects SET status = 'in_progress'
          WHERE id = ${projectId} AND status = 'planned'
        `);
      } else {
        await tx.insert(attachments).values({
          fileId: file.id,
          projectId: projectId!,
          purpose: 'reference',
        });
      }

      await tx
        .update(uploadSessions)
        .set({ completedAt: new Date(), fileId: file.id, bytesReceived: session.declaredSize })
        .where(eq(uploadSessions.id, uploadId));

      return {
        fileId: file.id,
        storageKey,
        storagePath: finalPath!,
        checksum,
        sizeBytes: session.declaredSize,
        deliverableId,
        deliverableName,
        versionNo,
        projectId,
      };
    });
  } catch (error) {
    // The move happened but the transaction did not commit: put the bytes back
    // so the client can retry rather than losing the upload.
    if (moved && finalPath) {
      await promoteTempFile(finalPath, session.tempPath).catch(() => {});
    }
    throw error;
  }
}

export async function abortUpload(actor: Actor, uploadId: string): Promise<void> {
  const session = await loadOwnSession(actor, uploadId);
  if (!session) throw new UploadError(404, 'Unknown upload.');
  if (session.completedAt) throw new UploadError(409, 'This upload is already complete.');

  await removeFile(session.tempPath);
  await getDb().delete(uploadSessions).where(eq(uploadSessions.id, uploadId));
}
