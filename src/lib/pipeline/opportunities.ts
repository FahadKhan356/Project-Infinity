import 'server-only';
import { sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { can, clientScope } from '@/lib/authz';
import { isClientVisible } from '@/lib/projects/queries';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export class PipelineError extends Error {}

export type Stage = 'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost';
export const OPEN_STAGES: Stage[] = ['lead', 'qualified', 'proposal', 'negotiation'];
export const STAGE_LABELS: Record<Stage, string> = {
  lead: 'Lead', qualified: 'Qualified', proposal: 'Proposal sent', negotiation: 'Negotiation',
  won: 'Won', lost: 'Lost',
};
/** How likely each stage is to close, for the weighted forecast. A convention, not a measurement. */
export const STAGE_PROBABILITY: Record<Stage, number> = {
  lead: 0.1, qualified: 0.25, proposal: 0.5, negotiation: 0.75, won: 1, lost: 0,
};

/**
 * The sales pipeline (brief §29): work Sales is chasing before it is
 * confirmed. An opportunity hangs off a client record from the start — a new
 * name is a client with status 'prospect' — so winning it files the project
 * against the same permanent client (§31). Winning is not a button here: it
 * is filing the project, which marks the opportunity won in the same
 * transaction (winOpportunity, called by fileProject).
 */
export function canUsePipeline(actor: Actor): boolean {
  return can(actor, 'pipeline.manage');
}

/** Rows an actor may see: every one for those who see all clients, else their own or their clients'. */
export function opportunityScope(actor: Actor, alias = 'o', clientAlias = 'c'): SQL {
  if (!canUsePipeline(actor)) return sql`FALSE`;
  if (can(actor, 'clients.viewAll')) return sql`TRUE`;
  return sql`(${sql.identifier(alias)}.owner_user_id = ${actor.id} OR ${clientScope(actor, clientAlias)})`;
}

export interface OpportunityInput {
  clientId: number;
  title: string;
  stage?: Stage;
  estimatedValue?: number | null;
  expectedClose?: string | null;
  notes?: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validate(input: Pick<OpportunityInput, 'title' | 'estimatedValue' | 'expectedClose'>) {
  if (input.title.trim().length < 2) throw new PipelineError('Describe the work being discussed.');
  if (input.estimatedValue != null && (!Number.isFinite(input.estimatedValue) || input.estimatedValue < 0)) {
    throw new PipelineError('Enter a valid estimated value.');
  }
  if (input.expectedClose && !DATE.test(input.expectedClose)) throw new PipelineError('Enter a valid date.');
}

export async function createOpportunity(actor: Actor, input: OpportunityInput): Promise<{ id: number }> {
  if (!canUsePipeline(actor)) throw new PipelineError('You are not permitted to use the pipeline.');
  validate(input);
  const stage = input.stage ?? 'lead';
  if (!OPEN_STAGES.includes(stage)) throw new PipelineError('A new opportunity starts in an open stage.');
  const db = getDb();
  if (!(await isClientVisible(db, actor, input.clientId))) throw new PipelineError('Choose a client.');
  const [row] = await db.execute<{ id: number }>(sql`
    INSERT INTO opportunities (client_id, owner_user_id, title, stage, estimated_value, expected_close, notes, created_by)
    VALUES (${input.clientId}, ${actor.id}, ${input.title.trim()}, ${stage},
            ${input.estimatedValue == null ? null : input.estimatedValue.toFixed(2)},
            ${input.expectedClose || null}, ${input.notes?.trim() || null}, ${actor.id})
    RETURNING id
  `);
  return { id: Number(row.id) };
}

async function loadOpen(actor: Actor, id: number) {
  const [row] = await getDb().execute<{ id: number; stage: Stage; client_id: number }>(sql`
    SELECT o.id, o.stage, o.client_id FROM opportunities o JOIN clients c ON c.id = o.client_id
    WHERE o.id = ${id} AND ${opportunityScope(actor)}
  `);
  if (!row) throw new PipelineError('No such opportunity.');
  return row;
}

/** Moves an open opportunity between the open stages. */
export async function moveOpportunity(actor: Actor, input: { id: number; stage: Stage }): Promise<{ from: Stage; clientId: number }> {
  if (!canUsePipeline(actor)) throw new PipelineError('You are not permitted to use the pipeline.');
  if (!OPEN_STAGES.includes(input.stage)) {
    throw new PipelineError(input.stage === 'won'
      ? 'An opportunity is won by filing its project.'
      : 'Mark it lost with a reason.');
  }
  const row = await loadOpen(actor, input.id);
  if (!OPEN_STAGES.includes(row.stage)) throw new PipelineError(`This opportunity is already ${row.stage}.`);
  await getDb().execute(sql`UPDATE opportunities SET stage = ${input.stage} WHERE id = ${input.id}`);
  return { from: row.stage, clientId: Number(row.client_id) };
}

export async function updateOpportunity(
  actor: Actor,
  input: { id: number; title: string; estimatedValue: number | null; expectedClose: string | null; notes: string | null },
): Promise<{ clientId: number }> {
  if (!canUsePipeline(actor)) throw new PipelineError('You are not permitted to use the pipeline.');
  validate(input);
  const row = await loadOpen(actor, input.id);
  if (!OPEN_STAGES.includes(row.stage)) throw new PipelineError(`This opportunity is already ${row.stage}.`);
  await getDb().execute(sql`
    UPDATE opportunities
    SET title = ${input.title.trim()},
        estimated_value = ${input.estimatedValue == null ? null : input.estimatedValue.toFixed(2)},
        expected_close = ${input.expectedClose || null}, notes = ${input.notes?.trim() || null}
    WHERE id = ${input.id}
  `);
  return { clientId: Number(row.client_id) };
}

export async function loseOpportunity(actor: Actor, input: { id: number; reason: string }): Promise<{ clientId: number }> {
  if (!canUsePipeline(actor)) throw new PipelineError('You are not permitted to use the pipeline.');
  const reason = input.reason.trim();
  if (!reason) throw new PipelineError('Say why it was lost, for next time.');
  const row = await loadOpen(actor, input.id);
  if (!OPEN_STAGES.includes(row.stage)) throw new PipelineError(`This opportunity is already ${row.stage}.`);
  await getDb().execute(sql`
    UPDATE opportunities SET stage = 'lost', lost_reason = ${reason.slice(0, 1000)}, closed_at = now()
    WHERE id = ${input.id}
  `);
  return { clientId: Number(row.client_id) };
}

/**
 * Called inside fileProject's transaction: the opportunity becomes won and
 * points at the project, or the filing fails. A prospect becomes an active
 * client with their first confirmed work.
 */
export async function winOpportunity(
  tx: Tx,
  actor: Actor,
  input: { opportunityId: number; clientId: number; projectId: number },
): Promise<void> {
  if (!canUsePipeline(actor)) throw new PipelineError('You are not permitted to use the pipeline.');
  const updated = await tx.execute<{ id: number }>(sql`
    UPDATE opportunities o
    SET stage = 'won', won_project_id = ${input.projectId}, closed_at = now()
    FROM clients c
    WHERE o.id = ${input.opportunityId} AND c.id = o.client_id
      AND o.client_id = ${input.clientId}
      AND o.stage IN ('lead','qualified','proposal','negotiation')
      AND ${opportunityScope(actor)}
    RETURNING o.id
  `);
  if (updated.length === 0) {
    throw new PipelineError('That opportunity is already closed, or is for a different client.');
  }
  // The day the prospect became a client is the §31 "date client started",
  // unless someone already knew better and typed one in.
  await tx.execute(sql`
    UPDATE clients SET status = 'active', started_on = COALESCE(started_on, current_date)
    WHERE id = ${input.clientId} AND status = 'prospect'
  `);
}

export interface Opportunity {
  id: number;
  clientId: number;
  clientName: string;
  clientStatus: string;
  owner: string;
  title: string;
  stage: Stage;
  estimatedValue: number | null;
  currency: string;
  expectedClose: string | null;
  notes: string | null;
  lostReason: string | null;
  wonProjectId: number | null;
  wonProjectCode: string | null;
  closedAt: string | null;
  overdue: boolean;
}

/** Open opportunities, and those closed in the last `closedDays` days. */
export async function listOpportunities(
  actor: Actor,
  opts: { clientId?: number; closedDays?: number; id?: number } = {},
): Promise<Opportunity[]> {
  if (!canUsePipeline(actor)) return [];
  const rows = await getDb().execute<{
    id: number; client_id: number; client_name: string; client_status: string; owner: string; title: string;
    stage: Stage; estimated_value: string | null; currency: string; expected_close: string | null;
    notes: string | null; lost_reason: string | null; won_project_id: number | null; won_code: string | null;
    closed_at: string | null; overdue: boolean;
  }>(sql`
    SELECT o.id, o.client_id, c.name AS client_name, c.status::text AS client_status, u.full_name AS owner,
           o.title, o.stage, o.estimated_value::text AS estimated_value, o.currency,
           o.expected_close::text AS expected_close, o.notes, o.lost_reason, o.won_project_id,
           p.project_code AS won_code,
           to_char(o.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS closed_at,
           (o.stage IN ('lead','qualified','proposal','negotiation') AND o.expected_close < CURRENT_DATE) AS overdue
    FROM opportunities o
    JOIN clients c ON c.id = o.client_id
    JOIN users u   ON u.id = o.owner_user_id
    LEFT JOIN projects p ON p.id = o.won_project_id
    WHERE ${opportunityScope(actor)}
      ${opts.clientId !== undefined ? sql`AND o.client_id = ${opts.clientId}` : sql``}
      ${opts.id !== undefined ? sql`AND o.id = ${opts.id}` : sql`
      AND (o.stage IN ('lead','qualified','proposal','negotiation')
           OR o.closed_at > now() - make_interval(days => ${opts.closedDays ?? 31}))`}
    ORDER BY o.expected_close NULLS LAST, o.created_at
  `);
  return rows.map((r) => ({
    id: Number(r.id), clientId: Number(r.client_id), clientName: r.client_name, clientStatus: r.client_status,
    owner: r.owner, title: r.title, stage: r.stage,
    estimatedValue: r.estimated_value === null ? null : Number(r.estimated_value),
    currency: r.currency, expectedClose: r.expected_close, notes: r.notes, lostReason: r.lost_reason,
    wonProjectId: r.won_project_id === null ? null : Number(r.won_project_id), wonProjectCode: r.won_code,
    closedAt: r.closed_at, overdue: r.overdue === true,
  }));
}

export async function getOpportunity(actor: Actor, id: number): Promise<Opportunity | null> {
  if (!canUsePipeline(actor)) return null;
  const [one] = await listOpportunities(actor, { id });
  return one ?? null;
}

export interface StageTotal {
  stage: Stage;
  count: number;
  value: number;
  weighted: number;
}

/** Per open stage: how many, what they are worth, and worth × likelihood. Single-currency sums. */
export function stageTotals(list: Opportunity[]): StageTotal[] {
  return OPEN_STAGES.map((stage) => {
    const inStage = list.filter((o) => o.stage === stage);
    const value = inStage.reduce((s, o) => s + (o.estimatedValue ?? 0), 0);
    return { stage, count: inStage.length, value, weighted: Math.round(value * STAGE_PROBABILITY[stage] * 100) / 100 };
  });
}
