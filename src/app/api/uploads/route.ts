import { recordActivity } from '@/lib/auth/audit';
import { canAttachToProject, canUploadToDeliverable } from '@/lib/files/access';
import { errorResponse, isResponse, requireApiActor } from '@/lib/files/api';
import { createUploadSession } from '@/lib/files/uploads';

export const dynamic = 'force-dynamic';

/** Opens a resumable upload. Returns the id the client PATCHes chunks to. */
export async function POST(request: Request) {
  const actor = await requireApiActor();
  if (isResponse(actor)) return actor;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const target = body.target === 'attachment' ? 'attachment' : 'deliverable';
    const filename = String(body.filename ?? '');
    const size = Number(body.size);

    let projectId: number | undefined;
    let deliverableId: number | undefined;
    let assignmentId: number | undefined;
    let revisionId: number | undefined;
    // The PO document (§3) only when the client says exactly that; anything
    // else is a reference.
    let kind: 'po' | 'reference' = 'reference';

    if (target === 'deliverable') {
      deliverableId = Number(body.deliverableId);
      if (!Number.isInteger(deliverableId)) {
        return Response.json({ error: 'deliverableId is required.' }, { status: 400 });
      }
      const decision = await canUploadToDeliverable(actor, deliverableId);
      if (!decision.allowed) {
        await recordActivity({
          actorId: actor.id,
          action: 'file.upload_denied',
          entityType: 'deliverable',
          entityId: deliverableId,
          metadata: { reason: decision.reason },
        });
        return Response.json({ error: decision.reason }, { status: 403 });
      }
      projectId = decision.projectId;
    } else {
      projectId = Number(body.projectId);
      if (!Number.isInteger(projectId)) {
        return Response.json({ error: 'projectId is required.' }, { status: 400 });
      }
      const optionalId = (value: unknown) =>
        value === undefined || value === null || value === '' ? undefined : Number(value);
      assignmentId = optionalId(body.assignmentId);
      revisionId = optionalId(body.revisionId);
      if ((assignmentId !== undefined && !Number.isInteger(assignmentId))
        || (revisionId !== undefined && !Number.isInteger(revisionId))) {
        return Response.json({ error: 'Unknown assignment or revision.' }, { status: 400 });
      }
      kind = body.kind === 'po' ? 'po' : 'reference';
      const decision = await canAttachToProject(actor, projectId, { assignmentId, revisionId, kind });
      if (!decision.allowed) {
        await recordActivity({
          actorId: actor.id,
          action: 'file.upload_denied',
          entityType: 'project',
          entityId: projectId,
          metadata: { reason: decision.reason },
        });
        return Response.json({ error: decision.reason }, { status: 403 });
      }
    }

    const { session, chunkSize } = await createUploadSession(actor, {
      target,
      deliverableId,
      projectId,
      assignmentId,
      revisionId,
      purpose: typeof body.purpose === 'string' ? body.purpose : null,
      kind,
      filename,
      size,
      mimeType: typeof body.mimeType === 'string' ? body.mimeType : null,
      checksum: typeof body.checksum === 'string' ? body.checksum : null,
      notes: typeof body.notes === 'string' ? body.notes : null,
    });

    await recordActivity({
      actorId: actor.id,
      action: 'file.upload_started',
      entityType: target,
      entityId: deliverableId ?? projectId ?? null,
      projectId: projectId ?? null,
      metadata: { uploadId: session.id, filename, size },
    });

    return Response.json(
      { uploadId: session.id, offset: 0, chunkSize, expiresAt: session.expiresAt },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
