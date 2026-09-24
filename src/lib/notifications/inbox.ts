import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { can, projectScope } from '@/lib/authz';

export interface InboxItem {
  id: number;
  type: string;
  title: string;
  body: string | null;
  linkPath: string | null;
  isRead: boolean;
  /** ISO-8601, UTC. */
  createdAt: string;
}

/** A person's own notifications, newest first. Nobody reads anyone else's. */
export async function inbox(actor: Actor, options: { limit?: number; unreadOnly?: boolean } = {}): Promise<InboxItem[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const rows = await getDb().execute<{
    id: number; type: string; title: string; body: string | null; link_path: string | null;
    is_read: boolean; created_at: string;
  }>(sql`
    SELECT id, type, title, body, link_path, is_read,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
    FROM notifications
    WHERE user_id = ${actor.id} ${options.unreadOnly ? sql`AND NOT is_read` : sql``}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    id: Number(r.id), type: r.type, title: r.title, body: r.body, linkPath: r.link_path,
    isRead: r.is_read === true, createdAt: r.created_at,
  }));
}

export async function unreadCount(actor: Actor): Promise<number> {
  const [{ n }] = await getDb().execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM notifications WHERE user_id = ${actor.id} AND NOT is_read
  `);
  return Number(n);
}

/** Marks one of the actor's own notifications read; returns its link, if any. */
export async function markRead(actor: Actor, id: number): Promise<{ linkPath: string | null } | null> {
  const rows = await getDb().execute<{ link_path: string | null }>(sql`
    UPDATE notifications SET is_read = true, read_at = COALESCE(read_at, now())
    WHERE id = ${id} AND user_id = ${actor.id}
    RETURNING link_path
  `);
  return rows[0] ? { linkPath: rows[0].link_path } : null;
}

export async function markAllRead(actor: Actor): Promise<number> {
  const rows = await getDb().execute<{ id: number }>(sql`
    UPDATE notifications SET is_read = true, read_at = now()
    WHERE user_id = ${actor.id} AND NOT is_read RETURNING id
  `);
  return rows.length;
}

export interface Deadline {
  kind: 'project' | 'assignment';
  id: number;
  projectId: number;
  projectCode: string;
  title: string;
  /** YYYY-MM-DD */
  due: string;
  /** Negative when overdue. */
  daysLeft: number;
}

/**
 * "Deadline approaching" (brief §20), computed when asked rather than stored:
 * projects due within the window for everyone who sees projects, and
 * assignments due within it for the person doing them and the leads of
 * their team. Overdue items stay until the work is done.
 */
export async function upcomingDeadlines(actor: Actor, days = 3): Promise<Deadline[]> {
  if (!actor.isActive) return [];
  const db = getDb();
  const window = Math.max(0, days | 0);

  const projectRows = actor.role === 'executive' ? [] : await db.execute<{
    id: number; project_code: string; title: string; due: string; days_left: number;
  }>(sql`
    SELECT p.id, p.project_code, p.title, to_char(p.deadline, 'YYYY-MM-DD') AS due,
           (p.deadline - current_date)::int AS days_left
    FROM projects p
    WHERE p.deadline IS NOT NULL
      AND p.deadline <= current_date + ${window}::int
      AND p.status NOT IN ('completed', 'cancelled', 'delivered')
      AND ${projectScope(actor, 'p')}
    ORDER BY p.deadline, p.id
    LIMIT 100
  `);

  const seesAssignments = actor.role === 'executive' || actor.leadDepartmentIds.length > 0;
  const assignmentRows = !seesAssignments ? [] : await db.execute<{
    id: number; project_id: number; project_code: string; title: string; due: string; days_left: number;
  }>(sql`
    SELECT a.id, a.project_id, p.project_code, a.title, to_char(a.end_date, 'YYYY-MM-DD') AS due,
           (a.end_date - current_date)::int AS days_left
    FROM assignments a
    JOIN projects p ON p.id = a.project_id
    JOIN project_departments pd ON pd.id = a.project_department_id
    WHERE a.end_date IS NOT NULL
      AND a.end_date <= current_date + ${window}::int
      AND a.status NOT IN ('completed', 'cancelled')
      AND (a.assignee_id = ${actor.id}
           ${actor.leadDepartmentIds.length > 0 && !can(actor, 'projects.viewAll')
             ? sql`OR pd.department_id IN (${sql.join(actor.leadDepartmentIds.map((id) => sql`${id}`), sql`, `)})`
             : sql``})
    ORDER BY a.end_date, a.id
    LIMIT 100
  `);

  const items: Deadline[] = [
    ...projectRows.map((r) => ({
      kind: 'project' as const, id: Number(r.id), projectId: Number(r.id), projectCode: r.project_code,
      title: r.title, due: r.due, daysLeft: Number(r.days_left),
    })),
    ...assignmentRows.map((r) => ({
      kind: 'assignment' as const, id: Number(r.id), projectId: Number(r.project_id), projectCode: r.project_code,
      title: r.title, due: r.due, daysLeft: Number(r.days_left),
    })),
  ];
  return items.sort((a, b) => a.daysLeft - b.daysLeft || a.title.localeCompare(b.title));
}
