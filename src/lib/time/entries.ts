import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { assertMonthOpen } from '@/lib/months/lifecycle';

export class TimeError extends Error {}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 24 * 60;
/** How far back an entry may be dated: long enough for a forgotten week, short enough to stay honest. */
export const BACKDATE_DAYS = 31;

export interface TimeEntryInput {
  assignmentId: number;
  workDate: string;
  minutes: number;
  note?: string | null;
}

/**
 * A person records time on work they hold (brief §29, time tracking).
 *
 * Time is always one's own: nobody logs hours for someone else, so the
 * productivity reports built on it measure what people said they did. The
 * entry hangs off the assignment, which already knows its project, team,
 * client and month, and the month must be open like any other change (§36).
 */
export async function logTime(actor: Actor, input: TimeEntryInput): Promise<{ entryId: number }> {
  if (!actor.isActive) throw new TimeError('Your account is inactive.');
  if (!DATE.test(input.workDate)) throw new TimeError('Choose the day the work was done.');
  if (!Number.isInteger(input.minutes) || input.minutes <= 0 || input.minutes > DAY) {
    throw new TimeError('Enter between a minute and 24 hours.');
  }
  const note = input.note?.trim().slice(0, 500) || null;

  const db = getDb();
  const [a] = await db.execute<{ project_id: number; assignee_id: number; project_status: string; too_new: boolean; too_old: boolean }>(sql`
    SELECT a.project_id, a.assignee_id, p.status AS project_status,
           (${input.workDate}::date > CURRENT_DATE) AS too_new,
           (${input.workDate}::date < CURRENT_DATE - ${BACKDATE_DAYS}::int) AS too_old
    FROM assignments a JOIN projects p ON p.id = a.project_id
    WHERE a.id = ${input.assignmentId}
  `);
  // Someone else's assignment looks exactly like one that does not exist.
  if (!a || Number(a.assignee_id) !== actor.id) throw new TimeError('Choose one of your assignments.');
  if (a.project_status === 'cancelled') throw new TimeError('That project was cancelled.');
  if (a.too_new) throw new TimeError('Time cannot be logged for a day that has not happened yet.');
  if (a.too_old) throw new TimeError(`Time can be logged up to ${BACKDATE_DAYS} days back. Ask your Team Lead about older work.`);
  const projectId = Number(a.project_id);
  await assertMonthOpen(db, { projectId }, (m) => new TimeError(m));

  return db.transaction(async (tx) => {
    // One person's entries for a day are checked together, so two tabs
    // cannot each add 20 hours to the same day.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('time_entries'), ${actor.id}::int)`);
    const [day] = await tx.execute<{ total: number }>(sql`
      SELECT COALESCE(sum(minutes), 0)::int AS total FROM time_entries
      WHERE user_id = ${actor.id} AND work_date = ${input.workDate}
    `);
    if (Number(day.total) + input.minutes > DAY) {
      throw new TimeError(`That would make more than 24 hours on ${input.workDate}.`);
    }
    const [row] = await tx.execute<{ id: number }>(sql`
      INSERT INTO time_entries (assignment_id, project_id, user_id, work_date, minutes, note)
      VALUES (${input.assignmentId}, ${projectId}, ${actor.id}, ${input.workDate}, ${input.minutes}, ${note})
      RETURNING id
    `);
    return { entryId: Number(row.id) };
  });
}

/** Only the person who logged an entry removes it, and only while its month is open. */
export async function deleteTime(actor: Actor, entryId: number): Promise<{ projectId: number }> {
  const db = getDb();
  const [row] = await db.execute<{ project_id: number; user_id: number }>(sql`
    SELECT project_id, user_id FROM time_entries WHERE id = ${entryId}
  `);
  if (!row || Number(row.user_id) !== actor.id) throw new TimeError('No such entry.');
  await assertMonthOpen(db, { projectId: Number(row.project_id) }, (m) => new TimeError(m));
  await db.execute(sql`DELETE FROM time_entries WHERE id = ${entryId} AND user_id = ${actor.id}`);
  return { projectId: Number(row.project_id) };
}

export interface MyTimeEntry {
  id: number;
  workDate: string;
  minutes: number;
  note: string | null;
  assignmentTitle: string;
  projectId: number;
  projectCode: string;
  projectTitle: string;
  monthClosed: boolean;
}

export async function myTimeEntries(actor: Actor, days = 14): Promise<MyTimeEntry[]> {
  const rows = await getDb().execute<{
    id: number; work_date: string; minutes: number; note: string | null; assignment_title: string;
    project_id: number; project_code: string; project_title: string; month_closed: boolean;
  }>(sql`
    SELECT t.id, t.work_date::text AS work_date, t.minutes, t.note, a.title AS assignment_title,
           p.id AS project_id, p.project_code, p.title AS project_title,
           (cm.status = 'closed') AS month_closed
    FROM time_entries t
    JOIN assignments a    ON a.id = t.assignment_id
    JOIN projects p       ON p.id = t.project_id
    JOIN client_months cm ON cm.id = p.client_month_id
    WHERE t.user_id = ${actor.id} AND t.work_date >= CURRENT_DATE - ${days}::int
    ORDER BY t.work_date DESC, t.id DESC
  `);
  return rows.map((r) => ({
    id: Number(r.id), workDate: r.work_date, minutes: Number(r.minutes), note: r.note,
    assignmentTitle: r.assignment_title, projectId: Number(r.project_id),
    projectCode: r.project_code, projectTitle: r.project_title, monthClosed: r.month_closed === true,
  }));
}

export interface LoggableAssignment {
  id: number;
  title: string;
  projectCode: string;
  projectTitle: string;
  clientName: string;
}

/** What a person can log against: their own assignments on live projects in open months. */
export async function loggableAssignments(actor: Actor): Promise<LoggableAssignment[]> {
  const rows = await getDb().execute<{
    id: number; title: string; project_code: string; project_title: string; client_name: string;
  }>(sql`
    SELECT a.id, a.title, p.project_code, p.title AS project_title, c.name AS client_name
    FROM assignments a
    JOIN projects p       ON p.id = a.project_id
    JOIN clients c        ON c.id = p.client_id
    JOIN client_months cm ON cm.id = p.client_month_id
    WHERE a.assignee_id = ${actor.id}
      AND a.status <> 'cancelled' AND p.status <> 'cancelled' AND cm.status = 'open'
      AND (a.status <> 'completed' OR a.updated_at > now() - make_interval(days => ${BACKDATE_DAYS}))
    ORDER BY (a.status = 'completed'), p.project_code, a.title
  `);
  return rows.map((r) => ({
    id: Number(r.id), title: r.title, projectCode: r.project_code,
    projectTitle: r.project_title, clientName: r.client_name,
  }));
}
