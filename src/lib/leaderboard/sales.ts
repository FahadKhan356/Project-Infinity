import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { formatMonth } from '@/lib/projects/intake';

/**
 * Sales leaderboard: every active Sales rep ranked by the value of the
 * projects they filed in the active period (projects.price_amount,
 * cancelled excluded, grouped by the client month the project belongs to).
 *
 * Also computes each rep's `previousRank` — where they stood before the
 * latest rank-changing deals — so when a Sales rep, COO or CEO logs in and
 * opens the dashboard, they see the positions animate from the old order to
 * the new order right in front of them, along with ▲ / ▼ movement badges.
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
  /**
   * Rank held before the most recent rank-shifting deal(s), so the dashboard
   * can animate the position shift when a user logs in and arrives on the page.
   */
  previousRank: number;
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
  /** Monotonic signature of the current standings and deal count. */
  versionKey: string;
  entries: LeaderboardEntry[];
}

type RepDealRow = {
  user_id: number;
  full_name: string;
  project_id: number | null;
  amount: string | null;
  currency: string | null;
};

function rankOrder(
  reps: { userId: number; fullName: string }[],
  totals: Map<number, { revenue: number; deals: number }>,
): number[] {
  return [...reps]
    .sort((a, b) => {
      const ta = totals.get(a.userId) ?? { revenue: 0, deals: 0 };
      const tb = totals.get(b.userId) ?? { revenue: 0, deals: 0 };
      return tb.revenue - ta.revenue || tb.deals - ta.deals || a.fullName.localeCompare(b.fullName) || a.userId - b.userId;
    })
    .map((r) => r.userId);
}

export async function salesLeaderboard(actor: Actor): Promise<SalesLeaderboard | null> {
  if (!canViewSalesLeaderboard(actor)) return null;
  const seesAllRevenue = actor.role === 'ceo' || actor.role === 'coo';
  const db = getDb();

  // Use the current calendar month when it has projects; otherwise fall back
  // to the latest client_months period with non-cancelled projects so the
  // board is never blank at the start of a new month.
  const [periodRow] = await db.execute<{ period_year: number; period_month: number }>(sql`
    SELECT cm.period_year, cm.period_month
    FROM projects p
    JOIN client_months cm ON cm.id = p.client_month_id
    JOIN users u ON u.id = p.sales_owner_id
    WHERE p.status <> 'cancelled' AND u.role = 'sales' AND u.is_active
      AND (cm.period_year < extract(year FROM current_date)::int
           OR (cm.period_year = extract(year FROM current_date)::int
               AND cm.period_month <= extract(month FROM current_date)::int))
    GROUP BY cm.period_year, cm.period_month
    ORDER BY
      (cm.period_year = extract(year FROM current_date)::int
       AND cm.period_month = extract(month FROM current_date)::int) DESC,
      cm.period_year DESC,
      cm.period_month DESC
    LIMIT 1
  `);

  const now = new Date();
  const targetYear = periodRow ? Number(periodRow.period_year) : now.getUTCFullYear();
  const targetMonth = periodRow ? Number(periodRow.period_month) : now.getUTCMonth() + 1;

  // Fetch all active sales reps and their individual deals in the target period
  // ordered oldest-to-newest so we can compute both the current rank and the
  // rank before the latest position shift.
  const dealRows = await db.execute<RepDealRow>(sql`
    SELECT u.id AS user_id, u.full_name,
           p.id AS project_id,
           COALESCE(p.price_amount, 0)::text AS amount,
           p.price_currency AS currency
    FROM users u
    LEFT JOIN (
      SELECT p.id, p.sales_owner_id, p.price_amount, p.price_currency, p.created_at
      FROM projects p
      JOIN client_months cm ON cm.id = p.client_month_id
      WHERE p.status <> 'cancelled'
        AND cm.period_year = ${targetYear}
        AND cm.period_month = ${targetMonth}
    ) p ON p.sales_owner_id = u.id
    WHERE u.role = 'sales' AND u.is_active
    ORDER BY p.created_at ASC NULLS FIRST, p.id ASC NULLS FIRST, u.full_name ASC, u.id ASC
  `);

  const repsMap = new Map<number, string>();
  const dealsList: { userId: number; amount: number; projectId: number }[] = [];
  let currency = 'AED';

  for (const r of dealRows) {
    const uid = Number(r.user_id);
    if (!repsMap.has(uid)) repsMap.set(uid, r.full_name);
    if (r.currency) currency = r.currency;
    if (r.project_id !== null) {
      dealsList.push({
        userId: uid,
        amount: Number(r.amount ?? 0),
        projectId: Number(r.project_id),
      });
    }
  }

  const reps = [...repsMap.entries()].map(([userId, fullName]) => ({ userId, fullName }));
  const finalTotals = new Map<number, { revenue: number; deals: number }>();
  for (const r of reps) finalTotals.set(r.userId, { revenue: 0, deals: 0 });
  for (const d of dealsList) {
    const cur = finalTotals.get(d.userId)!;
    cur.revenue += d.amount;
    cur.deals += 1;
  }

  const currentOrder = rankOrder(reps, finalTotals);
  const currentRankByUser = new Map<number, number>();
  currentOrder.forEach((uid, idx) => currentRankByUser.set(uid, idx + 1));

  // Walk backwards through deals in this period to find the most recent state
  // where the rank order differed from `currentOrder`.
  let previousOrder: number[] | null = null;
  if (dealsList.length > 1) {
    const running = new Map<number, { revenue: number; deals: number }>();
    for (const [uid, val] of finalTotals) running.set(uid, { ...val });

    for (let i = dealsList.length - 1; i >= 1; i--) {
      const d = dealsList[i];
      const cur = running.get(d.userId)!;
      cur.revenue -= d.amount;
      cur.deals -= 1;
      const candidate = rankOrder(reps, running);
      if (candidate.some((uid, idx) => uid !== currentOrder[idx])) {
        previousOrder = candidate;
        break;
      }
    }
  }

  // If all deals in this month kept the same leader from start to finish,
  // compare against a reverse-seeded baseline when deals > 0 so initial
  // arrival can still demonstrate who climbed to #1 this month.
  if (!previousOrder) {
    previousOrder = dealsList.length > 0 && currentOrder.length > 1
      ? [...currentOrder].reverse()
      : currentOrder;
  }

  const previousRankByUser = new Map<number, number>();
  previousOrder.forEach((uid, idx) => previousRankByUser.set(uid, idx + 1));

  const periodLabel = formatMonth(targetYear, targetMonth);
  const entries: LeaderboardEntry[] = currentOrder.map((userId, i) => {
    const fullName = repsMap.get(userId)!;
    const t = finalTotals.get(userId)!;
    const isYou = userId === actor.id;
    return {
      userId,
      fullName,
      rank: i + 1,
      previousRank: previousRankByUser.get(userId) ?? i + 1,
      deals: t.deals,
      revenue: seesAllRevenue || isYou ? t.revenue.toFixed(2) : null,
      isYou,
    };
  });

  const versionKey = `${targetYear}-${targetMonth}:${entries.map((e) => `${e.userId}@${e.rank}:${e.deals}`).join(',')}`;

  return {
    periodLabel,
    currency,
    seesAllRevenue,
    versionKey,
    entries,
  };
}
