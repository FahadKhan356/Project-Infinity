import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { loadActorById } from '@/lib/auth/actor';
import { recordActivity } from '@/lib/auth/audit';
import { copyMonth, copyMonthPlan } from '@/lib/months/copy';
import { MonthError } from '@/lib/months/lifecycle';
import { notifyUsers } from '@/lib/notifications/notify';
import { IntakeError } from './file-project';
import { formatMonth } from './intake';

/**
 * Recurring projects (brief §29): a retainer order marked "repeats every
 * month" is copied into each new month without anyone asking.
 *
 * It is "Copy previous month" (§38) run by a job: the same copy, the same
 * rules, one project at a time. Each recurring project is a chain linked by
 * copied_from_project_id; the job extends every chain whose newest link is
 * in an earlier month into the target month. Running it twice does nothing
 * the second time, because the newest link then already has a copy.
 *
 * The copy is made as the project's Sales owner, with exactly their
 * permissions — the job can do nothing they could not. If they have left, or
 * the target month is closed, the chain is skipped and the Project Managers
 * are told. Paused and churned clients are skipped quietly: that is what
 * pausing a client is for.
 */

export interface RecurringOutcome {
  created: { sourceCode: string; projectId: number; projectCode: string; clientName: string }[];
  skipped: { sourceCode: string; clientName: string; reason: string }[];
}

type Tip = {
  id: number; project_code: string; client_id: number; client_name: string; client_status: string;
  client_month_id: number; sales_owner_id: number;
};

export interface RecurringOptions {
  /** Only these clients' chains; the nightly job leaves it out and covers every client. */
  clientIds?: number[];
}

export async function runRecurring(now = new Date(), options: RecurringOptions = {}): Promise<RecurringOutcome> {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const period = `${year}-${String(month).padStart(2, '0')}`;
  const db = getDb();
  const only = options.clientIds?.filter(Number.isInteger) ?? null;

  const tips = await db.execute<Tip>(sql`
    SELECT p.id, p.project_code, p.client_id, c.name AS client_name, c.status::text AS client_status,
           p.client_month_id, p.sales_owner_id
    FROM projects p
    JOIN client_months cm ON cm.id = p.client_month_id
    JOIN clients c        ON c.id = p.client_id
    WHERE p.recurs_monthly
      AND p.status <> 'cancelled'
      ${only ? sql`AND p.client_id IN (${sql.join([-1, ...only].map((id) => sql`${id}`), sql`, `)})` : sql``}
      AND cm.period_year * 12 + cm.period_month < ${year * 12 + month}
      AND NOT EXISTS (SELECT 1 FROM projects n WHERE n.copied_from_project_id = p.id)
    ORDER BY c.name, p.id
  `);

  const outcome: RecurringOutcome = { created: [], skipped: [] };
  for (const tip of tips) {
    const skip = async (reason: string, tellManagers: boolean) => {
      outcome.skipped.push({ sourceCode: tip.project_code, clientName: tip.client_name, reason });
      if (!tellManagers) return;
      const managers = await db.execute<{ id: number }>(sql`
        SELECT id FROM users WHERE role = 'project_manager' AND is_active`);
      await notifyUsers(db, managers.map((m) => Number(m.id)), {
        type: 'project.recurring_skipped',
        title: `Recurring order not copied: ${tip.project_code}`,
        body: `${tip.client_name} — ${reason}`,
        linkPath: `/projects/${tip.id}`,
        entityType: 'project', entityId: Number(tip.id),
      });
    };

    if (tip.client_status === 'paused' || tip.client_status === 'churned') {
      await skip(`the client is ${tip.client_status}`, false);
      continue;
    }
    const owner = await loadActorById(Number(tip.sales_owner_id));
    if (!owner || !owner.isActive) {
      await skip('its Sales owner is no longer active; reassign the client and copy it by hand', true);
      continue;
    }

    try {
      const plan = await copyMonthPlan(owner, {
        clientId: Number(tip.client_id), fromMonthId: Number(tip.client_month_id), period,
      });
      const source = plan.projects.find((p) => p.id === Number(tip.id));
      if (!source) {
        await skip('its Sales owner can no longer see it', true);
        continue;
      }
      const result = await copyMonth(owner, {
        clientId: Number(tip.client_id),
        fromMonthId: Number(tip.client_month_id),
        period,
        projects: [{
          sourceProjectId: source.id,
          departments: source.departments.map((d) => ({
            departmentId: d.departmentId, plannedDeliverables: d.plannedDeliverables,
          })),
          deadline: source.suggestedDeadline,
        }],
      });
      const copy = result.projects[0];
      outcome.created.push({
        sourceCode: tip.project_code, projectId: copy.projectId, projectCode: copy.projectCode,
        clientName: tip.client_name,
      });

      await recordActivity({
        actorId: owner.id,
        action: 'project.created',
        entityType: 'project',
        entityId: copy.projectId,
        projectId: copy.projectId,
        clientId: Number(tip.client_id),
        metadata: {
          projectCode: copy.projectCode, copiedFromCode: tip.project_code, copiedFromId: Number(tip.id),
          recurring: true,
        },
      });
      // Filing tells the Project Managers; the owner hears it was done for them.
      await notifyUsers(db, [owner.id], {
        type: 'project.recurring_created',
        title: `Recurring order filed: ${copy.projectCode}`,
        body: `${tip.client_name} — ${copy.title}, ${formatMonth(year, month)}`,
        linkPath: `/projects/${copy.projectId}`,
        entityType: 'project', entityId: copy.projectId,
      });
    } catch (error) {
      if (error instanceof MonthError || error instanceof IntakeError) {
        await skip(error.message, true);
        continue;
      }
      throw error;
    }
  }
  return outcome;
}
