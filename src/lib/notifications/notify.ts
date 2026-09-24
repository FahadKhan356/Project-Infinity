import 'server-only';
import { sql } from 'drizzle-orm';
import type { getDb } from '@/db';

/** Anything that can run a statement — the pool or a transaction. */
type Executor = Pick<ReturnType<typeof getDb>, 'execute'>;

/**
 * In-app notifications (brief §20). Each event below decides who needs to
 * know and writes one row per person; the person who did the thing is never
 * told about it. Called inside the transaction that makes the change, so a
 * notification never describes something that was rolled back.
 *
 * Deadline reminders are not stored — they are computed live in the inbox
 * (see inbox.ts), so there is nothing to schedule and nothing goes stale.
 */
export interface Notice {
  type: string;
  title: string;
  body?: string | null;
  linkPath?: string | null;
  entityType?: string | null;
  entityId?: number | null;
}

export async function notifyUsers(
  db: Executor,
  userIds: Iterable<number>,
  notice: Notice,
  exclude?: number,
): Promise<number> {
  const ids = [...new Set([...userIds].map(Number).filter((id) => Number.isInteger(id) && id !== exclude))];
  if (ids.length === 0) return 0;

  // A notification must never break the action it describes. Inside a
  // transaction the insert runs under a savepoint, so a failure here — a
  // recipient deleted a moment ago, say — rolls back the notification alone
  // and the caller's work goes through. Outside one, a failed insert simply
  // fails on its own.
  let savepoint = false;
  try {
    await db.execute(sql`SAVEPOINT notify`);
    savepoint = true;
  } catch {
    savepoint = false;
  }
  try {
    await db.execute(sql`
      INSERT INTO notifications (user_id, type, title, body, link_path, entity_type, entity_id)
      SELECT u.id, ${notice.type}, ${notice.title}, ${notice.body ?? null}, ${notice.linkPath ?? null},
             ${notice.entityType ?? null}, ${notice.entityId ?? null}
      FROM users u
      WHERE u.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) AND u.is_active
    `);
    if (savepoint) await db.execute(sql`RELEASE SAVEPOINT notify`);
    return ids.length;
  } catch (error) {
    if (savepoint) await db.execute(sql`ROLLBACK TO SAVEPOINT notify`);
    console.error('[notify] failed to record notification', notice.type, error);
    return 0;
  }
}

/* ----------------------------------------------------------- recipients */

async function projectManagers(db: Executor): Promise<number[]> {
  const rows = await db.execute<{ id: number }>(sql`
    SELECT id FROM users WHERE role = 'project_manager' AND is_active
  `);
  return rows.map((r) => Number(r.id));
}

type ProjectInfo = { code: string; title: string; client: string; salesOwnerId: number; managerId: number | null };

async function project(db: Executor, projectId: number): Promise<ProjectInfo | null> {
  const rows = await db.execute<{
    project_code: string; title: string; client: string; sales_owner_id: number; project_manager_id: number | null;
  }>(sql`
    SELECT p.project_code, p.title, c.name AS client, p.sales_owner_id, p.project_manager_id
    FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.id = ${projectId}
  `);
  const r = rows[0];
  return r ? {
    code: r.project_code, title: r.title, client: r.client,
    salesOwnerId: Number(r.sales_owner_id),
    managerId: r.project_manager_id === null ? null : Number(r.project_manager_id),
  } : null;
}

/** The PMs to tell about a project: the one on it, or all of them until someone is. */
async function managersFor(db: Executor, info: ProjectInfo): Promise<number[]> {
  return info.managerId !== null ? [info.managerId] : projectManagers(db);
}

async function leadsOf(db: Executor, projectId: number, departmentIds?: number[]): Promise<number[]> {
  const rows = await db.execute<{ team_lead_id: number }>(sql`
    SELECT DISTINCT pd.team_lead_id FROM project_departments pd
    WHERE pd.project_id = ${projectId} AND pd.team_lead_id IS NOT NULL
      ${departmentIds && departmentIds.length > 0
        ? sql`AND pd.department_id IN (${sql.join(departmentIds.map((id) => sql`${id}`), sql`, `)})`
        : sql``}
  `);
  return rows.map((r) => Number(r.team_lead_id));
}

async function slotContext(db: Executor, deliverableId: number) {
  const rows = await db.execute<{
    project_id: number; department_id: number; assignee_id: number | null; name: string;
  }>(sql`
    SELECT d.project_id, pd.department_id, a.assignee_id, d.name
    FROM deliverables d
    JOIN project_departments pd ON pd.id = d.project_department_id
    LEFT JOIN assignments a ON a.id = d.assignment_id
    WHERE d.id = ${deliverableId}
  `);
  const r = rows[0];
  return r ? {
    projectId: Number(r.project_id), departmentId: Number(r.department_id),
    assigneeId: r.assignee_id === null ? null : Number(r.assignee_id), name: r.name,
  } : null;
}

const label = (info: ProjectInfo) => `${info.code} · ${info.title}`;

/* --------------------------------------------------------------- events */

/** §20 PM: new project created. */
export async function onProjectFiled(db: Executor, input: { projectId: number; actorId: number }) {
  const info = await project(db, input.projectId);
  if (!info) return;
  await notifyUsers(db, await projectManagers(db), {
    type: 'project.created',
    title: `New project: ${label(info)}`,
    body: `${info.client}. Waiting in intake for a Project Manager.`,
    linkPath: `/projects/${input.projectId}`,
    entityType: 'project', entityId: input.projectId,
  }, input.actorId);
}

/** §20 Team Lead: new project assigned; Sales: project approved by PM. */
export async function onProjectRouted(db: Executor, input: {
  projectId: number; newLeadIds: number[]; actorId: number;
}) {
  const info = await project(db, input.projectId);
  if (!info) return;
  await notifyUsers(db, input.newLeadIds, {
    type: 'project.assigned',
    title: `New project for your team: ${label(info)}`,
    body: `${info.client}. Plan it and assign your executives.`,
    linkPath: `/projects/${input.projectId}`,
    entityType: 'project', entityId: input.projectId,
  }, input.actorId);
  await notifyUsers(db, [info.salesOwnerId], {
    type: 'project.routed',
    title: `Project routed by the PM: ${label(info)}`,
    body: 'The Project Manager has reviewed it and assigned the teams.',
    linkPath: `/projects/${input.projectId}`,
    entityType: 'project', entityId: input.projectId,
  }, input.actorId);
}

/** §20 Executive: new task assigned. */
export async function onAssignmentCreated(db: Executor, input: {
  projectId: number; assignmentId: number; assigneeId: number; title: string; deliverables: number;
  endDate?: string | null; actorId: number;
}) {
  const info = await project(db, input.projectId);
  if (!info) return;
  await notifyUsers(db, [input.assigneeId], {
    type: 'assignment.created',
    title: `New task: ${input.title}`,
    body: `${label(info)} — ${input.deliverables} deliverable${input.deliverables === 1 ? '' : 's'}`
      + (input.endDate ? `, due ${input.endDate}` : '') + '.',
    linkPath: `/projects/${input.projectId}#workspace`,
    entityType: 'assignment', entityId: input.assignmentId,
  }, input.actorId);
}

/** §20 Team Lead: executive uploaded a file, QA required; PM: deliverable uploaded. */
export async function onDeliverableUploaded(db: Executor, input: {
  deliverableId: number; versionNo: number; revisionNo?: number | null; actorId: number;
}) {
  const slot = await slotContext(db, input.deliverableId);
  if (!slot) return;
  const info = await project(db, slot.projectId);
  if (!info) return;
  const what = `${slot.name} v${input.versionNo}${input.revisionNo ? ` (revision #${input.revisionNo})` : ''}`;
  await notifyUsers(db, await leadsOf(db, slot.projectId, [slot.departmentId]), {
    type: 'deliverable.uploaded',
    title: `QA needed: ${what}`,
    body: `${label(info)}. Uploaded and waiting in your QA panel.`,
    linkPath: '/qa',
    entityType: 'deliverable', entityId: input.deliverableId,
  }, input.actorId);
  await notifyUsers(db, await managersFor(db, info), {
    type: 'deliverable.uploaded',
    title: `Uploaded: ${what}`,
    body: `${label(info)}. Now with the Team Lead for QA.`,
    linkPath: `/projects/${slot.projectId}#workspace`,
    entityType: 'deliverable', entityId: input.deliverableId,
  }, input.actorId);
}

/** §20: QA approved / rejected, QA required (PM stage), ready for delivery. */
export async function onQaReviewed(db: Executor, input: {
  deliverableId: number; versionNo: number; stage: 'team_lead' | 'project_manager';
  decision: 'approved' | 'rejected' | 'changes_requested';
  newStatus: 'awaiting_pm_qa' | 'approved' | 'changes_requested';
  comments?: string | null; actorId: number;
}) {
  const slot = await slotContext(db, input.deliverableId);
  if (!slot) return;
  const info = await project(db, slot.projectId);
  if (!info) return;
  const what = `${slot.name} v${input.versionNo}`;
  const entity = { entityType: 'deliverable', entityId: input.deliverableId };
  const assignee = slot.assigneeId === null ? [] : [slot.assigneeId];

  if (input.decision !== 'approved') {
    const verb = input.decision === 'rejected' ? 'rejected' : 'sent back';
    await notifyUsers(db, assignee, {
      type: 'qa.rejected',
      title: `${what} ${verb} in QA`,
      body: `${label(info)}.${input.comments ? ` “${input.comments}”` : ''} Upload a new version.`,
      linkPath: `/projects/${slot.projectId}#workspace`, ...entity,
    }, input.actorId);
    // A PM rejection goes past the lead who approved it; they need to know too.
    if (input.stage === 'project_manager') {
      await notifyUsers(db, await leadsOf(db, slot.projectId, [slot.departmentId]), {
        type: 'qa.rejected',
        title: `PM ${verb} ${what}`,
        body: `${label(info)}.${input.comments ? ` “${input.comments}”` : ''}`,
        linkPath: `/projects/${slot.projectId}#workspace`, ...entity,
      }, input.actorId);
    }
    await notifyUsers(db, [info.salesOwnerId], {
      type: 'qa.rejected',
      title: `QA ${verb} ${what}`,
      body: `${label(info)}. A new version will follow.`,
      linkPath: `/projects/${slot.projectId}#workspace`, ...entity,
    }, input.actorId);
    return;
  }

  if (input.newStatus === 'awaiting_pm_qa') {
    await notifyUsers(db, await managersFor(db, info), {
      type: 'qa.required',
      title: `QA needed: ${what}`,
      body: `${label(info)}. Approved by the Team Lead; needs your sign-off.`,
      linkPath: '/qa', ...entity,
    }, input.actorId);
    return;
  }

  await notifyUsers(db, assignee, {
    type: 'qa.approved',
    title: `${what} approved`,
    body: `${label(info)}. It has cleared QA.`,
    linkPath: `/projects/${slot.projectId}#workspace`, ...entity,
  }, input.actorId);
  await notifyUsers(db, [info.salesOwnerId], {
    type: 'delivery.ready',
    title: `Ready for delivery: ${what}`,
    body: `${label(info)}. Approved and waiting in your delivery queue.`,
    linkPath: '/deliveries', ...entity,
  }, input.actorId);
}

/** §20 PM: revision created; Team Lead and Executive: revision received. */
export async function onRevisionCreated(db: Executor, input: {
  projectId: number; revisionId: number; revisionNo: number; title: string;
  deliverableIds: number[]; actorId: number;
}) {
  const info = await project(db, input.projectId);
  if (!info) return;
  const slots = (await Promise.all(input.deliverableIds.map((id) => slotContext(db, id))))
    .filter((s): s is NonNullable<typeof s> => s !== null);
  const departmentIds = [...new Set(slots.map((s) => s.departmentId))];
  const assignees = slots.map((s) => s.assigneeId).filter((id): id is number => id !== null);
  const notice = {
    type: 'revision.created',
    title: `Revision #${String(input.revisionNo).padStart(2, '0')}: ${input.title}`,
    body: `${label(info)} — ${slots.map((s) => s.name).join(', ')}.`,
    linkPath: `/revisions/${input.revisionId}`,
    entityType: 'revision', entityId: input.revisionId,
  };
  await notifyUsers(db, await managersFor(db, info), notice, input.actorId);
  await notifyUsers(db, await leadsOf(db, input.projectId, departmentIds), notice, input.actorId);
  await notifyUsers(db, assignees, { ...notice, body: `${notice.body} Your slot is back with you.` }, input.actorId);
}

/** §20 Executive: revision assigned to them. */
export async function onRevisionAssigned(db: Executor, input: {
  projectId: number; revisionId: number; revisionNo: number; title: string;
  deliverableName: string; assigneeId: number; actorId: number;
}) {
  const info = await project(db, input.projectId);
  if (!info) return;
  await notifyUsers(db, [input.assigneeId], {
    type: 'revision.assigned',
    title: `Revision #${String(input.revisionNo).padStart(2, '0')} assigned to you: ${input.deliverableName}`,
    body: `${label(info)} — ${input.title}.`,
    linkPath: `/revisions/${input.revisionId}`,
    entityType: 'revision', entityId: input.revisionId,
  }, input.actorId);
}
