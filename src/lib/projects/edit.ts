import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { can } from '@/lib/authz';
import { isProjectVisible } from '@/lib/authz/queries';
import { assertMonthOpen } from '@/lib/months/lifecycle';
import { onProjectDetailsEdited } from '@/lib/notifications/notify';

export class ProjectEditError extends Error {}

/**
 * The details Sales entered at intake (brief §3). Routing, teams, quantities,
 * priority, deadline and internal notes belong to triage and are changed there.
 * The one triage field also editable here is each team's QA route (§13):
 * whether its approved files go on to the Project Manager before delivery.
 */
export interface ProjectDetails {
  title: string;
  projectType: string | null;
  objective: string | null;
  description: string | null;
  poReference: string | null;
  requirements: string | null;
  clientNotes: string | null;
  /** "Other relevant project information" (§3). */
  otherInfo: string | null;
  /** Ignored unless the actor may see pricing. */
  priceAmount: string | null;
  /** Whether the nightly job copies it into each new month (brief §29). */
  recursMonthly: boolean;
}

/** One team's QA route (brief §13), as the edit form sends it. */
export interface TeamQaSetting {
  departmentId: number;
  requiresPmQa: boolean;
}

/** What an edit can report as changed: a detail column, or the teams' QA route. */
export type EditableField = keyof ProjectDetails | 'pmQa';

export const DETAIL_LABELS: Record<EditableField, string> = {
  title: 'name',
  projectType: 'type',
  objective: 'objective',
  description: 'description',
  poReference: 'PO reference',
  requirements: 'requirements',
  clientNotes: 'client notes',
  otherInfo: 'other information',
  priceAmount: 'price',
  recursMonthly: 'monthly repeat',
  pmQa: 'PM QA',
};

const COLUMNS: Record<keyof ProjectDetails, string> = {
  title: 'title',
  projectType: 'project_type',
  objective: 'objective',
  description: 'description',
  poReference: 'po_reference',
  requirements: 'requirements',
  clientNotes: 'client_notes',
  otherInfo: 'other_info',
  priceAmount: 'price_amount',
  recursMonthly: 'recurs_monthly',
};

export interface ProjectEditResult {
  projectId: number;
  /** Fields that actually changed, in form order. Empty when nothing did. */
  changed: EditableField[];
}

/**
 * Corrects or updates what Sales filed — a revised PO, new requirements, a
 * renegotiated price — on the one project record (brief §27), rather than
 * filing a second copy of it.
 *
 * Pricing is only written by someone allowed to see it, exactly as at intake,
 * so a replayed form cannot set a price its sender was never shown (§23).
 * Everyone working on the project is told what changed, never the new price.
 *
 * `teamQa` sets each named team's QA route (§13) on that team's own row; a
 * team not named keeps its value, and one not on the project (a stale form)
 * is ignored. The project's own `requires_pm_qa` is the intake default and is
 * left alone. Anyone who may edit the project may set it, as Sales chose it
 * at intake.
 */
export async function editProjectDetails(
  actor: Actor,
  input: { projectId: number; details: ProjectDetails; teamQa?: TeamQaSetting[] },
): Promise<ProjectEditResult> {
  if (!can(actor, 'projects.edit')) {
    throw new ProjectEditError('You are not permitted to edit project details.');
  }
  const title = input.details.title.trim();
  if (title.length < 2) throw new ProjectEditError('Enter a project name.');

  const db = getDb();
  if (!(await isProjectVisible(db, actor, input.projectId))) {
    throw new ProjectEditError('No such project.');
  }
  await assertMonthOpen(db, { projectId: input.projectId }, (m) => new ProjectEditError(m));

  const editable = (Object.keys(COLUMNS) as (keyof ProjectDetails)[])
    .filter((key) => key !== 'priceAmount' || can(actor, 'pricing.view'));
  const next: ProjectDetails = { ...input.details, title };

  return db.transaction(async (tx) => {
    const [row] = await tx.execute<Record<string, string | null>>(sql`
      SELECT status, title, project_type, objective, description, po_reference,
             requirements, client_notes, other_info, price_amount::text AS price_amount,
             recurs_monthly::text AS recurs_monthly
      FROM projects WHERE id = ${input.projectId} FOR UPDATE
    `);
    if (!row) throw new ProjectEditError('No such project.');
    if (row.status === 'completed' || row.status === 'cancelled') {
      throw new ProjectEditError(`This project is ${row.status}; its details can no longer change.`);
    }

    const details = editable.filter((key) => normalise(key, row[COLUMNS[key]]) !== normalise(key, next[key]));
    const changed: EditableField[] = [...details];

    // Each team's QA route, written only where it actually flips, so "saving
    // without changes tells nobody" holds for this field too. It runs before
    // the early return below: a QA-only edit is still an edit.
    let qaFlipped = false;
    for (const team of input.teamQa ?? []) {
      if (!Number.isInteger(team.departmentId)) continue;
      const flipped = await tx.execute<{ id: number }>(sql`
        UPDATE project_departments SET requires_pm_qa = ${team.requiresPmQa === true}
        WHERE project_id = ${input.projectId} AND department_id = ${team.departmentId}
          AND requires_pm_qa <> ${team.requiresPmQa === true}
        RETURNING id
      `);
      if (flipped.length > 0) qaFlipped = true;
    }
    if (qaFlipped) changed.push('pmQa');
    if (changed.length === 0) return { projectId: input.projectId, changed };

    if (details.length > 0) {
      await tx.execute(sql`
        UPDATE projects SET ${sql.join(
          details.map((key) => sql`${sql.identifier(COLUMNS[key])} = ${next[key]}`),
          sql`, `,
        )}
        WHERE id = ${input.projectId}
      `);
    }

    await onProjectDetailsEdited(tx, {
      projectId: input.projectId,
      fields: changed.map((key) => DETAIL_LABELS[key]),
      priceOnly: changed.every((key) => key === 'priceAmount'),
      actorId: actor.id,
    });
    return { projectId: input.projectId, changed };
  });
}

function normalise(key: keyof ProjectDetails, value: string | boolean | null): string | null {
  if (value === null) return null;
  if (key === 'recursMonthly') return String(value === true || value === 'true');
  if (key === 'priceAmount') return Number(value).toFixed(2);
  return String(value);
}

/** Turns the edit form into input. Split out so it is testable. */
export function parseProjectDetailsForm(formData: FormData): ProjectDetails {
  const text = (key: string): string | null => {
    const value = String(formData.get(key) ?? '').trim();
    return value === '' ? null : value;
  };
  const rawPrice = String(formData.get('priceAmount') ?? '').trim();
  let priceAmount: string | null = null;
  if (rawPrice !== '') {
    const value = Number(rawPrice);
    if (!Number.isFinite(value) || value < 0) throw new ProjectEditError('Enter a valid price.');
    priceAmount = value.toFixed(2);
  }
  return {
    title: String(formData.get('title') ?? ''),
    projectType: text('projectType'),
    objective: text('objective'),
    description: text('description'),
    poReference: text('poReference'),
    requirements: text('requirements'),
    clientNotes: text('clientNotes'),
    otherInfo: text('otherInfo'),
    priceAmount,
    recursMonthly: formData.get('recursMonthly') === 'on',
  };
}

/**
 * Reads the per-team PM QA boxes (brief §13). An unticked box is absent from
 * the form, so the form also lists every team it carried (`pmqaTeam`), and
 * only those are read — a box without its marker is ignored.
 */
export function parseTeamQaForm(formData: FormData): TeamQaSetting[] {
  const carried = [...new Set(formData.getAll('pmqaTeam').map(Number).filter(Number.isInteger))];
  return carried.map((departmentId) => ({
    departmentId,
    requiresPmQa: formData.get(`pmqa_${departmentId}`) === 'on',
  }));
}
