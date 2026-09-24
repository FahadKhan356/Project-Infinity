import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { comments } from '@/db/schema';
import type { Actor } from '@/lib/authz';
import { revisionScope } from '@/lib/authz';
import { isProjectVisible } from '@/lib/authz/queries';
import { assertMonthOpen } from '@/lib/months/lifecycle';

export class WorkspaceError extends Error {}

export const MAX_COMMENT_LENGTH = 4000;

export interface CommentInput {
  /** Exactly one of these. */
  projectId?: number;
  deliverableId?: number;
  revisionId?: number;
  body: string;
}

export interface CommentResult {
  commentId: number;
  projectId: number;
}

/**
 * Anyone who can see a project may talk on it (brief §9). A comment pinned
 * to a deliverable resolves to that deliverable's project, so the same
 * visibility rule applies and nothing can be said about a slot the author
 * cannot see.
 */
export async function addComment(actor: Actor, input: CommentInput): Promise<CommentResult> {
  const body = input.body.trim();
  if (body.length === 0) throw new WorkspaceError('Write something before posting.');
  if (body.length > MAX_COMMENT_LENGTH) {
    throw new WorkspaceError(`Keep a comment under ${MAX_COMMENT_LENGTH} characters.`);
  }

  const db = getDb();
  let projectId: number;

  if (input.revisionId !== undefined) {
    const rows = await db.execute<{ project_id: number }>(sql`
      SELECT r.project_id FROM revisions r WHERE r.id = ${input.revisionId} AND ${revisionScope(actor, 'r')}
    `);
    const row = rows[0];
    if (!row) throw new WorkspaceError('No such revision.');
    projectId = Number(row.project_id);
  } else if (input.deliverableId !== undefined) {
    const rows = await db.execute<{ project_id: number }>(sql`
      SELECT project_id FROM deliverables WHERE id = ${input.deliverableId}
    `);
    const row = rows[0];
    // The same wording whether the slot is missing or merely out of reach.
    if (!row || !(await isProjectVisible(db, actor, Number(row.project_id)))) {
      throw new WorkspaceError('No such deliverable.');
    }
    projectId = Number(row.project_id);
  } else if (input.projectId !== undefined) {
    if (!(await isProjectVisible(db, actor, input.projectId))) {
      throw new WorkspaceError('No such project.');
    }
    projectId = input.projectId;
  } else {
    throw new WorkspaceError('A comment needs something to attach to.');
  }
  // An archived month keeps its thread as it was (brief §36).
  await assertMonthOpen(db, { projectId }, (m) => new WorkspaceError(m));

  const [inserted] = await db
    .insert(comments)
    .values({
      authorId: actor.id,
      body,
      projectId: input.deliverableId === undefined && input.revisionId === undefined ? projectId : null,
      deliverableId: input.deliverableId ?? null,
      revisionId: input.revisionId ?? null,
    })
    .returning({ id: comments.id });

  return { commentId: inserted.id, projectId };
}
