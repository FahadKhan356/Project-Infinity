import 'server-only';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { departmentMembers, projectDepartments, projects } from '@/db/schema';
import type { Actor } from '@/lib/authz';
import { can, projectScope } from '@/lib/authz';
import { isProjectVisible } from '@/lib/authz/queries';
import { assertMonthOpen } from '@/lib/months/lifecycle';
import { onProjectRouted } from '@/lib/notifications/notify';
import { syncProjectStatus } from '@/lib/qa/project-status';
import { plannedDeliverablesTotal } from './queries';

export class TriageError extends Error {}

export interface TeamAssignment {
  departmentId: number;
  /** null leaves the team on the project but without a lead yet. */
  teamLeadId: number | null;
  plannedDeliverables?: number;
  /**
   * Whether this team's approved files also go to the Project Manager before
   * delivery (brief §13). Decided per team: `undefined` keeps an existing
   * team's value and gives a new team the project's intake default.
   */
  requiresPmQa?: boolean;
}

export interface TriageInput {
  projectId: number;
  teams: TeamAssignment[];
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  deadline?: string | null;
  internalNotes?: string | null;
  /**
   * A programmatic, project-wide fallback: applied to every team that does
   * not say for itself, and recorded as the project's default. The triage
   * form never sends it — it answers per team (`TeamAssignment.requiresPmQa`).
   */
  requiresPmQa?: boolean;
}

export interface TriageResult {
  projectId: number;
  /** The project's status after routing — once work has started, whatever the work says. */
  status: string;
  assignedTeams: number;
  totalTeams: number;
}

/**
 * The Project Manager reviews a newly filed project and routes it to the
 * teams that will deliver it (brief §4, §5).
 *
 * A project can need several departments, so a Team Lead is assigned per
 * department rather than per project — that is what lets Video and Design run
 * the same project without seeing each other's queues (§10).
 */
export async function triageProject(actor: Actor, input: TriageInput): Promise<TriageResult> {
  if (!can(actor, 'projects.triage')) {
    throw new TriageError('You are not permitted to triage projects.');
  }

  const db = getDb();
  if (!(await isProjectVisible(db, actor, input.projectId))) {
    throw new TriageError('No such project.');
  }
  await assertMonthOpen(db, { projectId: input.projectId }, (m) => new TriageError(m));
  const [state] = await db.select({ status: projects.status }).from(projects)
    .where(eq(projects.id, input.projectId));
  if (state?.status === 'cancelled' || state?.status === 'completed') {
    throw new TriageError(`This project is ${state.status}; its routing can no longer change.`);
  }
  if (input.teams.length === 0) {
    throw new TriageError('A project needs at least one team.');
  }

  const requested = new Map<number, TeamAssignment>();
  for (const team of input.teams) requested.set(team.departmentId, team);

  // A Team Lead may only be given work in a department they actually lead.
  // Otherwise triage could hand Video work to the Design lead, and the QA
  // panel would then show them deliverables they have no standing to judge.
  const leadIds = [...requested.values()]
    .map((t) => t.teamLeadId)
    .filter((id): id is number => id !== null);

  if (leadIds.length > 0) {
    const memberships = await db
      .select({
        userId: departmentMembers.userId,
        departmentId: departmentMembers.departmentId,
      })
      .from(departmentMembers)
      .where(and(inArray(departmentMembers.userId, leadIds), eq(departmentMembers.isLead, true)));

    const leads = new Set(memberships.map((m) => `${m.userId}:${m.departmentId}`));
    for (const team of requested.values()) {
      if (team.teamLeadId !== null && !leads.has(`${team.teamLeadId}:${team.departmentId}`)) {
        throw new TriageError('That person does not lead the team you assigned them to.');
      }
    }
  }

  return db.transaction(async (tx) => {
    const existing = await tx
      .select({
        id: projectDepartments.id,
        departmentId: projectDepartments.departmentId,
        teamLeadId: projectDepartments.teamLeadId,
      })
      .from(projectDepartments)
      .where(eq(projectDepartments.projectId, input.projectId));

    const existingByDepartment = new Map(existing.map((row) => [row.departmentId, row.id]));
    const previousLead = new Map(existing.map((row) => [row.departmentId, row.teamLeadId]));

    // Teams the PM removed. Refuse if work already hangs off them — losing a
    // deliverable silently is worse than making the PM cancel it explicitly.
    const removed = existing.filter((row) => !requested.has(row.departmentId));
    if (removed.length > 0) {
      const busy = await tx.execute<{ id: number }>(sql`
        SELECT pd.id FROM project_departments pd
        WHERE pd.id IN (${sql.join(removed.map((r) => sql`${r.id}`), sql`, `)})
          AND (EXISTS (SELECT 1 FROM assignments a WHERE a.project_department_id = pd.id)
               OR EXISTS (SELECT 1 FROM deliverables d WHERE d.project_department_id = pd.id))
      `);
      if (busy.length > 0) {
        throw new TriageError(
          'That team already has work on this project. Cancel its assignments before removing it.',
        );
      }
      await tx.delete(projectDepartments).where(
        inArray(projectDepartments.id, removed.map((r) => r.id)),
      );
    }

    // The QA route is decided per team (§13): each team's own answer is
    // written to its own row and never to another's. A team the caller says
    // nothing about — no per-team answer and no project-wide fallback — keeps
    // its value if it exists, and a new one inherits the project's intake
    // default. Sales' choice at intake is not reversed by silence. (Drizzle
    // drops an `undefined` key from `set()`, which is what makes "untouched"
    // work on the update below.)
    const [projectRow] = await tx
      .select({ requiresPmQa: projects.requiresPmQa })
      .from(projects)
      .where(eq(projects.id, input.projectId));

    const now = new Date();
    for (const team of requested.values()) {
      const existingId = existingByDepartment.get(team.departmentId);
      const planned = Math.max(0, team.plannedDeliverables ?? 0);
      const requiresPmQa = team.requiresPmQa ?? input.requiresPmQa;

      if (existingId === undefined) {
        await tx.insert(projectDepartments).values({
          projectId: input.projectId,
          departmentId: team.departmentId,
          teamLeadId: team.teamLeadId,
          plannedDeliverables: planned,
          requiresPmQa: requiresPmQa ?? projectRow?.requiresPmQa ?? true,
          assignedBy: team.teamLeadId === null ? null : actor.id,
          assignedAt: team.teamLeadId === null ? null : now,
        });
      } else {
        await tx
          .update(projectDepartments)
          .set({
            teamLeadId: team.teamLeadId,
            plannedDeliverables: planned,
            requiresPmQa,
            assignedBy: team.teamLeadId === null ? null : actor.id,
            assignedAt: team.teamLeadId === null ? null : now,
          })
          .where(eq(projectDepartments.id, existingId));
      }
    }

    const assignedTeams = [...requested.values()].filter((t) => t.teamLeadId !== null).length;
    const totalTeams = requested.size;
    // Only a lead who was not already on this team is told (brief §20); a
    // re-save that changes nothing does not ping anyone.
    const newLeadIds = [...requested.values()]
      .filter((t) => t.teamLeadId !== null && previousLead.get(t.departmentId) !== t.teamLeadId)
      .map((t) => t.teamLeadId as number);

    // Every team has a lead, so the work can actually be planned. Until then
    // it stays visible as unfinished routing rather than looking scheduled.
    const routed = assignedTeams === totalTeams ? 'planned' : 'awaiting_assignment';
    // Routing only decides the status of a project that has not started. A
    // PM adding a team to work already in progress must not send it back to
    // "planned"; a held project remembers the routing for when it resumes.
    const [current] = await tx
      .select({ status: projects.status, heldFrom: projects.heldFromStatus, managerId: projects.projectManagerId })
      .from(projects)
      .where(eq(projects.id, input.projectId));
    const PRE_PRODUCTION = ['new', 'awaiting_assignment', 'planned'];
    const onHold = current?.status === 'on_hold';
    const status = onHold
      ? 'on_hold'
      : PRE_PRODUCTION.includes(current?.status ?? 'new') ? routed : current!.status;
    const heldFromStatus = onHold
      ? (PRE_PRODUCTION.includes(current!.heldFrom ?? '') ? routed : current!.heldFrom)
      : null;

    // Only what the PM actually supplied is written. `undefined` leaves the
    // value Sales filed at intake alone; an explicit null clears it. The form
    // always sends every field, so an emptied box still clears — but a caller
    // that routes teams and nothing else must not wipe the deadline.
    //
    // `projects.requires_pm_qa` is the intake default, not a value derived
    // from the teams: it seeds a team the PM adds later without saying, and
    // the route actually enforced is each team's own row (§13). Only a
    // project-wide fallback rewrites it; the form, answering per team, never
    // sends one.
    await tx
      .update(projects)
      .set({
        status: status as typeof projects.$inferInsert.status,
        heldFromStatus: heldFromStatus as typeof projects.$inferInsert.heldFromStatus,
        projectManagerId: actor.id,
        priority: input.priority,
        deadline: input.deadline,
        internalNotes: input.internalNotes,
        requiresPmQa: input.requiresPmQa,
        assignedAt: assignedTeams > 0 ? now : null,
      })
      .where(eq(projects.id, input.projectId));

    // A project whose work started while a team still had no lead follows
    // that work: giving the team its lead, or dropping it, never sends
    // delivered work back to "planned".
    const settled = (await syncProjectStatus(tx, input.projectId)) ?? status;

    await onProjectRouted(tx, {
      projectId: input.projectId, newLeadIds, actorId: actor.id,
      previousManagerId: current?.managerId ?? null,
    });
    return { projectId: input.projectId, status: settled, assignedTeams, totalTeams };
  });
}

export interface IntakeRow {
  id: number;
  projectCode: string;
  title: string;
  status: string;
  priority: string;
  deadline: string | null;
  clientName: string;
  periodYear: number;
  periodMonth: number;
  salesOwner: string | null;
  /** Null unless the viewer may see pricing. */
  priceAmount: string | null;
  priceCurrency: string;
  teams: string | null;
  /** Deliverables planned across every team (brief §3): summed, never stored. */
  plannedTotal: number;
  /** Teams on the project that still have no lead. */
  unassigned: number;
  /** Teams whose lead has planned nothing yet: no assignment and no slot. */
  unplanned: number;
}

/**
 * The Project Manager's intake queue (brief §4, §5): projects waiting to be
 * routed, and any project under way that a team still holds up. Once work
 * has started the status follows it (qa/project-status), so the status alone
 * no longer says that routing is unfinished — but the derivation keeps such a
 * project in progress, never finished, while a team has no lead or its lead
 * has planned nothing. The first is the PM's to route at any time. The second
 * is the lead's to plan until the other teams' work is all in review or
 * signed off; from then on only the PM can move the project, by chasing the
 * lead or dropping the team, so it is listed.
 */
export async function intakeQueue(actor: Actor): Promise<IntakeRow[]> {
  if (!can(actor, 'projects.triage')) return [];
  const showPricing = can(actor, 'pricing.view');

  const rows = await getDb().execute<{
    id: number; project_code: string; title: string; status: string; priority: string;
    deadline: string | null; client_name: string; period_year: number; period_month: number;
    sales_owner: string | null; price_amount: string | null; price_currency: string;
    teams: string | null; planned_total: number; unassigned: number; unplanned: number;
  }>(sql`
    SELECT q.* FROM (
      SELECT p.id, p.project_code, p.title, p.status, p.priority, p.deadline, p.created_at,
             c.name AS client_name, cm.period_year, cm.period_month,
             so.full_name AS sales_owner, p.price_currency,
             ${showPricing ? sql`p.price_amount` : sql`NULL::numeric`} AS price_amount,
             (SELECT string_agg(d.name, ', ' ORDER BY d.sort_order)
                FROM project_departments pd JOIN departments d ON d.id = pd.department_id
               WHERE pd.project_id = p.id) AS teams,
             ${plannedDeliverablesTotal('p')} AS planned_total,
             (SELECT count(*) FROM project_departments pd
               WHERE pd.project_id = p.id AND pd.team_lead_id IS NULL)::int AS unassigned,
             (SELECT count(*) FROM project_departments pd
               WHERE pd.project_id = p.id AND pd.team_lead_id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.project_department_id = pd.id)
                 AND NOT EXISTS (SELECT 1 FROM deliverables x
                                 WHERE x.project_department_id = pd.id))::int AS unplanned,
             (SELECT count(*) FROM deliverables x
               WHERE x.project_id = p.id AND x.status <> 'cancelled')::int AS live_slots,
             (SELECT count(*) FROM deliverables x
               WHERE x.project_id = p.id
                 AND x.status IN ('pending', 'in_progress', 'changes_requested'))::int AS in_production
      FROM projects p
      JOIN clients c        ON c.id = p.client_id
      JOIN client_months cm ON cm.id = p.client_month_id
      LEFT JOIN users so    ON so.id = p.sales_owner_id
      WHERE ${projectScope(actor, 'p')}
    ) q
    WHERE q.status IN ('new', 'awaiting_assignment')
       OR (q.status NOT IN ('completed', 'cancelled') AND q.unassigned > 0)
       -- Held up: every slot the other teams made is in review or signed off,
       -- and a routed team has made none, so the project cannot finish.
       OR (q.status = 'in_progress' AND q.unplanned > 0 AND q.live_slots > 0 AND q.in_production = 0)
    ORDER BY
      CASE q.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      q.deadline NULLS LAST,
      q.created_at
  `);

  return rows.map((r) => ({
    id: Number(r.id),
    projectCode: r.project_code,
    title: r.title,
    status: r.status,
    priority: r.priority,
    deadline: r.deadline,
    clientName: r.client_name,
    periodYear: Number(r.period_year),
    periodMonth: Number(r.period_month),
    salesOwner: r.sales_owner,
    priceAmount: r.price_amount,
    priceCurrency: r.price_currency,
    teams: r.teams,
    plannedTotal: Number(r.planned_total),
    unassigned: Number(r.unassigned),
    unplanned: Number(r.unplanned),
  }));
}

/** Turns the triage form into validated input. Split out so it is testable. */
export function parseTriageForm(formData: FormData): TriageInput {
  const departmentIds = formData.getAll('department').map(Number).filter(Number.isInteger);

  const priorityRaw = String(formData.get('priority') ?? 'normal');
  const priority = (['low', 'normal', 'high', 'urgent'] as const).includes(priorityRaw as never)
    ? (priorityRaw as TriageInput['priority'])
    : 'normal';

  const deadline = String(formData.get('deadline') ?? '').trim();
  const notes = String(formData.get('internalNotes') ?? '').trim();

  return {
    projectId: Number(formData.get('projectId')),
    priority,
    deadline: deadline === '' ? null : deadline,
    internalNotes: notes === '' ? null : notes,
    teams: departmentIds.map((departmentId) => {
      const lead = Number(formData.get(`lead_${departmentId}`));
      const planned = Number(formData.get(`planned_${departmentId}`));
      return {
        departmentId,
        teamLeadId: Number.isInteger(lead) && lead > 0 ? lead : null,
        plannedDeliverables: Number.isInteger(planned) && planned > 0 ? planned : 0,
        // One box per team (§13). Every selected team's box is in the form,
        // so an absent one unambiguously means "not required".
        requiresPmQa: formData.get(`pmqa_${departmentId}`) === 'on',
      };
    }),
  };
}
