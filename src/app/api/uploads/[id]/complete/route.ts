import { recordActivity } from '@/lib/auth/audit';
import { errorResponse, isResponse, requireApiActor } from '@/lib/files/api';
import { completeUpload } from '@/lib/files/uploads';

export const dynamic = 'force-dynamic';

export async function POST(_request: Request, ctx: RouteContext<'/api/uploads/[id]/complete'>) {
  const actor = await requireApiActor();
  if (isResponse(actor)) return actor;

  try {
    const { id } = await ctx.params;
    const result = await completeUpload(actor, id);

    await recordActivity({
      actorId: actor.id,
      action: 'file.uploaded',
      entityType: 'file',
      entityId: result.fileId,
      projectId: result.projectId,
      metadata: {
        uploadId: id,
        deliverableId: result.deliverableId,
        deliverableName: result.deliverableName,
        versionNo: result.versionNo,
        revisionNo: result.revisionNo,
        filename: result.originalFilename,
        assignmentTitle: result.assignmentTitle,
        kind: result.kind,
        sizeBytes: result.sizeBytes,
        checksum: result.checksum,
      },
    });

    return Response.json(
      {
        fileId: result.fileId,
        storageKey: result.storageKey,
        checksum: result.checksum,
        sizeBytes: result.sizeBytes,
        deliverableId: result.deliverableId,
        versionNo: result.versionNo,
        downloadUrl: `/api/files/${result.storageKey}`,
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
