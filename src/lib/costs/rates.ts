import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { can } from '@/lib/authz';

export class CostRateError extends Error {}

export interface CostRate {
  effectiveFrom: string;
  hourlyCost: number;
  currency: string;
  setBy: string;
  setAt: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A person's hourly cost from a date (brief §29, profitability). Setting a
 * rate for a date that already has one replaces it; earlier rates stay, so
 * past months keep the cost they had.
 */
export async function setCostRate(
  actor: Actor,
  input: { userId: number; effectiveFrom: string; hourlyCost: number; currency?: string },
): Promise<void> {
  if (!can(actor, 'costs.manage')) throw new CostRateError('You are not permitted to set cost rates.');
  if (!DATE.test(input.effectiveFrom)) throw new CostRateError('Choose the date the rate applies from.');
  if (!Number.isFinite(input.hourlyCost) || input.hourlyCost < 0 || input.hourlyCost > 100000) {
    throw new CostRateError('Enter a valid hourly cost.');
  }
  const currency = (input.currency ?? 'AED').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new CostRateError('Enter a three-letter currency.');

  const db = getDb();
  const [user] = await db.execute<{ id: number }>(sql`SELECT id FROM users WHERE id = ${input.userId}`);
  if (!user) throw new CostRateError('No such user.');
  await db.execute(sql`
    INSERT INTO user_cost_rates (user_id, effective_from, hourly_cost, currency, set_by)
    VALUES (${input.userId}, ${input.effectiveFrom}, ${input.hourlyCost.toFixed(2)}, ${currency}, ${actor.id})
    ON CONFLICT (user_id, effective_from) DO UPDATE
      SET hourly_cost = EXCLUDED.hourly_cost, currency = EXCLUDED.currency,
          set_by = EXCLUDED.set_by, set_at = now()
  `);
}

export async function removeCostRate(actor: Actor, input: { userId: number; effectiveFrom: string }): Promise<void> {
  if (!can(actor, 'costs.manage')) throw new CostRateError('You are not permitted to set cost rates.');
  await getDb().execute(sql`
    DELETE FROM user_cost_rates WHERE user_id = ${input.userId} AND effective_from = ${input.effectiveFrom}
  `);
}

/** Newest first. Null for anyone who may not see individual rates. */
export async function costRates(actor: Actor, userId: number): Promise<CostRate[] | null> {
  if (!can(actor, 'costs.manage')) return null;
  const rows = await getDb().execute<{
    effective_from: string; hourly_cost: string; currency: string; set_by: string; set_at: string;
  }>(sql`
    SELECT r.effective_from::text AS effective_from, r.hourly_cost::text AS hourly_cost, r.currency,
           u.full_name AS set_by,
           to_char(r.set_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS set_at
    FROM user_cost_rates r JOIN users u ON u.id = r.set_by
    WHERE r.user_id = ${userId}
    ORDER BY r.effective_from DESC
  `);
  return rows.map((r) => ({
    effectiveFrom: r.effective_from, hourlyCost: Number(r.hourly_cost), currency: r.currency,
    setBy: r.set_by, setAt: r.set_at,
  }));
}

/**
 * SQL for the cost of one time entry `te`: its minutes at the rate in force
 * on its day. Null when the person had no rate yet. Shared by every report
 * that costs time, so they cannot disagree.
 */
export const entryCost = sql`(
  SELECT (te.minutes / 60.0) * r.hourly_cost FROM user_cost_rates r
  WHERE r.user_id = te.user_id AND r.effective_from <= te.work_date
  ORDER BY r.effective_from DESC LIMIT 1)`;
export const entryCostCurrency = sql`(
  SELECT r.currency FROM user_cost_rates r
  WHERE r.user_id = te.user_id AND r.effective_from <= te.work_date
  ORDER BY r.effective_from DESC LIMIT 1)`;
