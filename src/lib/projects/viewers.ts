import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { can } from '@/lib/authz';
import { isProjectVisible } from '@/lib/authz/queries';
import { notifyUsers } from '@/lib/notifications/notify';

/**
 * Sharing a project with a Sales rep (brief §23: Sales see "projects they
 * create/are authorized to view"). A rep otherwise sees only their own
 * clients' work; a share lets them read one more project, and its client,
 * without the client being moved away from its owner. It is for viewing:
 * the policy layer counts a share only where a read opts in (`shared: true`),
 * never where anything is changed, billed or summed as the rep's own book.
 *
 * A share is access control, like a user's grants, not the month's work, so
 * a closed month does not freeze it: last month's archive is what a rep most
 * often needs to read, and a share made by mistake must be revocable without
 * reopening every edit in the month.
 */
export class ProjectShareError extends Error {}

export interface ProjectViewer {
  userId: number;
  fullName: string;
  isActive: boolean;
  grantedBy: string | null;
  /** ISO-8601, UTC. */
  grantedAt: string;
}

export interface ShareResult {
  projectId: number;
  userId: number;
  userName: string;
  /** False when the rep already had the share: nothing is written or sent. */
  changed: boolean;
}

/** Who the project is shared with, for the people who decide it. */
export async function projectViewers(actor: Actor, projectId: number): Promise<ProjectViewer[]> {
  if (!can(actor, 'projects.share')) return [];
  const db = getDb();
  if (!(await isProjectVisible(db, actor, projectId))) return [];

  const rows = await db.execute<{
    id: number; full_name: string; is_active: boolean; granted_by: string | null; granted_at: string;
  }>(sql`
    SELECT u.id, u.full_name, u.is_active, g.full_name AS granted_by,
           to_char(pv.granted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS granted_at
    FROM project_viewers pv
    JOIN users u      ON u.id = pv.user_id
    LEFT JOIN users g ON g.id = pv.granted_by
    WHERE pv.project_id = ${projectId}
    ORDER BY u.full_name
  `);
  return rows.map((r) => ({
    userId: Number(r.id),
    fullName: r.full_name,
    isActive: r.is_active === true,
    grantedBy: r.granted_by,
    grantedAt: r.granted_at,
  }));
}

/**
 * The reps it could be shared with: active Sales, not already on the list,
 * and not the project's Sales owner or its client's owner, who see it anyway.
 */
export async function shareCandidates(
  actor: Actor,
  projectId: number,
): Promise<{ id: number; name: string }[]> {
  if (!can(actor, 'projects.share')) return [];
  const db = getDb();
  if (!(await isProjectVisible(db, actor, projectId))) return [];

  const rows = await db.execute<{ id: number; full_name: string }>(sql`
    SELECT u.id, u.full_name
    FROM users u
    WHERE u.role = 'sales' AND u.is_active
      AND NOT EXISTS (
        SELECT 1 FROM project_viewers pv WHERE pv.project_id = ${projectId} AND pv.user_id = u.id)
      AND NOT EXISTS (
        SELECT 1 FROM projects p JOIN clients c ON c.id = p.client_id
        WHERE p.id = ${projectId} AND u.id IN (p.sales_owner_id, c.owner_user_id))
    ORDER BY u.full_name
  `);
  return rows.map((r) => ({ id: Number(r.id), name: r.full_name }));
}

async function authorize(actor: Actor, projectId: number) {
  if (!can(actor, 'projects.share')) {
    throw new ProjectShareError('You are not permitted to share projects.');
  }
  const db = getDb();
  if (!(await isProjectVisible(db, actor, projectId))) throw new ProjectShareError('No such project.');
  return db;
}

async function projectLabel(db: Pick<ReturnType<typeof getDb>, 'execute'>, projectId: number) {
  const [row] = await db.execute<{ project_code: string; title: string; client: string }>(sql`
    SELECT p.project_code, p.title, c.name AS client
    FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.id = ${projectId}
  `);
  return row ? { label: `${row.project_code} · ${row.title}`, client: row.client } : null;
}

/** Lets one Sales rep view the project. The rep is told. */
export async function shareProject(
  actor: Actor,
  input: { projectId: number; userId: number },
): Promise<ShareResult> {
  const db = await authorize(actor, input.projectId);

  const [rep] = await db.execute<{ id: number; full_name: string }>(sql`
    SELECT id, full_name FROM users WHERE id = ${input.userId} AND role = 'sales' AND is_active
  `);
  if (!rep) throw new ProjectShareError('Choose an active Sales representative.');

  return db.transaction(async (tx) => {
    const added = await tx.execute<{ user_id: number }>(sql`
      INSERT INTO project_viewers (project_id, user_id, granted_by)
      VALUES (${input.projectId}, ${input.userId}, ${actor.id})
      ON CONFLICT (project_id, user_id) DO NOTHING
      RETURNING user_id
    `);
    const changed = added.length > 0;

    const info = changed ? await projectLabel(tx, input.projectId) : null;
    if (info) {
      await notifyUsers(tx, [input.userId], {
        type: 'project.shared',
        title: `Project shared with you: ${info.label}`,
        body: `${info.client}. ${actor.fullName} shared it with you to view.`,
        linkPath: `/projects/${input.projectId}`,
        entityType: 'project', entityId: input.projectId,
      }, actor.id);
    }
    return { projectId: input.projectId, userId: input.userId, userName: rep.full_name, changed };
  });
}

/** Takes a share back. The rep is told, without a link they could no longer open. */
export async function unshareProject(
  actor: Actor,
  input: { projectId: number; userId: number },
): Promise<ShareResult> {
  const db = await authorize(actor, input.projectId);

  return db.transaction(async (tx) => {
    const removed = await tx.execute<{ full_name: string }>(sql`
      DELETE FROM project_viewers pv
      USING users u
      WHERE pv.project_id = ${input.projectId} AND pv.user_id = ${input.userId} AND u.id = pv.user_id
      RETURNING u.full_name
    `);
    if (removed.length === 0) {
      throw new ProjectShareError('This project is not shared with that person.');
    }

    const info = await projectLabel(tx, input.projectId);
    if (info) {
      await notifyUsers(tx, [input.userId], {
        type: 'project.unshared',
        title: `Project no longer shared with you: ${info.label}`,
        body: `${info.client}. ${actor.fullName} removed your access.`,
        entityType: 'project', entityId: input.projectId,
      }, actor.id);
    }
    return {
      projectId: input.projectId, userId: input.userId, userName: removed[0].full_name, changed: true,
    };
  });
}
