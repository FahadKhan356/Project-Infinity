import 'server-only';
import { sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { can, projectScope, revisionScope } from '@/lib/authz';
import { OPEN_REVISION_STATUSES } from '@/lib/revisions/status';

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
  kind: 'project' | 'assignment' | 'revision';
  id: number;
  projectId: number;
  projectCode: string;
  title: string;
  /** Where the item is worked on. */
  linkPath: string;
  /** YYYY-MM-DD */
  due: string;
  /** Negative when overdue. */
  daysLeft: number;
}

/** How far ahead the inbox looks, and so what the header counts. */
export const INBOX_DEADLINE_DAYS = 3;

/**
 * A revision whose revised files have not all gone back to the client: one
 * still being worked, and one approved but not yet delivered.
 */
const OPEN_REVISION = sql`(${sql.join(
  [...OPEN_REVISION_STATUSES, 'approved'].map((s) => sql`${s}`), sql`, `,
)})`;

/**
 * When the slots matched by `slots` that are not yet `finished` fall due
 * (`due_on`). A slot an open revision is about is due when the latest such
 * revision is — the one an upload would answer; the client's feedback set
 * that date, not the plan. An undated revision leaves the plan standing,
 * unless the slot had already cleared QA once: that plan was met, and the
 * rework has no date yet. Every other slot keeps `planned`; with none left,
 * `noneLeft` decides. `revision_ids` names those revisions when every slot
 * left is under one, and is null otherwise.
 */
function outstanding(o: { slots: SQL; finished: SQL; planned: SQL; noneLeft: SQL }): SQL {
  return sql`
    SELECT CASE WHEN count(d.id) = 0 THEN ${o.noneLeft}
                ELSE min(CASE WHEN rv.deadline IS NOT NULL THEN rv.deadline
                              WHEN rv.id IS NOT NULL
                                   AND EXISTS (SELECT 1 FROM deliveries dl WHERE dl.deliverable_id = d.id)
                                THEN NULL
                              ELSE ${o.planned} END) END AS due_on,
           CASE WHEN bool_and(rv.id IS NOT NULL) THEN array_agg(DISTINCT rv.id::text) END AS revision_ids
    FROM deliverables d
    LEFT JOIN LATERAL (
      SELECT r.id, r.deadline
      FROM revision_deliverables rd JOIN revisions r ON r.id = rd.revision_id
      WHERE rd.deliverable_id = d.id AND r.status IN ${OPEN_REVISION}
      ORDER BY r.revision_no DESC
      LIMIT 1
    ) rv ON true
    WHERE ${o.slots} AND d.status NOT IN ${o.finished}
  `;
}

/**
 * "Deadline approaching" (brief §20), computed when asked rather than stored:
 * projects due within the window for everyone who sees projects, and
 * assignments due within it for the person doing them and the leads of
 * their team. Work sent back by a revision is due when the revision is, not
 * on the date first planned. A revision nobody has handed out yet is listed
 * for whoever may hand it out — the lead of a team it touches, or the PM.
 * Overdue items stay until the work is done.
 */
export interface DeadlineOptions {
  /**
   * Also list the projects shared with a Sales rep to view (projectScope's
   * `shared`). On by default: the inbox and the header badge only read. The
   * stored reminders (reminders.ts) pass `false` — a row written and mailed
   * on the rep's behalf is not a read, and a share is not their work.
   */
  shared?: boolean;
}

export async function upcomingDeadlines(
  actor: Actor,
  days = INBOX_DEADLINE_DAYS,
  options: DeadlineOptions = {},
): Promise<Deadline[]> {
  if (!actor.isActive) return [];
  const db = getDb();
  const window = Math.max(0, days | 0);
  const horizon = sql`current_date + ${window}::int`;
  // Cheap to test first: a date inside the window comes from the planned
  // date or from an open revision on the project, so skip the rest.
  const revisionDueBy = (on: SQL) => sql`EXISTS (
    SELECT 1 FROM revisions r WHERE ${on} AND r.status IN ${OPEN_REVISION} AND r.deadline <= ${horizon}
  )`;

  const projectRows = actor.role === 'executive' ? [] : await db.execute<{
    id: number; project_code: string; title: string; due: string; days_left: number;
  }>(sql`
    SELECT p.id, p.project_code, p.title, to_char(x.due_on, 'YYYY-MM-DD') AS due,
           (x.due_on - current_date)::int AS days_left
    FROM projects p
    CROSS JOIN LATERAL (${outstanding({
      slots: sql`d.project_id = p.id`,
      // A project's work is done when its files reach the client.
      finished: sql`('delivered', 'cancelled')`,
      planned: sql`p.deadline`,
      noneLeft: sql`p.deadline`,
    })}) x
    WHERE p.status NOT IN ('completed', 'cancelled', 'delivered')
      AND ${projectScope(actor, 'p', { shared: options.shared ?? true })}
      AND (p.deadline <= ${horizon} OR ${revisionDueBy(sql`r.project_id = p.id`)})
      AND x.due_on <= ${horizon}
    ORDER BY x.due_on, p.id
    LIMIT 100
  `);

  const seesAssignments = actor.role === 'executive' || actor.leadDepartmentIds.length > 0;
  const assignmentRows = !seesAssignments ? [] : await db.execute<{
    id: number; project_id: number; project_code: string; title: string; assignee_id: number;
    due: string; days_left: number; revision_ids: string[] | null;
  }>(sql`
    SELECT a.id, a.project_id, p.project_code, a.title, a.assignee_id, to_char(x.due_on, 'YYYY-MM-DD') AS due,
           (x.due_on - current_date)::int AS days_left, x.revision_ids
    FROM assignments a
    JOIN projects p ON p.id = a.project_id
    JOIN project_departments pd ON pd.id = a.project_department_id
    CROSS JOIN LATERAL (${outstanding({
      slots: sql`d.assignment_id = a.id`,
      // An Executive's part is done when QA approves it.
      finished: sql`('approved', 'delivered', 'cancelled')`,
      planned: sql`a.end_date`,
      // Open-ended work (never given slots, so still planned) keeps its date.
      // Started work with nothing left had its slots handed to a colleague
      // with a revision: there is nothing here to chase.
      noneLeft: sql`CASE WHEN a.status = 'planned' THEN a.end_date END`,
    })}) x
    WHERE a.status NOT IN ('completed', 'cancelled')
      AND (a.end_date <= ${horizon} OR ${revisionDueBy(sql`r.project_id = a.project_id`)})
      AND x.due_on <= ${horizon}
      AND (a.assignee_id = ${actor.id}
           ${actor.leadDepartmentIds.length > 0 && !can(actor, 'projects.viewAll')
             ? sql`OR pd.department_id IN (${sql.join(actor.leadDepartmentIds.map((id) => sql`${id}`), sql`, `)})`
             : sql``})
    ORDER BY x.due_on, a.id
    LIMIT 100
  `);

  // Who may hand a revision out, as assignRevision decides it; revisionScope
  // then narrows a lead to the revisions touching their teams. Once one slot
  // is handed out the revision is 'assigned' and leaves this list — a slot
  // still waiting in another team is its reopened assignment, which that
  // team's lead goes on seeing with the revision's date. A revision the
  // server would refuse to hand out (project held or cancelled, month
  // closed) is not listed as one to hand out.
  const handsOutRevisions = can(actor, 'assignments.create')
    && (actor.leadDepartmentIds.length > 0 || can(actor, 'planning.viewAllDepartments'));
  const revisionRows = !handsOutRevisions ? [] : await db.execute<{
    id: number; project_id: number; project_code: string; revision_no: number; title: string;
    due: string; days_left: number;
  }>(sql`
    SELECT r.id, r.project_id, p.project_code, r.revision_no, r.title,
           to_char(r.deadline, 'YYYY-MM-DD') AS due, (r.deadline - current_date)::int AS days_left
    FROM revisions r
    JOIN projects p ON p.id = r.project_id
    JOIN client_months cm ON cm.id = p.client_month_id
    WHERE r.status = 'new'
      AND r.deadline <= ${horizon}
      AND p.status NOT IN ('on_hold', 'cancelled')
      AND cm.status <> 'closed'
      AND ${revisionScope(actor, 'r')}
    ORDER BY r.deadline, r.id
    LIMIT 100
  `);

  // Work a revision sent back that nobody has handed out yet is, to the lead
  // who will hand it out, that revision's row — not the reopened assignment
  // as well, even when the work is the lead's own: it is one thing to chase.
  const listed = new Set(revisionRows.map((r) => String(r.id)));
  const assignmentItems = assignmentRows.filter((r) =>
    r.revision_ids === null || !r.revision_ids.every((id) => listed.has(String(id))));

  const items: Deadline[] = [
    ...projectRows.map((r) => ({
      kind: 'project' as const, id: Number(r.id), projectId: Number(r.id), projectCode: r.project_code,
      title: r.title, linkPath: `/projects/${r.id}`, due: r.due, daysLeft: Number(r.days_left),
    })),
    ...assignmentItems.map((r) => ({
      kind: 'assignment' as const, id: Number(r.id), projectId: Number(r.project_id), projectCode: r.project_code,
      title: r.title, linkPath: `/projects/${r.project_id}#workspace`, due: r.due, daysLeft: Number(r.days_left),
    })),
    ...revisionRows.map((r) => ({
      kind: 'revision' as const, id: Number(r.id), projectId: Number(r.project_id), projectCode: r.project_code,
      title: `Revision #${String(r.revision_no).padStart(2, '0')}: ${r.title}`, linkPath: `/revisions/${r.id}`,
      due: r.due, daysLeft: Number(r.days_left),
    })),
  ];
  return items.sort((a, b) => a.daysLeft - b.daysLeft || a.title.localeCompare(b.title));
}

/**
 * How many items are due or overdue in the inbox's window — for the header,
 * beside the unread badge. It is the length of the list the inbox shows, so
 * the number on the badge is the number of rows behind it. The list itself
 * is live and has nothing to mark read: the count falls as the work is done.
 * (The nightly run stores a separate reminder row as each item crosses a
 * line — reminders.ts — and those are read like any other notification.)
 */
export async function deadlineCount(actor: Actor, days = INBOX_DEADLINE_DAYS): Promise<number> {
  return (await upcomingDeadlines(actor, days)).length;
}
