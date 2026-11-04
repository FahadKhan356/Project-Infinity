import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';

/**
 * Sales leaderboard: every active Sales rep ranked by the value of the
 * projects they filed this month (the same figure the dashboard calls
 * "Value filed this month": projects.price_amount, cancelled excluded,
 * grouped by the client month the project belongs to).
 *
 * Seen by Sales, the CEO and the COO only. Privacy is enforced here, not in
 * the browser: a Sales rep receives their own revenue and nobody else's —
 * other reps' figures are null in the payload, so blurring them on screen
 * hides nothing that was ever sent. Management sees every figure.
 */
export const LEADERBOARD_ROLES = ['sales', 'ceo', 'coo'] as const;

export function canViewSalesLeaderboard(actor: Actor): boolean {
  return (LEADERBOARD_ROLES as readonly string[]).includes(actor.role);
}

export interface LeaderboardEntry {
  userId: number;
  fullName: string;
  rank: number;
  deals: number;
  /** null when the viewer may not see this rep's figure. */
  revenue: string | null;
  isYou: boolean;
}

export interface SalesLeaderboard {
  /** "November 2026" */
  periodLabel: string;
  currency: string;
  /** Whether the viewer sees every rep's figure (management). */
  seesAllRevenue: boolean;
  entries: LeaderboardEntry[];
}

export async function salesLeaderboard(actor: Actor): Promise<SalesLeaderboard | null> {
  if (!canViewSalesLeaderboard(actor)) return null;
  const seesAllRevenue = actor.role === 'ceo' || actor.role === 'coo';

  const rows = await getDb().execute<{
    user_id: number; full_name: string; deals: number; revenue: string; currency: string | null;
  }>(sql`
    SELECT u.id AS user_id, u.full_name,
           count(p.id)::int AS deals,
           COALESCE(sum(p.price_amount), 0)::text AS revenue,
           max(p.price_currency) AS currency
    FROM users u
    LEFT JOIN projects p
      ON p.sales_owner_id = u.id
     AND p.status <> 'cancelled'
     AND EXISTS (
       SELECT 1 FROM client_months cm
       WHERE cm.id = p.client_month_id
         AND cm.period_year = extract(year FROM current_date)::int
         AND cm.period_month = extract(month FROM current_date)::int
     )
    WHERE u.role = 'sales' AND u.is_active
    GROUP BY u.id, u.full_name
    -- Highest value first; equal value goes to more deals, then by name so
    -- the order is stable between polls.
    ORDER BY sum(p.price_amount) DESC NULLS LAST, count(p.id) DESC, u.full_name, u.id
  `);

  const now = new Date();
  const periodLabel = now.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
  const currency = rows.find((r) => r.currency)?.currency ?? 'AED';

  return {
    periodLabel,
    currency,
    seesAllRevenue,
    entries: rows.map((r, i) => {
      const userId = Number(r.user_id);
      const isYou = userId === actor.id;
      return {
        userId,
        fullName: r.full_name,
        rank: i + 1,
        deals: Number(r.deals),
        revenue: seesAllRevenue || isYou ? String(r.revenue) : null,
        isYou,
      };
    }),
  };
}

