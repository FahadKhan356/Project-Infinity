import 'server-only';
import { sql } from 'drizzle-orm';
import type { getDb } from '@/db';
import { normalizeCurrency } from '@/lib/currency';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Allocates the next project code for a year (brief §24: AKT-2026-0001).
 *
 * The upsert is a single atomic statement, so two Sales reps filing at the
 * same moment cannot be handed the same number — the second waits on the row
 * lock the first holds and gets the next value.
 */
export async function allocateProjectCode(tx: Tx, year: number): Promise<string> {
  // The counter is authoritative, but it can fall behind reality — a restored
  // database, or a row inserted by hand. Taking the greater of "next counter"
  // and "highest code that actually exists" makes the allocator correct itself
  // instead of handing out a code the unique index will reject.
  //
  // A retry loop cannot do this job: the allocation lives in the same
  // transaction as the insert, so a rollback returns the number and the next
  // attempt gets the same one.
  const pattern = `^AKT-${year}-[0-9]+$`;
  const rows = await tx.execute<{ last_number: number }>(sql`
    WITH existing AS (
      SELECT COALESCE(MAX(substring(project_code FROM 10)::int), 0) AS n
      FROM projects
      WHERE project_code ~ ${pattern}
    )
    INSERT INTO project_code_sequence (period_year, last_number)
    SELECT ${year}, existing.n + 1 FROM existing
    ON CONFLICT (period_year) DO UPDATE
      SET last_number = GREATEST(
            project_code_sequence.last_number + 1,
            (SELECT n + 1 FROM existing))
    RETURNING last_number
  `);
  const n = Number(rows[0].last_number);
  return `AKT-${year}-${String(n).padStart(4, '0')}`;
}

/**
 * Finds the client's bucket for a period, creating it if this is the first
 * project of that month (brief §32, §37).
 *
 * Buckets are never created by hand in the common case — filing a project is
 * what opens the month. ON CONFLICT makes two simultaneous first-projects
 * settle on one bucket instead of racing to create two.
 */
export async function resolveClientMonth(
  tx: Tx,
  input: { clientId: number; year: number; month: number; userId: number },
): Promise<{ id: number; created: boolean }> {
  const rows = await tx.execute<{ id: number; created: boolean }>(sql`
    INSERT INTO client_months (client_id, period_year, period_month, created_by)
    VALUES (${input.clientId}, ${input.year}, ${input.month}, ${input.userId})
    ON CONFLICT (client_id, period_year, period_month)
      DO UPDATE SET client_id = EXCLUDED.client_id
    RETURNING id, (xmax = 0) AS created
  `);
  return { id: Number(rows[0].id), created: rows[0].created === true };
}

export interface MonthOption {
  year: number;
  month: number;
  label: string;
  value: string;
}

/** The months Sales can file against: this month, the next two, and the last three. */
export function monthOptions(now = new Date()): MonthOption[] {
  const options: MonthOption[] = [];
  for (let delta = -3; delta <= 2; delta++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + delta, 1));
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    options.push({
      year,
      month,
      value: `${year}-${String(month).padStart(2, '0')}`,
      label: d.toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    });
  }
  return options;
}

export function parseMonthValue(value: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 2020 || year > 2100 || month < 1 || month > 12) return null;
  return { year, month };
}

export function formatMonth(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function formatMoney(amount: string | number | null, currency: string): string {
  if (amount === null) return '—';
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(value)) return '—';
  const normalizedCurrency = normalizeCurrency(currency);
  return `${normalizedCurrency} ${value.toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
