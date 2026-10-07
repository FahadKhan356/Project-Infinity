import { errorResponse, isResponse, requireApiActor } from '@/lib/files/api';
import { abortUpload, appendChunk, loadOwnSession } from '@/lib/files/uploads';

export const dynamic = 'force-dynamic';

/** Resume point: tells the client how many bytes the server already holds. */
export async function HEAD(_request: Request, ctx: RouteContext<'/api/uploads/[id]'>) {
  const actor = await requireApiActor();
  if (isResponse(actor)) return actor;

  const { id } = await ctx.params;
  const session = await loadOwnSession(actor, id);
  if (!session) return new Response(null, { status: 404 });

  return new Response(null, {
    status: 204,
    headers: {
      'Upload-Offset': String(session.bytesReceived),
      'Upload-Length': String(session.declaredSize),
      'Cache-Control': 'no-store',
    },
  });
}

/** Appends one chunk at Upload-Offset. */
export async function PATCH(request: Request, ctx: RouteContext<'/api/uploads/[id]'>) {
  const actor = await requireApiActor();
  if (isResponse(actor)) return actor;

  try {
    const { id } = await ctx.params;
    const header = request.headers.get('upload-offset');
    const offset = Number(header);
    if (header === null || !Number.isInteger(offset) || offset < 0) {
      return Response.json({ error: 'A valid Upload-Offset header is required.' }, { status: 400 });
    }

    const { offset: next } = await appendChunk(actor, id, offset, request.body);
    return new Response(null, {
      status: 204,
      headers: { 'Upload-Offset': String(next), 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: Request, ctx: RouteContext<'/api/uploads/[id]'>) {
  const actor = await requireApiActor();
  if (isResponse(actor)) return actor;

  try {
    const { id } = await ctx.params;
    await abortUpload(actor, id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
