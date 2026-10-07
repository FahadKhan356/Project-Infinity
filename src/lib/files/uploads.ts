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
import { canAttachToProject, canUploadToDeliverable, uploadBlockedReason } from '@/lib/files/access';
import { MONTH_CLOSED_MESSAGE } from '@/lib/months/lifecycle';
import { onDeliverableUploaded } from '@/lib/notifications/notify';
import { workBlockedReason } from '@/lib/projects/status';
import { syncProjectStatus } from '@/lib/qa/project-status';
import { openRevisionFor, syncRevisionStatus } from '@/lib/revisions/status';
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
  /** For an attachment: pin it to one assignment or revision of that project (§7, §15). */
  assignmentId?: number;
  revisionId?: number;
  purpose?: string | null;
  /** For an attachment: the PO document (§3), or a plain reference (the default). */
  kind?: 'po' | 'reference';
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
      assignmentId: input.target === 'attachment' ? input.assignmentId ?? null : null,
      revisionId: input.target === 'attachment' ? input.revisionId ?? null : null,
      // A blank purpose or note is no purpose or note: stored as null, so the
      // attachment falls back to 'reference' and the version history shows
      // nothing rather than an empty line.
      purpose: input.target === 'attachment' ? input.purpose?.trim().slice(0, 40) || null : null,
      kind: input.target === 'attachment' ? (input.kind ?? 'reference') : 'reference',
      originalFilename: input.filename.slice(0, 255),
      mimeType: input.mimeType ?? null,
      declaredSize: input.size,
      tempPath,
      expectedChecksum: input.checksum ?? null,
      notes: input.notes?.trim() || null,
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
  /** Set when this version answers an open revision (brief §17). */
  revisionNo: number | null;
  projectId: number | null;
  originalFilename: string;
  /** Set when an attachment was pinned to an assignment. */
  assignmentTitle: string | null;
  /** For an attachment: the PO document (§3) or a reference; null for a deliverable version. */
  kind: 'po' | 'reference' | null;
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

  // The rule that let the session open is checked again here: a session
  // lives for a day, and the executive it belongs to may have been taken
  // off the assignment — or the project shared away — since (brief §43).
  const permitted = session.target === 'deliverable'
    ? await canUploadToDeliverable(actor, session.deliverableId!)
    : await canAttachToProject(actor, session.projectId!, {
        assignmentId: session.assignmentId ?? undefined,
        revisionId: session.revisionId ?? undefined,
        kind: session.kind === 'po' ? 'po' : 'reference',
      });
  if (!permitted.allowed) throw new UploadError(403, permitted.reason ?? 'Not allowed.');

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
      let revision: { id: number; revisionNo: number } | null = null;
      let projectId: number | null = null;
      let assignmentTitle: string | null = null;

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
          client_id: number; period_year: number; period_month: number; month_status: string;
          project_status: string; project_id: number; deliverable_name: string; next_version: number;
          slot_status: string;
        }>(sql`
          SELECT p.client_id, cm.period_year, cm.period_month, cm.status AS month_status,
                 p.status AS project_status, p.id AS project_id, d.name AS deliverable_name,
                 d.status AS slot_status,
                 COALESCE(MAX(dv.version_no), 0) + 1 AS next_version
          FROM deliverables d
          JOIN projects p       ON p.id = d.project_id
          JOIN client_months cm ON cm.id = p.client_month_id
          LEFT JOIN deliverable_versions dv ON dv.deliverable_id = d.id
          WHERE d.id = ${session.deliverableId}
          GROUP BY p.client_id, cm.period_year, cm.period_month, cm.status, p.status, p.id, d.name, d.status
        `);
        const loc = located[0];
        if (!loc) throw new UploadError(404, 'That deliverable no longer exists.');
        // The session was opened while the month was open; it may have
        // closed since. The archive wins (brief §36).
        if (loc.month_status === 'closed') throw new UploadError(409, MONTH_CLOSED_MESSAGE);
        // Likewise a project held or cancelled while the bytes were in flight.
        const blocked = workBlockedReason(loc.project_status);
        if (blocked) throw new UploadError(409, blocked);
        // And a slot approved or handed to the PM while the bytes were in flight.
        const slotBlocked = uploadBlockedReason(loc.slot_status);
        if (slotBlocked) throw new UploadError(409, slotBlocked);

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
        const located = await tx.execute<{
          client_id: number; period_year: number; period_month: number; month_status: string;
        }>(sql`
          SELECT p.client_id, cm.period_year, cm.period_month, cm.status AS month_status
          FROM projects p JOIN client_months cm ON cm.id = p.client_month_id
          WHERE p.id = ${session.projectId}
        `);
        const loc = located[0];
        if (!loc) throw new UploadError(404, 'That project no longer exists.');
        if (loc.month_status === 'closed') throw new UploadError(409, MONTH_CLOSED_MESSAGE);

        // The parent was checked against the project when the session opened;
        // re-read it here for the activity line, and in case it went since.
        if (session.assignmentId !== null) {
          const [a] = await tx.execute<{ title: string }>(sql`
            SELECT title FROM assignments WHERE id = ${session.assignmentId} AND project_id = ${session.projectId}
          `);
          if (!a) throw new UploadError(404, 'That assignment no longer exists.');
          assignmentTitle = a.title;
        }
        if (session.revisionId !== null) {
          const [r] = await tx.execute<{ id: number; revision_no: number }>(sql`
            SELECT id, revision_no FROM revisions WHERE id = ${session.revisionId} AND project_id = ${session.projectId}
          `);
          if (!r) throw new UploadError(404, 'That revision no longer exists.');
          revision = { id: Number(r.id), revisionNo: Number(r.revision_no) };
        }

        projectId = session.projectId;
        finalPath = attachmentRelativePath({
          clientId: Number(loc.client_id),
          periodYear: Number(loc.period_year),
          periodMonth: Number(loc.period_month),
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

        // A version uploaded while a revision is open on the slot answers it.
        revision = await openRevisionFor(tx, deliverableId!);

        await tx.insert(deliverableVersions).values({
          deliverableId: deliverableId!,
          versionNo: versionNo!,
          fileId: file.id,
          revisionId: revision?.id ?? null,
          uploadedBy: actor.id,
          notes: session.notes,
          isCurrent: true,
        });
        await onDeliverableUploaded(tx, {
          deliverableId: deliverableId!, versionNo: versionNo!,
          revisionNo: revision?.revisionNo ?? null, actorId: actor.id,
        });

        // A new version puts the slot back in the Team Lead's queue. The slot
        // itself is never duplicated, so progress does not double-count.
        await tx
          .update(deliverables)
          .set({ status: 'awaiting_lead_qa' })
          .where(eq(deliverables.id, deliverableId!));

        // The first file to arrive is what turns "planned" into "in progress"
        // (brief §18) for the assignment. The project follows its slots: in
        // progress, or in QA once this was the last one still in production —
        // and out of "planned" or "awaiting assignment" alike, since a team
        // still without a lead does not stop the work that has started.
        await tx.execute(sql`
          UPDATE assignments SET status = 'in_progress'
          WHERE id = (SELECT assignment_id FROM deliverables WHERE id = ${deliverableId})
            AND status = 'planned'
        `);
        if (revision) await syncRevisionStatus(tx, revision.id);
        await syncProjectStatus(tx, projectId!);
      } else {
        // Exactly one parent (attachments_exactly_one_parent): the most
        // specific one the uploader named. Access still resolves through it
        // to the project (files/access.ts). The kind travelled on the session
        // and was checked above; a PO without a label is labelled as one.
        const kind = session.kind === 'po' ? 'po' : 'reference';
        await tx.insert(attachments).values({
          fileId: file.id,
          projectId: session.assignmentId === null && session.revisionId === null ? projectId! : null,
          assignmentId: session.assignmentId,
          revisionId: session.revisionId,
          purpose: session.purpose ?? kind,
          kind,
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
        revisionNo: revision === null ? null : (revision as { revisionNo: number }).revisionNo,
        projectId,
        originalFilename: session.originalFilename,
        assignmentTitle,
        kind: session.target === 'attachment' ? (session.kind === 'po' ? 'po' : 'reference') : null,
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
