import 'server-only';
import { getActor } from '@/lib/auth/dal';
import type { Actor } from '@/lib/authz';
import { UploadError } from './uploads';

/** API routes answer with JSON, never a redirect — they are called by scripts. */
export async function requireApiActor(): Promise<Actor | Response> {
  const actor = await getActor();
  if (!actor) {
    return Response.json({ error: 'Not signed in.' }, { status: 401 });
  }
  if (actor.mustChangePassword) {
    return Response.json({ error: 'Change your password before using the API.' }, { status: 403 });
  }
  return actor;
}

export function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

export function errorResponse(error: unknown): Response {
  if (error instanceof UploadError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  console.error('[files] unexpected error', error);
  return Response.json({ error: 'Unexpected error.' }, { status: 500 });
}
