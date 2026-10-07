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
 * Deadline reminders are computed live in the inbox (see inbox.ts), so the
 * list there never goes stale; the nightly run (reminders.ts) also stores one
 * as each item crosses a line, so the badge lights up and the email and chat
 * channels, which send stored rows only, can carry it.
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
  // transaction the insert runs in a nested one — a savepoint — so a failure
  // here, a recipient deleted a moment ago say, rolls back the notification
  // alone and the caller's work goes through. It has to be the driver's own
  // savepoint: postgres.js remembers any query that failed inside a
  // transaction and throws it again at commit, so a raw SAVEPOINT caught in
  // JavaScript would still take the whole action down with it.
  const insert = sql`
    INSERT INTO notifications (user_id, type, title, body, link_path, entity_type, entity_id)
    SELECT u.id, ${notice.type}, ${notice.title}, ${notice.body ?? null}, ${notice.linkPath ?? null},
           ${notice.entityType ?? null}, ${notice.entityId ?? null}
    FROM users u
    WHERE u.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) AND u.is_active
    -- Locks each recipient while the row is written; one removed a moment
    -- ago is skipped rather than failing the insert for everyone else.
    FOR KEY SHARE OF u
  `;
  try {
    const nestable = db as Executor & Partial<Pick<ReturnType<typeof getDb>, 'transaction'>>;
    if (typeof nestable.transaction === 'function') {
      await nestable.transaction(async (inner) => { await inner.execute(insert); });
    } else {
      await db.execute(insert);
    }
    return ids.length;
  } catch (error) {
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

type ProjectInfo = {
  code: string; title: string; client: string; salesOwnerId: number; managerId: number | null;
  /** The Sales rep who owns the client — not always the one who filed. */
  clientOwnerId: number | null;
};

async function project(db: Executor, projectId: number): Promise<ProjectInfo | null> {
  const rows = await db.execute<{
    project_code: string; title: string; client: string; sales_owner_id: number; project_manager_id: number | null;
    client_owner_id: number | null;
  }>(sql`
    SELECT p.project_code, p.title, c.name AS client, p.sales_owner_id, p.project_manager_id,
           co.id AS client_owner_id
    FROM projects p JOIN clients c ON c.id = p.client_id
    -- A rep moved to another role keeps their clients until an admin hands
    -- them on, but no longer sees those projects: they are not told either.
    LEFT JOIN users co ON co.id = c.owner_user_id AND co.role = 'sales'
    WHERE p.id = ${projectId}
  `);
  const r = rows[0];
  return r ? {
    code: r.project_code, title: r.title, client: r.client,
    salesOwnerId: Number(r.sales_owner_id),
    managerId: r.project_manager_id === null ? null : Number(r.project_manager_id),
    clientOwnerId: r.client_owner_id === null ? null : Number(r.client_owner_id),
  } : null;
}

/**
 * Sales on a project: its owner, and the client's Sales representative
 * (brief §31) — usually one person. When a PM or management filed it they
 * are two, and it is still the rep who talks to the client and delivers (§14).
 */
const salesFor = (info: ProjectInfo): number[] =>
  info.clientOwnerId === null ? [info.salesOwnerId] : [info.salesOwnerId, info.clientOwnerId];

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

async function fullName(db: Executor, userId: number): Promise<string | null> {
  const rows = await db.execute<{ full_name: string }>(sql`SELECT full_name FROM users WHERE id = ${userId}`);
  return rows[0]?.full_name ?? null;
}

const label = (info: ProjectInfo) => `${info.code} · ${info.title}`;
/** "#03", as the client numbers it. */
const revisionTag = (revisionNo: number) => `#${String(revisionNo).padStart(2, '0')}`;
/** "Video 01 v3", or "Video 01 v3 (revision #02)" when the version answers one. */
const versionLabel = (name: string, versionNo: number, revisionNo?: number | null) =>
  `${name} v${versionNo}${revisionNo ? ` (revision ${revisionTag(revisionNo)})` : ''}`;
const deliverableCount = (n: number) => `${n} deliverable${n === 1 ? '' : 's'}`;
/** The first line's worth of what was said, on one line. */
const excerpt = (body: string, max = 120) => {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/** The revision a version was uploaded to answer, if any. */
async function versionRevisionNo(db: Executor, deliverableId: number, versionNo: number): Promise<number | null> {
  const rows = await db.execute<{ revision_no: number }>(sql`
    SELECT r.revision_no FROM deliverable_versions v JOIN revisions r ON r.id = v.revision_id
    WHERE v.deliverable_id = ${deliverableId} AND v.version_no = ${versionNo}
  `);
  return rows[0] ? Number(rows[0].revision_no) : null;
}

/* --------------------------------------------------------------- events */

/** §20 PM: new project created; Sales: project created for their client. */
export async function onProjectFiled(db: Executor, input: { projectId: number; actorId: number }) {
  const info = await project(db, input.projectId);
  if (!info) return;
  const managers = await projectManagers(db);
  await notifyUsers(db, managers, {
    type: 'project.created',
    title: `New project: ${label(info)}`,
    body: `${info.client}. Waiting in the Project Closure Report for a Project Manager.`,
    linkPath: `/projects/${input.projectId}`,
    entityType: 'project', entityId: input.projectId,
  }, input.actorId);

  // A rep filing their own order needs no telling. One filed for their client
  // by someone else — a PM, management, a colleague, the monthly copy — does.
  const reps = salesFor(info).filter((id) => id !== input.actorId && !managers.includes(id));
  if (reps.length === 0) return;
  const filer = await fullName(db, input.actorId);
  await notifyUsers(db, reps, {
    type: 'project.created',
    title: `Project created for your client: ${label(info)}`,
    body: `${info.client}. Filed by ${filer ?? 'a colleague'}; waiting in the Project Closure Report for a Project Manager.`,
    linkPath: `/projects/${input.projectId}`,
    entityType: 'project', entityId: input.projectId,
  }, input.actorId);
}

/**
 * §20 Team Lead: new project assigned; Sales: project approved by PM; PM:
 * Team Lead assigned, when someone else re-routed a project they had.
 */
export async function onProjectRouted(db: Executor, input: {
  projectId: number; newLeadIds: number[]; actorId: number;
  /** The PM on it before this routing; none while it was still in intake. */
  previousManagerId?: number | null;
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
  // A re-save that changes priority or notes is not a routing: Sales hears
  // about it only when a team actually gained its lead.
  if (input.newLeadIds.length === 0) return;
  await notifyUsers(db, salesFor(info), {
    type: 'project.routed',
    title: `Project routed by the PM: ${label(info)}`,
    body: 'The Project Manager has reviewed it and assigned the teams.',
    linkPath: `/projects/${input.projectId}`,
    entityType: 'project', entityId: input.projectId,
  }, input.actorId);

  // The PM who did the routing is not told about their own click.
  if (!input.previousManagerId || input.previousManagerId === input.actorId) return;
  const leads = await db.execute<{ full_name: string }>(sql`
    SELECT full_name FROM users
    WHERE id IN (${sql.join(input.newLeadIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY full_name
  `);
  const router = await fullName(db, input.actorId);
  await notifyUsers(db, [input.previousManagerId], {
    type: 'project.lead_assigned',
    title: `Team Lead assigned: ${label(info)}`,
    body: `${info.client}. Routed by ${router ?? 'a colleague'} to ${leads.map((l) => l.full_name).join(', ')}.`,
    linkPath: `/projects/${input.projectId}`,
    entityType: 'project', entityId: input.projectId,
  }, input.actorId);
}

/**
 * §20 Executive: new project assigned (their first task on it) or new task
 * assigned; Team Lead: new task in their team, when someone else planned it;
 * PM: Team Lead assigned.
 */
export async function onAssignmentCreated(db: Executor, input: {
  projectId: number; assignmentId: number; assigneeId: number; title: string; deliverables: number;
  endDate?: string | null; actorId: number;
}) {
  const info = await project(db, input.projectId);
  if (!info) return;
  const what = deliverableCount(input.deliverables) + (input.endDate ? `, due ${input.endDate}` : '');

  const [team] = await db.execute<{
    project_department_id: number; team_lead_id: number | null; assignee: string; by_lead: boolean;
    first_on_project: boolean;
  }>(sql`
    SELECT a.project_department_id, pd.team_lead_id, u.full_name AS assignee,
           EXISTS (SELECT 1 FROM department_members dm
                   WHERE dm.user_id = ${input.actorId} AND dm.department_id = pd.department_id
                     AND dm.is_lead) AS by_lead,
           -- The project is news to the assignee when this is their first
           -- work on it and no team of it was routed to them as its lead.
           NOT EXISTS (SELECT 1 FROM assignments x
                       WHERE x.project_id = a.project_id AND x.assignee_id = a.assignee_id AND x.id <> a.id)
           AND NOT EXISTS (SELECT 1 FROM project_departments x
                           WHERE x.project_id = a.project_id AND x.team_lead_id = a.assignee_id) AS first_on_project
    FROM assignments a
    JOIN project_departments pd ON pd.id = a.project_department_id
    JOIN users u ON u.id = a.assignee_id
    WHERE a.id = ${input.assignmentId}
  `);
  if (!team) return;
  // An Executive's first task on a project is how the project reaches them
  // (§20 "new project assigned"); every task after that is a task.
  await notifyUsers(db, [input.assigneeId], team.first_on_project === true ? {
    type: 'assignment.created',
    title: `New project assigned: ${label(info)}`,
    body: `${info.client}. First task: ${input.title} — ${what}.`,
    linkPath: `/projects/${input.projectId}#workspace`,
    entityType: 'assignment', entityId: input.assignmentId,
  } : {
    type: 'assignment.created',
    title: `New task: ${input.title}`,
    body: `${label(info)} — ${what}.`,
    linkPath: `/projects/${input.projectId}#workspace`,
    entityType: 'assignment', entityId: input.assignmentId,
  }, input.actorId);

  const leadId = team.team_lead_id === null ? null : Number(team.team_lead_id);
  const body = `${label(info)} — for ${team.assignee}, ${what}.`;
  // A lead handed work of their own already has the notice above.
  await notifyUsers(db, leadId === null || leadId === input.assigneeId ? [] : [leadId], {
    type: 'assignment.created',
    title: `New task in your team: ${input.title}`,
    body,
    linkPath: `/planning/${team.project_department_id}`,
    entityType: 'assignment', entityId: input.assignmentId,
  }, input.actorId);
  const managers = (await managersFor(db, info)).filter((id) => id !== leadId && id !== input.assigneeId);
  await notifyUsers(db, managers, {
    type: 'assignment.created',
    title: `${team.by_lead || leadId === input.actorId ? 'Team Lead assigned' : 'Work assigned'}: ${input.title}`,
    body,
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
  const what = versionLabel(slot.name, input.versionNo, input.revisionNo);
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

/**
 * Brief §10, §19: a comment on a file version reaches the person who
 * uploaded it and the executive holding the slot — usually one and the same
 * — and nobody else; the author never hears about their own. Project and
 * slot threads stay as they were: read on the page, not pushed.
 */
export async function onVersionCommented(db: Executor, input: {
  versionId: number; commentId: number; body: string; actorId: number;
}) {
  const [version] = await db.execute<{
    deliverable_id: number; version_no: number; uploaded_by: number; revision_no: number | null;
  }>(sql`
    SELECT v.deliverable_id, v.version_no, v.uploaded_by,
           (SELECT r.revision_no FROM revisions r WHERE r.id = v.revision_id) AS revision_no
    FROM deliverable_versions v
    WHERE v.id = ${input.versionId}
  `);
  if (!version) return;
  const slot = await slotContext(db, Number(version.deliverable_id));
  if (!slot) return;
  const info = await project(db, slot.projectId);
  if (!info) return;
  const what = versionLabel(
    slot.name, Number(version.version_no), version.revision_no === null ? null : Number(version.revision_no),
  );
  const author = await fullName(db, input.actorId);
  await notifyUsers(db, [Number(version.uploaded_by), ...(slot.assigneeId === null ? [] : [slot.assigneeId])], {
    type: 'comment.posted',
    title: `New comment on ${what}`,
    body: `${label(info)}. ${author ?? 'A colleague'}: “${excerpt(input.body)}”`,
    linkPath: `/projects/${slot.projectId}#version-${input.versionId}`,
    entityType: 'comment', entityId: input.commentId,
  }, input.actorId);
}

/**
 * §20: QA approved / rejected, QA required (PM stage), ready for delivery.
 * An Executive whose file must still pass PM QA hears twice, worded apart:
 * "approved by your Team Lead" when it moves on, "approved for delivery"
 * when it clears. Without PM QA the lead's approval is the final one. When
 * the client's auto-delivery (§29) has already sent the cleared file to the
 * portal, Sales is told it was delivered, not that it waits in their queue.
 */
export async function onQaReviewed(db: Executor, input: {
  deliverableId: number; versionNo: number; stage: 'team_lead' | 'project_manager';
  decision: 'approved' | 'rejected' | 'changes_requested';
  newStatus: 'awaiting_pm_qa' | 'approved' | 'changes_requested';
  comments?: string | null; actorId: number;
  /** The cleared file went straight to the client portal (autoDeliverIfEnabled). */
  autoDelivered?: boolean;
}) {
  const slot = await slotContext(db, input.deliverableId);
  if (!slot) return;
  const info = await project(db, slot.projectId);
  if (!info) return;
  const revisionNo = await versionRevisionNo(db, input.deliverableId, input.versionNo);
  const what = versionLabel(slot.name, input.versionNo, revisionNo);
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
    await notifyUsers(db, salesFor(info), {
      type: 'qa.rejected',
      title: `QA ${verb} ${what}`,
      body: `${label(info)}. A new version will follow.`,
      linkPath: `/projects/${slot.projectId}#workspace`, ...entity,
    }, input.actorId);
    return;
  }

  if (input.newStatus === 'awaiting_pm_qa') {
    await notifyUsers(db, assignee, {
      type: 'qa.approved',
      title: `${what} approved by your Team Lead`,
      body: `${label(info)}. It now goes to the Project Manager for sign-off.`,
      linkPath: `/projects/${slot.projectId}#workspace`, ...entity,
    }, input.actorId);
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
    title: `${what} approved for delivery`,
    body: `${label(info)}. It has cleared QA${input.autoDelivered ? ' and went to the client portal' : ''}.`,
    linkPath: `/projects/${slot.projectId}#workspace`, ...entity,
  }, input.actorId);
  await notifyUsers(db, salesFor(info), input.autoDelivered ? {
    type: 'delivery.delivered',
    title: `Delivered to the client portal: ${what}`,
    body: `${label(info)}. ${revisionNo ? 'Revised, approved' : 'Approved'} and delivered automatically; the client can now review it.`,
    linkPath: `/projects/${slot.projectId}`, ...entity,
  } : {
    type: 'delivery.ready',
    title: `Ready for delivery: ${what}`,
    body: `${label(info)}. ${revisionNo ? 'Revised, approved' : 'Approved'} and waiting in your delivery queue.`,
    linkPath: '/deliveries', ...entity,
  }, input.actorId);
}

/**
 * §20 PM: revision created; Team Lead and Executive: revision received;
 * Sales: revision received, when someone other than the rep opened it.
 */
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
    title: `Revision ${revisionTag(input.revisionNo)}: ${input.title}`,
    body: `${label(info)} — ${slots.map((s) => s.name).join(', ')}.`,
    linkPath: `/revisions/${input.revisionId}`,
    entityType: 'revision', entityId: input.revisionId,
  };
  // One row each: the executives get their own wording below.
  await notifyUsers(db, [
    ...salesFor(info),
    ...(await managersFor(db, info)),
    ...(await leadsOf(db, input.projectId, departmentIds)),
  ].filter((id) => !assignees.includes(id)), notice, input.actorId);
  await notifyUsers(db, assignees, { ...notice, body: `${notice.body} Your slot is back with you.` }, input.actorId);
}

/**
 * §20 Executive: revision assigned to them. The lead of that team and the
 * PM hear who it went to, unless they handed it out themselves.
 */
export async function onRevisionAssigned(db: Executor, input: {
  projectId: number; revisionId: number; revisionNo: number; title: string;
  deliverableName: string; assigneeId: number; actorId: number;
  /**
   * The slot handed out. Without it the slot is found by name — which two
   * teams can share, in which case no lead is told rather than the wrong one.
   */
  deliverableId?: number;
}) {
  const info = await project(db, input.projectId);
  if (!info) return;
  const tag = revisionTag(input.revisionNo);
  await notifyUsers(db, [input.assigneeId], {
    type: 'revision.assigned',
    title: `Revision ${tag} assigned to you: ${input.deliverableName}`,
    body: `${label(info)} — ${input.title}.`,
    linkPath: `/revisions/${input.revisionId}`,
    entityType: 'revision', entityId: input.revisionId,
  }, input.actorId);

  // The slot has just been moved onto one of the assignee's assignments.
  const teams = await db.execute<{ team_lead_id: number | null; assignee: string }>(sql`
    SELECT DISTINCT pd.team_lead_id, u.full_name AS assignee
    FROM revision_deliverables rd
    JOIN deliverables d ON d.id = rd.deliverable_id
    JOIN project_departments pd ON pd.id = d.project_department_id
    JOIN assignments a ON a.id = d.assignment_id
    JOIN users u ON u.id = a.assignee_id
    WHERE rd.revision_id = ${input.revisionId}
      AND ${input.deliverableId !== undefined ? sql`d.id = ${input.deliverableId}` : sql`d.name = ${input.deliverableName}`}
      AND a.assignee_id = ${input.assigneeId}
  `);
  if (teams.length === 0) return;
  // Same-named slots of one person in two teams, and no slot id to go by:
  // it cannot be said whose team the work went out in.
  const leads = teams.length > 1 ? []
    : teams.map((t) => t.team_lead_id).filter((id): id is number => id !== null).map(Number);
  await notifyUsers(db, [...leads, ...(await managersFor(db, info))].filter((id) => id !== input.assigneeId), {
    type: 'revision.assigned',
    title: `Revision ${tag} handed to ${teams[0].assignee}: ${input.deliverableName}`,
    body: `${label(info)} — ${input.title}.`,
    linkPath: `/revisions/${input.revisionId}`,
    entityType: 'revision', entityId: input.revisionId,
  }, input.actorId);
}

/**
 * §18 On Hold / Cancelled: everyone with a stake in the project — its Sales
 * owner, its PM, the leads of its teams and the people with work on it.
 */
export async function onProjectStatusChanged(db: Executor, input: {
  projectId: number; change: 'hold' | 'resume' | 'cancel'; reason: string | null; actorId: number;
}) {
  const info = await project(db, input.projectId);
  if (!info) return;
  const workers = await db.execute<{ assignee_id: number }>(sql`
    SELECT DISTINCT assignee_id FROM assignments
    WHERE project_id = ${input.projectId} AND status <> 'completed'
  `);
  const verb = input.change === 'hold' ? 'put on hold' : input.change === 'resume' ? 'resumed' : 'cancelled';
  const notice = {
    type: `project.${input.change === 'hold' ? 'on_hold' : input.change === 'resume' ? 'resumed' : 'cancelled'}`,
    title: `Project ${verb}: ${label(info)}`,
    body: input.reason ? `${info.client} — ${input.reason}` : info.client,
    linkPath: `/projects/${input.projectId}`,
    entityType: 'project', entityId: input.projectId,
  };
  await notifyUsers(db, [
    ...salesFor(info),
    ...(await managersFor(db, info)),
    ...(await leadsOf(db, input.projectId)),
    ...workers.map((w) => Number(w.assignee_id)),
  ], notice, input.actorId);
}

/**
 * Sales or the PM changed what was filed (brief §3, §27). The people pricing
 * is for hear about every field; the teams hear about the brief only, and
 * nothing at all when the price was the only change (§23).
 */
export async function onProjectDetailsEdited(db: Executor, input: {
  projectId: number; fields: string[]; priceOnly: boolean; actorId: number;
}) {
  const info = await project(db, input.projectId);
  if (!info) return;
  const notice = (fields: string[]) => ({
    type: 'project.details_edited',
    title: `Project details changed: ${label(info)}`,
    body: `${info.client} — updated ${fields.join(', ')}`,
    linkPath: `/projects/${input.projectId}`,
    entityType: 'project', entityId: input.projectId,
  });
  await notifyUsers(db, [...salesFor(info), ...(await managersFor(db, info))], notice(input.fields), input.actorId);
  if (input.priceOnly) return;

  const workers = await db.execute<{ assignee_id: number }>(sql`
    SELECT DISTINCT assignee_id FROM assignments
    WHERE project_id = ${input.projectId} AND status <> 'completed'
  `);
  await notifyUsers(db, [
    ...(await leadsOf(db, input.projectId)),
    ...workers.map((w) => Number(w.assignee_id)),
  ], notice(input.fields.filter((f) => f !== 'price')), input.actorId);
}
