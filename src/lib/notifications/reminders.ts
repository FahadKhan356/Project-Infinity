import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { loadActorById } from '@/lib/auth/actor';
import { upcomingDeadlines } from './inbox';
import { notifyUsers } from './notify';

/**
 * Stored deadline reminders (brief §20: "deadline approaching" for Team
 * Leads and Executives, "project delayed" for the Project Manager).
 *
 * The inbox already lists what is due, live (inbox.ts). What it cannot do
 * is reach someone who has not opened it, or go out by email and Slack,
 * which only send stored notifications. So a nightly run writes one row
 * per person per item as it crosses each line:
 *
 *   deadline.approaching  once, when the item comes within REMINDER_DAYS
 *   deadline.today        once, on the day
 *   project.delayed       overdue project — once, then again weekly
 *   deadline.overdue      overdue assignment or revision — likewise
 *
 * Each person is reminded of what the inbox would list for them, with one
 * narrowing the brief asks for: a reminder is for the people on the work.
 * Management and administrators, who see every project, are not written to
 * (they have the dashboard's delays), and a Project Manager is reminded of
 * the projects they manage — or of those still in intake, which every PM
 * is told about — not of every colleague's. Team Leads and Executives
 * already see only their own; a Sales rep is reminded of the projects they
 * own, not of one a colleague shared with them to read — the list is asked
 * for without `shared`, so a share never drives a row or a message.
 */
export const REMINDER_DAYS = 3;
const OVERDUE_REPEAT_DAYS = 7;
/** The roles §20 names for deadline and delay reminders, plus the rep who owns the project. */
const REMINDED_ROLES = ['project_manager', 'team_lead', 'executive', 'sales'] as const;

export interface ReminderOutcome {
  usersChecked: number;
  sent: number;
}

export interface ReminderOptions {
  days?: number;
  /** Only these people; the nightly run leaves it out and covers everyone. */
  userIds?: number[];
}

export async function sendDeadlineReminders(options: ReminderOptions = {}): Promise<ReminderOutcome> {
  const db = getDb();
  const days = options.days ?? REMINDER_DAYS;
  const only = options.userIds?.filter(Number.isInteger) ?? null;
  const people = await db.execute<{ id: number }>(sql`
    SELECT id FROM users
    WHERE is_active AND role IN (${sql.join(REMINDED_ROLES.map((r) => sql`${r}`), sql`, `)})
      ${only ? sql`AND id IN (${sql.join([-1, ...only].map((id) => sql`${id}`), sql`, `)})` : sql``}
    ORDER BY id
  `);

  let sent = 0;
  for (const person of people) {
    const actor = await loadActorById(Number(person.id));
    if (!actor?.isActive) continue;

    let items = await upcomingDeadlines(actor, days, { shared: false });
    if (actor.role === 'project_manager' && items.length > 0) {
      const mine = await db.execute<{ id: number }>(sql`
        SELECT id FROM projects
        WHERE id IN (${sql.join([...new Set(items.map((i) => i.projectId))].map((id) => sql`${id}`), sql`, `)})
          AND (project_manager_id = ${actor.id} OR project_manager_id IS NULL)
      `);
      const managed = new Set(mine.map((r) => Number(r.id)));
      items = items.filter((i) => managed.has(i.projectId));
    }

    for (const item of items) {
      const overdue = item.daysLeft < 0;
      const type = overdue
        ? (item.kind === 'project' ? 'project.delayed' : 'deadline.overdue')
        : item.daysLeft === 0 ? 'deadline.today' : 'deadline.approaching';

      const [prior] = await db.execute<{ age_days: number }>(sql`
        SELECT (current_date - created_at::date)::int AS age_days
        FROM notifications
        WHERE user_id = ${actor.id} AND type = ${type}
          AND entity_type = ${item.kind} AND entity_id = ${item.id}
        ORDER BY created_at DESC
        LIMIT 1
      `);
      if (prior && (!overdue || Number(prior.age_days) < OVERDUE_REPEAT_DAYS)) continue;

      const when = overdue
        ? `${-item.daysLeft} day${item.daysLeft === -1 ? '' : 's'} overdue`
        : item.daysLeft === 0 ? 'due today' : `due in ${item.daysLeft} day${item.daysLeft === 1 ? '' : 's'}`;
      sent += await notifyUsers(db, [actor.id], {
        type,
        title: `${overdue ? 'Overdue' : item.daysLeft === 0 ? 'Due today' : 'Deadline approaching'}: ${item.title}`,
        body: `${item.projectCode} · ${when} (${item.due}).`,
        linkPath: item.linkPath,
        entityType: item.kind,
        entityId: item.id,
      });

      // Send WhatsApp alert to CEO & COO if due within 24 hours or overdue
      if (item.daysLeft <= 1) {
        try {
          const [proj] = await db.execute<{ client_name: string }>(sql`
            SELECT c.name AS client_name
            FROM projects p
            JOIN clients c ON c.id = p.client_id
            WHERE p.id = ${item.projectId}
          `);
          import('@/lib/whatsapp/executive-alerts')
            .then(({ notifyExecutivesDeadline }) =>
              notifyExecutivesDeadline({
                projectCode: item.projectCode,
                projectTitle: item.title,
                title: item.title,
                kind: item.kind,
                due: item.due,
                daysLeft: item.daysLeft,
                clientName: proj?.client_name ?? null,
                assigneeName: actor.fullName,
                linkPath: item.linkPath,
              }),
            )
            .catch((e) => console.error('[WhatsApp Deadline Alert Error]', e));
        } catch {
          // Non-blocking
        }
      }
    }
  }
  return { usersChecked: people.length, sent };
}
