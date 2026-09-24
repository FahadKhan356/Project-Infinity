import 'server-only';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { departmentMembers, projectDepartments, projects } from '@/db/schema';
import type { Actor } from '@/lib/authz';
import { can } from '@/lib/authz';
import { isProjectVisible } from '@/lib/authz/queries';
import { assertMonthOpen } from '@/lib/months/lifecycle';

export class TriageError extends Error {}

export interface TeamAssignment {
  departmentId: number;
  /** null leaves the team on the project but without a lead yet. */
  teamLeadId: number | null;
  plannedDeliverables?: number;
}

export interface TriageInput {
  projectId: number;
  teams: TeamAssignment[];
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  deadline?: string | null;
  internalNotes?: string | null;
  requiresPmQa?: boolean;
}

export interface TriageResult {
  projectId: number;
  status: 'awaiting_assignment' | 'planned';
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
      })
      .from(projectDepartments)
      .where(eq(projectDepartments.projectId, input.projectId));

    const existingByDepartment = new Map(existing.map((row) => [row.departmentId, row.id]));

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

    // The QA policy is per team (§13). When the PM says nothing, a new team
    // inherits the project's setting and an existing team keeps its own —
    // Sales' choice at intake is not reversed by silence.
    const [projectRow] = await tx
      .select({ requiresPmQa: projects.requiresPmQa })
      .from(projects)
      .where(eq(projects.id, input.projectId));

    const now = new Date();
    for (const team of requested.values()) {
      const existingId = existingByDepartment.get(team.departmentId);
      const planned = Math.max(0, team.plannedDeliverables ?? 0);

      if (existingId === undefined) {
        await tx.insert(projectDepartments).values({
          projectId: input.projectId,
          departmentId: team.departmentId,
          teamLeadId: team.teamLeadId,
          plannedDeliverables: planned,
          requiresPmQa: input.requiresPmQa ?? projectRow?.requiresPmQa ?? true,
          assignedBy: team.teamLeadId === null ? null : actor.id,
          assignedAt: team.teamLeadId === null ? null : now,
        });
      } else {
        await tx
          .update(projectDepartments)
          .set({
            teamLeadId: team.teamLeadId,
            plannedDeliverables: planned,
            requiresPmQa: input.requiresPmQa,
            assignedBy: team.teamLeadId === null ? null : actor.id,
            assignedAt: team.teamLeadId === null ? null : now,
          })
          .where(eq(projectDepartments.id, existingId));
      }
    }

    const assignedTeams = [...requested.values()].filter((t) => t.teamLeadId !== null).length;
    const totalTeams = requested.size;

    // Every team has a lead, so the work can actually be planned. Until then
    // it stays visible as unfinished routing rather than looking scheduled.
    const status = assignedTeams === totalTeams ? 'planned' : 'awaiting_assignment';

    // Only what the PM actually supplied is written. `undefined` leaves the
    // value Sales filed at intake alone; an explicit null clears it. The form
    // always sends every field, so an emptied box still clears — but a caller
    // that routes teams and nothing else must not wipe the deadline.
    await tx
      .update(projects)
      .set({
        status,
        projectManagerId: actor.id,
        priority: input.priority,
        deadline: input.deadline,
        internalNotes: input.internalNotes,
        requiresPmQa: input.requiresPmQa,
        assignedAt: assignedTeams > 0 ? now : null,
      })
      .where(eq(projects.id, input.projectId));

    return { projectId: input.projectId, status, assignedTeams, totalTeams };
  });
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
    requiresPmQa: formData.get('requiresPmQa') === 'on',
    teams: departmentIds.map((departmentId) => {
      const lead = Number(formData.get(`lead_${departmentId}`));
      const planned = Number(formData.get(`planned_${departmentId}`));
      return {
        departmentId,
        teamLeadId: Number.isInteger(lead) && lead > 0 ? lead : null,
        plannedDeliverables: Number.isInteger(planned) && planned > 0 ? planned : 0,
      };
    }),
  };
}
