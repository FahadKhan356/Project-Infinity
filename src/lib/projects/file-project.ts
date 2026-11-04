import 'server-only';
import { getDb } from '@/db';
import { projectDepartments, projects } from '@/db/schema';
import type { Actor } from '@/lib/authz';
import { can } from '@/lib/authz';
import { assertMonthOpen } from '@/lib/months/lifecycle';
import { onProjectFiled } from '@/lib/notifications/notify';
import { PipelineError, winOpportunity } from '@/lib/pipeline/opportunities';
import { allocateProjectCode, parseMonthValue, resolveClientMonth } from './intake';
import { isClientVisible } from './queries';
import { normalizeCurrency, type SupportedCurrency } from '@/lib/currency';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type Priority = 'low' | 'normal' | 'high' | 'urgent';

/** One team on a filed project. */
export interface IntakeDepartment {
  departmentId: number;
  plannedDeliverables: number;
  /**
   * This team's QA route (brief §13). The intake form never sends it — Sales
   * answers once for the whole project — so a team filed without it takes
   * the project's default. A month copy sets it per team, so the route the
   * PM chose for one team survives the copy.
   */
  requiresPmQa?: boolean;
}

export interface ProjectIntakeInput {
  clientId: number;
  period: string;
  title: string;
  departments: IntakeDepartment[];
  projectType?: string | null;
  objective?: string | null;
  description?: string | null;
  poReference?: string | null;
  requirements?: string | null;
  clientNotes?: string | null;
  /** "Other relevant project information" (brief §3). */
  otherInfo?: string | null;
  internalNotes?: string | null;
  deadline?: string | null;
  priority?: Priority;
  priceAmount?: string | null;
  priceCurrency?: SupportedCurrency;
  /** The QA route Sales chose at intake (brief §13): the default for every team that does not say for itself. */
  requiresPmQa?: boolean;
  /** Copied into each new month by the nightly job (brief §29, recurring projects). */
  recursMonthly?: boolean;
  /** Filing this project wins that pipeline opportunity (brief §29). */
  opportunityId?: number | null;
}

export interface IntakeResult {
  projectId: number;
  projectCode: string;
  clientMonthId: number;
  monthCreated: boolean;
}

export class IntakeError extends Error {}

/**
 * Files a confirmed project.
 *
 * Kept out of the server action so it can be exercised directly against a
 * database: the invariants here — one bucket per client-month, one code per
 * project, pricing only from someone allowed to set it — are the ones that
 * quietly corrupt a client's history when they break.
 */
export async function fileProject(
  actor: Actor,
  input: ProjectIntakeInput,
): Promise<IntakeResult> {
  if (!can(actor, 'projects.create')) {
    throw new IntakeError('You are not permitted to file projects.');
  }

  const period = parseMonthValue(input.period);
  if (!period) throw new IntakeError('Choose the month this work belongs to.');
  validateProjectInput(input);

  const db = getDb();
  if (!(await isClientVisible(db, actor, input.clientId))) {
    // Same message whether the client does not exist or is simply not theirs,
    // so the form cannot be used to enumerate other reps' clients.
    throw new IntakeError('Choose a client.');
  }

  return db.transaction(async (tx) => {
    const month = await resolveClientMonth(tx, {
      clientId: input.clientId,
      year: period.year,
      month: period.month,
      userId: actor.id,
    });
    // A closed month is an archive (brief §36): nothing new is filed into it
    // until someone with the right to do so reopens it.
    await assertMonthOpen(tx, { clientMonthId: month.id }, (m) => new IntakeError(m));

    const project = await insertProject(tx, actor, {
      ...input,
      clientMonthId: month.id,
      year: period.year,
    });

    if (input.opportunityId != null) {
      try {
        await winOpportunity(tx, actor, {
          opportunityId: input.opportunityId, clientId: input.clientId, projectId: project.projectId,
        });
      } catch (error) {
        if (error instanceof PipelineError) throw new IntakeError(error.message);
        throw error;
      }
    }

    return {
      projectId: project.projectId,
      projectCode: project.projectCode,
      clientMonthId: month.id,
      monthCreated: month.created,
    };
  });
}

/** The checks a project must pass whether it is typed in or copied forward. */
export function validateProjectInput(input: Pick<ProjectIntakeInput, 'title' | 'departments'>): void {
  if (input.title.trim().length < 2) throw new IntakeError('Enter a project name.');
  if (input.departments.length === 0) {
    throw new IntakeError('Choose at least one team to deliver this work.');
  }
}

export interface InsertProjectInput extends Omit<ProjectIntakeInput, 'period'> {
  /** An existing, open bucket of the same client. */
  clientMonthId: number;
  /** The year the project code is allocated in. */
  year: number;
  /** Set when the project is a copy of last month's order (brief §38). */
  copiedFromProjectId?: number | null;
}

/**
 * Writes one project and its team rows inside the caller's transaction. The
 * caller has already checked the actor may file, the client is theirs and
 * the month is open; this is the part that must be atomic with whatever
 * else the caller is doing — copying a whole month, for instance.
 */
export async function insertProject(
  tx: Tx,
  actor: Actor,
  input: InsertProjectInput,
): Promise<{ projectId: number; projectCode: string }> {
  validateProjectInput(input);
  const title = input.title.trim();

  // Pricing is only accepted from someone allowed to see it, so a replayed
  // form cannot set a price its sender was never shown (brief §23).
  const priceAmount = can(actor, 'pricing.view') ? (input.priceAmount ?? null) : null;
  const priceCurrency = normalizeCurrency(input.priceCurrency);
  // The project's intake default (brief §13): what every team row is seeded
  // with unless the caller says otherwise for that team.
  const requiresPmQa = input.requiresPmQa ?? true;

  const projectCode = await allocateProjectCode(tx, input.year);

  const [project] = await tx
    .insert(projects)
    .values({
      projectCode,
      clientId: input.clientId,
      clientMonthId: input.clientMonthId,
      title,
      objective: input.objective ?? null,
      description: input.description ?? null,
      projectType: input.projectType ?? null,
      poReference: input.poReference ?? null,
      requirements: input.requirements ?? null,
      clientNotes: input.clientNotes ?? null,
      otherInfo: input.otherInfo ?? null,
      internalNotes: input.internalNotes ?? null,
      deadline: input.deadline ?? null,
      priority: input.priority ?? 'normal',
      priceAmount,
      priceCurrency,
      salesOwnerId: actor.id,
      requiresPmQa,
      copiedFromProjectId: input.copiedFromProjectId ?? null,
      recursMonthly: input.recursMonthly ?? false,
      createdBy: actor.id,
    })
    .returning({ id: projects.id, projectCode: projects.projectCode });

  // De-duplicated: a form can only name a team once, and the unique
  // constraint would reject a repeat anyway.
  const seen = new Set<number>();
  const rows = input.departments
    .filter((d) => !seen.has(d.departmentId) && seen.add(d.departmentId))
    .map((d) => ({
      projectId: project.id,
      departmentId: d.departmentId,
      plannedDeliverables: Math.max(0, d.plannedDeliverables | 0),
      requiresPmQa: d.requiresPmQa ?? requiresPmQa,
    }));
  await tx.insert(projectDepartments).values(rows);

  await onProjectFiled(tx, { projectId: project.id, actorId: actor.id });
  return { projectId: project.id, projectCode: project.projectCode };
}


/** Turns the intake form into validated input. Split out so it is testable. */
export function parseProjectForm(formData: FormData): ProjectIntakeInput {
  const text = (key: string): string | null => {
    const value = String(formData.get(key) ?? '').trim();
    return value === '' ? null : value;
  };

  const departmentIds = formData.getAll('department').map(Number).filter(Number.isInteger);
  const priorityRaw = String(formData.get('priority') ?? 'normal');
  const priority = (['low', 'normal', 'high', 'urgent'] as const).includes(priorityRaw as never)
    ? (priorityRaw as Priority)
    : 'normal';

  const rawPrice = String(formData.get('priceAmount') ?? '').trim();
  let priceAmount: string | null = null;
  if (rawPrice !== '') {
    const value = Number(rawPrice);
    if (!Number.isFinite(value) || value < 0) throw new IntakeError('Enter a valid price.');
    priceAmount = value.toFixed(2);
  }

  return {
    clientId: Number(formData.get('clientId')),
    period: String(formData.get('period') ?? ''),
    title: String(formData.get('title') ?? ''),
    departments: departmentIds.map((departmentId) => {
      const planned = Number(formData.get(`planned_${departmentId}`));
      return {
        departmentId,
        plannedDeliverables: Number.isInteger(planned) && planned > 0 ? planned : 0,
      };
    }),
    projectType: text('projectType'),
    objective: text('objective'),
    description: text('description'),
    poReference: text('poReference'),
    requirements: text('requirements'),
    clientNotes: text('clientNotes'),
    otherInfo: text('otherInfo'),
    internalNotes: text('internalNotes'),
    deadline: text('deadline'),
    priority,
    priceAmount,
    priceCurrency: normalizeCurrency(text('priceCurrency')),
    requiresPmQa: formData.get('requiresPmQa') === 'on',
    recursMonthly: formData.get('recursMonthly') === 'on',
    opportunityId: Number.isInteger(Number(formData.get('opportunityId'))) && formData.get('opportunityId')
      ? Number(formData.get('opportunityId')) : null,
  };
}
