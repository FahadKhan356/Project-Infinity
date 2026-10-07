import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { comments } from '@/db/schema';
import type { Actor } from '@/lib/authz';
import { revisionScope } from '@/lib/authz';
import { isProjectVisible } from '@/lib/authz/queries';
import { assertMonthOpen } from '@/lib/months/lifecycle';
import { onVersionCommented } from '@/lib/notifications/notify';

export class WorkspaceError extends Error {}

export const MAX_COMMENT_LENGTH = 4000;

export interface CommentInput {
  /** Exactly one of these. */
  projectId?: number;
  deliverableId?: number;
  revisionId?: number;
  /** One upload of a slot (brief §10, §19): the thread stays with that version. */
  versionId?: number;
  body: string;
}

export interface CommentResult {
  commentId: number;
  projectId: number;
  /**
   * The slot a comment was pinned to, and the version when it was left on
   * one; null for a comment on the project or a revision. What the feed
   * line is written from.
   */
  slot: {
    deliverableId: number;
    deliverableName: string;
    versionId: number | null;
    versionNo: number | null;
  } | null;
}

/**
 * Anyone who can see a project may talk on it (brief §9). A comment pinned
 * to a deliverable, or to one of its versions (§10, §19), resolves to that
 * deliverable's project, so the same visibility rule applies and nothing can
 * be said about a slot the author cannot see. A version whose file was
 * since deleted keeps its thread: the version row and its history survive.
 */
export async function addComment(actor: Actor, input: CommentInput): Promise<CommentResult> {
  const body = input.body.trim();
  if (body.length === 0) throw new WorkspaceError('Write something before posting.');
  if (body.length > MAX_COMMENT_LENGTH) {
    throw new WorkspaceError(`Keep a comment under ${MAX_COMMENT_LENGTH} characters.`);
  }

  const db = getDb();
  let projectId: number;
  let slot: CommentResult['slot'] = null;
  // Exactly one parent (comments_exactly_one_parent), set by the branch
  // taken — never copied from the input, which may name more than one.
  const parent: { projectId: number | null; deliverableId: number | null; revisionId: number | null; versionId: number | null } =
    { projectId: null, deliverableId: null, revisionId: null, versionId: null };

  if (input.revisionId !== undefined) {
    const rows = await db.execute<{ project_id: number }>(sql`
      SELECT r.project_id FROM revisions r WHERE r.id = ${input.revisionId} AND ${revisionScope(actor, 'r')}
    `);
    const row = rows[0];
    if (!row) throw new WorkspaceError('No such revision.');
    projectId = Number(row.project_id);
    parent.revisionId = input.revisionId;
  } else if (input.versionId !== undefined) {
    const rows = await db.execute<{ project_id: number; deliverable_id: number; name: string; version_no: number }>(sql`
      SELECT d.project_id, d.id AS deliverable_id, d.name, v.version_no
      FROM deliverable_versions v
      JOIN deliverables d ON d.id = v.deliverable_id
      WHERE v.id = ${input.versionId}
    `);
    const row = rows[0];
    // The same wording whether the version is missing or merely out of reach.
    if (!row || !(await isProjectVisible(db, actor, Number(row.project_id)))) {
      throw new WorkspaceError('No such file version.');
    }
    projectId = Number(row.project_id);
    parent.versionId = input.versionId;
    slot = {
      deliverableId: Number(row.deliverable_id), deliverableName: row.name,
      versionId: input.versionId, versionNo: Number(row.version_no),
    };
  } else if (input.deliverableId !== undefined) {
    const rows = await db.execute<{ project_id: number; name: string }>(sql`
      SELECT project_id, name FROM deliverables WHERE id = ${input.deliverableId}
    `);
    const row = rows[0];
    // The same wording whether the slot is missing or merely out of reach.
    if (!row || !(await isProjectVisible(db, actor, Number(row.project_id)))) {
      throw new WorkspaceError('No such deliverable.');
    }
    projectId = Number(row.project_id);
    parent.deliverableId = input.deliverableId;
    slot = { deliverableId: input.deliverableId, deliverableName: row.name, versionId: null, versionNo: null };
  } else if (input.projectId !== undefined) {
    if (!(await isProjectVisible(db, actor, input.projectId))) {
      throw new WorkspaceError('No such project.');
    }
    projectId = input.projectId;
    parent.projectId = input.projectId;
  } else {
    throw new WorkspaceError('A comment needs something to attach to.');
  }

  // An archived month keeps its thread as it was (brief §36). The guard and
  // the write share one transaction, so the month row stays held FOR SHARE
  // until the comment — and the notices about it — has landed.
  return db.transaction(async (tx) => {
    await assertMonthOpen(tx, { projectId }, (m) => new WorkspaceError(m));

    const [inserted] = await tx
      .insert(comments)
      .values({ authorId: actor.id, body, ...parent })
      .returning({ id: comments.id });

    if (parent.versionId !== null) {
      await onVersionCommented(tx, {
        versionId: parent.versionId, commentId: inserted.id, body, actorId: actor.id,
      });
    }
    return { commentId: inserted.id, projectId, slot };
  });
}
