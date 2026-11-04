import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { can, projectScope } from '@/lib/authz';
import { formatMonth, parseMonthValue, resolveClientMonth } from '@/lib/projects/intake';
import { insertProject, type Priority } from '@/lib/projects/file-project';
import { isClientVisible } from '@/lib/projects/queries';
import { normalizeCurrency, type SupportedCurrency } from '@/lib/currency';
import { MonthError, assertMonthOpen } from './lifecycle';

export interface CopyPlanDepartment {
  departmentId: number;
  name: string;
  plannedDeliverables: number;
  /** This team's own QA route (brief §13), carried to the copied team as it is. */
  requiresPmQa: boolean;
}

export interface CopyPlanProject {
  id: number;
  projectCode: string;
  title: string;
  projectType: string | null;
  objective: string | null;
  description: string | null;
  poReference: string | null;
  requirements: string | null;
  clientNotes: string | null;
  internalNotes: string | null;
  priority: Priority;
  /** null when the actor may not see pricing — never a hidden zero. */
  priceAmount: string | null;
  priceCurrency: string;
  /** The project's intake default (§13); each team's own route is on `departments`. */
  requiresPmQa: boolean;
  deadline: string | null;
  /** The source deadline moved forward by the same number of months. */
  suggestedDeadline: string | null;
  departments: CopyPlanDepartment[];
}

export interface CopyPlan {
  clientId: number;
  clientName: string;
  source: { id: number; year: number; month: number; label: string };
  target: { year: number; month: number; value: string; label: string; status: 'open' | 'closed' | null };
  projects: CopyPlanProject[];
  /** Every production team, so a copy can gain one the source did not have (§38). */
  availableDepartments: { id: number; name: string }[];
}

type SourceRow = {
  id: number; project_code: string; title: string; project_type: string | null;
  objective: string | null; description: string | null; po_reference: string | null;
  requirements: string | null; client_notes: string | null; other_info: string | null;
  internal_notes: string | null; priority: Priority; price_amount: string | null; price_currency: string; requires_pm_qa: boolean;
  recurs_monthly: boolean; deadline: string | null;
  departments: { department_id: number; name: string; planned: number; requires_pm_qa: boolean }[] | null;
};

/** The calendar month after (year, month). */
export function nextPeriod(year: number, month: number): { year: number; month: number; value: string } {
  const d = new Date(Date.UTC(year, month, 1));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return { year: y, month: m, value: `${y}-${String(m).padStart(2, '0')}` };
}

/**
 * The `?to=` of the copy page, read before the plan is built. A value that
 * is not a month — a browser rendering type="month" as plain text, or a
 * hand-edited URL — is reported as the field's error and the plan falls
 * back to its default month, rather than the page answering 404 for a slip
 * in its own field. Absent means the default month, with nothing to say.
 */
export function copyTarget(raw: string | null | undefined): { period: string | null; error: string | null } {
  const value = raw?.trim() ?? '';
  if (value === '') return { period: null, error: null };
  if (parseMonthValue(value)) return { period: value, error: null };
  return {
    period: null,
    error: `"${value}" is not a month. Enter it as YYYY-MM, for example 2026-10; the month below is the default.`,
  };
}

/**
 * Moves a date forward by whole months, keeping the day where the target
 * month has it and clamping otherwise (31 January → 28 February).
 */
export function shiftDate(isoDate: string, months: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1 + months;
  const day = Number(match[3]);
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const d = new Date(Date.UTC(year, month, Math.min(day, lastDay)));
  return d.toISOString().slice(0, 10);
}

async function loadSourceProjects(actor: Actor, fromMonthId: number): Promise<SourceRow[]> {
  const showPricing = can(actor, 'pricing.view');
  return getDb().execute<SourceRow>(sql`
    SELECT p.id, p.project_code, p.title, p.project_type, p.objective, p.description,
           p.po_reference, p.requirements, p.client_notes, p.other_info, p.internal_notes, p.priority,
           ${showPricing ? sql`p.price_amount` : sql`NULL::numeric`} AS price_amount,
           p.price_currency, p.requires_pm_qa, p.recurs_monthly,
           to_char(p.deadline, 'YYYY-MM-DD') AS deadline,
           (SELECT json_agg(json_build_object(
                     'department_id', pd.department_id, 'name', d.name,
                     'planned', pd.planned_deliverables,
                     'requires_pm_qa', pd.requires_pm_qa) ORDER BY d.sort_order)
              FROM project_departments pd JOIN departments d ON d.id = pd.department_id
             WHERE pd.project_id = p.id) AS departments
    FROM projects p
    WHERE p.client_month_id = ${fromMonthId}
      AND p.status <> 'cancelled'
      AND ${projectScope(actor, 'p')}
    ORDER BY p.created_at
  `);
}

/**
 * What "Copy August → September" will do, before it does it (brief §38):
 * the order structure of every project in the source month, with the
 * quantities, deadlines, requirements, pricing and notes Sales may change.
 * Files and deliverables are not part of the plan — only the orders are.
 */
export async function copyMonthPlan(
  actor: Actor,
  input: { clientId: number; fromMonthId: number; period?: string | null },
): Promise<CopyPlan> {
  if (!can(actor, 'projects.create')) throw new MonthError('You are not permitted to file projects.');
  const db = getDb();
  if (!(await isClientVisible(db, actor, input.clientId))) throw new MonthError('No such client.');

  const [source] = await db.execute<{ id: number; period_year: number; period_month: number; client_name: string }>(sql`
    SELECT cm.id, cm.period_year, cm.period_month, c.name AS client_name
    FROM client_months cm JOIN clients c ON c.id = cm.client_id
    WHERE cm.id = ${input.fromMonthId} AND cm.client_id = ${input.clientId}
  `);
  if (!source) throw new MonthError('No such month.');
  const sourceYear = Number(source.period_year);
  const sourceMonth = Number(source.period_month);

  const target = input.period ? parseMonthValue(input.period) : nextPeriod(sourceYear, sourceMonth);
  if (!target) throw new MonthError('Choose the month to copy into.');
  const monthDelta = (target.year - sourceYear) * 12 + (target.month - sourceMonth);

  const [existing] = await db.execute<{ status: 'open' | 'closed' }>(sql`
    SELECT status FROM client_months
    WHERE client_id = ${input.clientId} AND period_year = ${target.year} AND period_month = ${target.month}
  `);

  const rows = await loadSourceProjects(actor, source.id);
  const departments = await db.execute<{ id: number; name: string }>(sql`
    SELECT id, name FROM departments WHERE is_production ORDER BY sort_order
  `);
  return {
    clientId: input.clientId,
    clientName: source.client_name,
    availableDepartments: departments.map((d) => ({ id: Number(d.id), name: d.name })),
    source: { id: Number(source.id), year: sourceYear, month: sourceMonth, label: formatMonth(sourceYear, sourceMonth) },
    target: {
      year: target.year,
      month: target.month,
      value: `${target.year}-${String(target.month).padStart(2, '0')}`,
      label: formatMonth(target.year, target.month),
      status: existing?.status ?? null,
    },
    projects: rows.map((r) => ({
      id: Number(r.id),
      projectCode: r.project_code,
      title: r.title,
      projectType: r.project_type,
      objective: r.objective,
      description: r.description,
      poReference: r.po_reference,
      requirements: r.requirements,
      clientNotes: r.client_notes,
      internalNotes: r.internal_notes,
      priority: r.priority,
      priceAmount: r.price_amount,
      priceCurrency: r.price_currency,
      requiresPmQa: r.requires_pm_qa === true,
      deadline: r.deadline,
      suggestedDeadline: r.deadline ? shiftDate(r.deadline, monthDelta) : null,
      departments: (r.departments ?? []).map((d) => ({
        departmentId: Number(d.department_id),
        name: d.name,
        plannedDeliverables: Number(d.planned),
        requiresPmQa: d.requires_pm_qa === true,
      })),
    })),
  };
}

export interface CopyProjectInput {
  sourceProjectId: number;
  title?: string | null;
  departments: { departmentId: number; plannedDeliverables: number }[];
  deadline?: string | null;
  priceAmount?: string | null;
  priceCurrency?: SupportedCurrency;
  requirements?: string | null;
  clientNotes?: string | null;
  internalNotes?: string | null;
}

export interface CopyMonthInput {
  clientId: number;
  fromMonthId: number;
  period: string;
  projects: CopyProjectInput[];
}

export interface CopyMonthResult {
  clientId: number;
  clientMonthId: number;
  monthCreated: boolean;
  year: number;
  month: number;
  projects: { projectId: number; projectCode: string; copiedFromId: number; copiedFromCode: string; title: string }[];
}

/**
 * Copies the order structure of one month into another (brief §38).
 *
 * Each chosen project becomes a new project — a new code, status `new`, so
 * it lands in the Project Manager's intake like anything else — with its
 * lineage recorded in `copied_from_project_id`. Each team kept from the
 * source keeps its own QA route (§13), and a team added in the copy takes
 * the project's intake default, as it would at triage. Nothing else
 * travels: no deliverable slots, no assignments, no files, no revisions.
 * Those belong to the month they were made in (§33) and would be counted
 * twice otherwise.
 *
 * All of it happens in one transaction: either every ticked project exists
 * in the new month, or none does.
 */
export async function copyMonth(actor: Actor, input: CopyMonthInput): Promise<CopyMonthResult> {
  if (!can(actor, 'projects.create')) throw new MonthError('You are not permitted to file projects.');
  const target = parseMonthValue(input.period);
  if (!target) throw new MonthError('Choose the month to copy into.');
  if (input.projects.length === 0) throw new MonthError('Tick at least one project to copy.');

  const db = getDb();
  if (!(await isClientVisible(db, actor, input.clientId))) throw new MonthError('No such client.');

  const [source] = await db.execute<{ id: number; period_year: number; period_month: number }>(sql`
    SELECT id, period_year, period_month FROM client_months
    WHERE id = ${input.fromMonthId} AND client_id = ${input.clientId}
  `);
  if (!source) throw new MonthError('No such month.');
  if (Number(source.period_year) === target.year && Number(source.period_month) === target.month) {
    throw new MonthError('Choose a different month to copy into.');
  }

  const sources = new Map<number, SourceRow>();
  for (const row of await loadSourceProjects(actor, Number(source.id))) sources.set(Number(row.id), row);
  // A copy may keep, drop or add teams (§38 "new projects / removed
  // projects" applies to the teams inside an order too), from the
  // production departments that exist.
  const production = new Set(
    (await db.execute<{ id: number }>(sql`SELECT id FROM departments WHERE is_production`)).map((d) => Number(d.id)),
  );

  // Validate everything before touching the database, so a bad row in the
  // form cannot leave half a month behind.
  const prepared = input.projects.map((p) => {
    const src = sources.get(p.sourceProjectId);
    if (!src) throw new MonthError('A project you ticked is not in that month.');
    // A team the source had keeps its own QA route (§13); one added in the
    // copy is left unsaid here and takes the project's intake default below.
    const sourceQa = new Map((src.departments ?? []).map((d) => [Number(d.department_id), d.requires_pm_qa === true]));
    const seen = new Set<number>();
    const departments = p.departments
      .filter((d) => Number.isInteger(d.departmentId) && production.has(d.departmentId))
      .filter((d) => !seen.has(d.departmentId) && seen.add(d.departmentId))
      .map((d) => ({
        departmentId: d.departmentId,
        plannedDeliverables: Math.max(0, d.plannedDeliverables | 0),
        requiresPmQa: sourceQa.get(d.departmentId),
      }));
    if (departments.length === 0) {
      throw new MonthError(`${src.title} needs at least one team. Untick it instead if it is not wanted.`);
    }
    const title = (p.title ?? '').trim() || src.title;
    return { src, title, departments, input: p };
  });

  return db.transaction(async (tx) => {
    const month = await resolveClientMonth(tx, {
      clientId: input.clientId, year: target.year, month: target.month, userId: actor.id,
    });
    await assertMonthOpen(tx, { clientMonthId: month.id });

    const created: CopyMonthResult['projects'] = [];
    for (const { src, title, departments, input: p } of prepared) {
      const project = await insertProject(tx, actor, {
        clientId: input.clientId,
        clientMonthId: month.id,
        year: target.year,
        title,
        departments,
        projectType: src.project_type,
        objective: src.objective,
        description: src.description,
        poReference: src.po_reference,
        requirements: p.requirements === undefined ? src.requirements : p.requirements,
        clientNotes: p.clientNotes === undefined ? src.client_notes : p.clientNotes,
        otherInfo: src.other_info,
        internalNotes: p.internalNotes === undefined ? src.internal_notes : p.internalNotes,
        deadline: p.deadline === undefined ? null : p.deadline,
        priority: src.priority,
        priceAmount: p.priceAmount === undefined ? src.price_amount : p.priceAmount,
        priceCurrency: p.priceCurrency ?? normalizeCurrency(src.price_currency),
        // The intake default, as filed: what a team added in the copy gets.
        requiresPmQa: src.requires_pm_qa === true,
        // A repeating order stays repeating in the month it was copied into.
        recursMonthly: src.recurs_monthly === true,
        copiedFromProjectId: Number(src.id),
      });
      created.push({
        projectId: project.projectId,
        projectCode: project.projectCode,
        copiedFromId: Number(src.id),
        copiedFromCode: src.project_code,
        title,
      });
    }

    return {
      clientId: input.clientId,
      clientMonthId: month.id,
      monthCreated: month.created,
      year: target.year,
      month: target.month,
      projects: created,
    };
  });
}

/**
 * Reads the copy form. Every field is keyed by the source project id, so
 * one submission carries every ticked project and its edits.
 */
export function parseCopyForm(formData: FormData): CopyMonthInput {
  const text = (key: string): string | null => {
    const value = String(formData.get(key) ?? '').trim();
    return value === '' ? null : value;
  };
  const projectIds = formData.getAll('project').map(Number).filter(Number.isInteger);

  const projects = projectIds.map((id) => {
    // No price field at all (the form hides it from those who cannot see
    // pricing) means "keep the source price"; an emptied field clears it.
    const rawPriceField = formData.get(`price_${id}`);
    const rawPrice = String(rawPriceField ?? '').trim();
    let priceAmount: string | null | undefined = rawPriceField === null ? undefined : null;
    if (rawPrice !== '') {
      const value = Number(rawPrice);
      if (!Number.isFinite(value) || value < 0) throw new MonthError('Enter a valid price.');
      priceAmount = value.toFixed(2);
    }
    const departments = formData.getAll(`dept_${id}`).map(Number).filter(Number.isInteger).map((departmentId) => {
      const planned = Number(formData.get(`planned_${id}_${departmentId}`));
      return { departmentId, plannedDeliverables: Number.isInteger(planned) && planned > 0 ? planned : 0 };
    });
    const rawCurrency = text(`currency_${id}`);
    return {
      sourceProjectId: id,
      title: text(`title_${id}`),
      departments,
      deadline: text(`deadline_${id}`),
      priceAmount,
      ...(rawCurrency ? { priceCurrency: normalizeCurrency(rawCurrency) } : {}),
      requirements: text(`requirements_${id}`),
      clientNotes: text(`clientNotes_${id}`),
      internalNotes: text(`internalNotes_${id}`),
    };
  });

  return {
    clientId: Number(formData.get('clientId')),
    fromMonthId: Number(formData.get('fromMonthId')),
    period: String(formData.get('period') ?? ''),
    projects,
  };
}
