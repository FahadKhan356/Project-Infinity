import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { can, projectScope } from '@/lib/authz';
import { leadTeamFilter } from '@/lib/reports/monthly';

export interface MonthSummary {
  id: number;
  year: number;
  month: number;
  status: 'open' | 'closed';
  closedAt: string | null;
  /** Who closed it; null for a month the nightly archive took (§36). */
  closedBy: string | null;
  /** When management reopened it (§36); set only while open, cleared by the next close. */
  reopenedAt: string | null;
  /**
   * Projects visible to this actor, cancelled ones left out, so the number
   * matches the month report (which leaves them out too). The client page
   * lists the cancelled ones beneath the line as well, marked, and says how
   * many with `cancelled` — so the line and the list agree.
   */
  projects: number;
  /** Cancelled projects visible to this actor; in none of the other numbers. */
  cancelled: number;
  deliverables: number;
  completed: number;
  /** Approved, not yet delivered. */
  ready: number;
  inQa: number;
  inRevision: number;
  pending: number;
  departments: string[];
}

/**
 * One line per month of a client's history — the §39 report in its simplest
 * form: how much was ordered, how much is done, what is still moving, and
 * which teams were involved. Scoped the way the month report is
 * (lib/reports/monthly.ts loadClientReport): an Executive's numbers cover
 * only the projects they can open, a Team Lead's only their teams' slots,
 * and a project shared with a rep counts for them — so the line here and
 * the report it links to say the same thing.
 */
export async function monthSummaries(actor: Actor, clientId: number): Promise<MonthSummary[]> {
  const rows = await getDb().execute<{
    id: number; period_year: number; period_month: number; status: 'open' | 'closed';
    closed_at: string | null; closed_by: string | null; reopened_at: string | null;
    projects: number; cancelled: number; deliverables: number; completed: number; ready: number; in_qa: number;
    in_revision: number; pending: number; departments: string[] | null;
  }>(sql`
    WITH visible AS (
      SELECT p.id, p.client_month_id, p.status
      FROM projects p
      WHERE p.client_id = ${clientId} AND p.status <> 'cancelled'
        AND ${projectScope(actor, 'p', { shared: true })}
    ),
    -- Cancelled orders are listed beneath the line, so they are counted apart.
    dropped AS (
      SELECT p.id, p.client_month_id
      FROM projects p
      WHERE p.client_id = ${clientId} AND p.status = 'cancelled'
        AND ${projectScope(actor, 'p', { shared: true })}
    ),
    -- A Team Lead's line stops at the teams they lead, as the report does.
    teams AS (
      SELECT pd.id, pd.project_id, pd.department_id
      FROM project_departments pd
      JOIN visible v ON v.id = pd.project_id
      WHERE true ${leadTeamFilter(actor, 'pd')}
    ),
    -- Each slot lands in exactly one bucket, the same buckets the monthly
    -- report uses (lib/reports/monthly.ts), so the two pages agree.
    bucketed AS (
      SELECT v.client_month_id,
             CASE
               WHEN EXISTS (
                 SELECT 1 FROM revision_deliverables rd
                 JOIN revisions r ON r.id = rd.revision_id
                 WHERE rd.deliverable_id = d.id
                   AND r.status IN ('new','assigned','in_progress','awaiting_qa')
               ) THEN 'in_revision'
               WHEN d.status = 'delivered' THEN 'completed'
               WHEN d.status IN ('awaiting_lead_qa','awaiting_pm_qa') THEN 'in_qa'
               WHEN d.status = 'approved' THEN 'ready'
               ELSE 'pending'
             END AS bucket
      FROM visible v
      JOIN teams t ON t.project_id = v.id
      JOIN deliverables d ON d.project_department_id = t.id AND d.status <> 'cancelled'
    ),
    slots AS (
      SELECT client_month_id,
             count(*)::int AS deliverables,
             count(*) FILTER (WHERE bucket = 'completed')::int AS completed,
             count(*) FILTER (WHERE bucket = 'ready')::int AS ready,
             count(*) FILTER (WHERE bucket = 'in_qa')::int AS in_qa,
             count(*) FILTER (WHERE bucket = 'in_revision')::int AS in_revision,
             count(*) FILTER (WHERE bucket = 'pending')::int AS pending
      FROM bucketed
      GROUP BY client_month_id
    )
    SELECT cm.id, cm.period_year, cm.period_month, cm.status,
           to_char(cm.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS closed_at,
           closer.full_name AS closed_by,
           to_char(cm.reopened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS reopened_at,
           (SELECT count(*)::int FROM visible v WHERE v.client_month_id = cm.id) AS projects,
           (SELECT count(*)::int FROM dropped x WHERE x.client_month_id = cm.id) AS cancelled,
           COALESCE(s.deliverables, 0) AS deliverables,
           COALESCE(s.completed, 0) AS completed,
           COALESCE(s.ready, 0) AS ready,
           COALESCE(s.in_qa, 0) AS in_qa,
           COALESCE(s.in_revision, 0) AS in_revision,
           COALESCE(s.pending, 0) AS pending,
           (SELECT array_agg(DISTINCT dep.name ORDER BY dep.name)
              FROM visible v
              JOIN teams t ON t.project_id = v.id
              JOIN departments dep ON dep.id = t.department_id
             WHERE v.client_month_id = cm.id) AS departments
    FROM client_months cm
    LEFT JOIN slots s ON s.client_month_id = cm.id
    LEFT JOIN users closer ON closer.id = cm.closed_by
    WHERE cm.client_id = ${clientId}
    ORDER BY cm.period_year DESC, cm.period_month DESC
  `);

  return rows.map((r) => ({
    id: Number(r.id),
    year: Number(r.period_year),
    month: Number(r.period_month),
    status: r.status,
    closedAt: r.closed_at,
    closedBy: r.closed_by,
    reopenedAt: r.reopened_at,
    projects: Number(r.projects),
    cancelled: Number(r.cancelled),
    deliverables: Number(r.deliverables),
    completed: Number(r.completed),
    ready: Number(r.ready),
    inQa: Number(r.in_qa),
    inRevision: Number(r.in_revision),
    pending: Number(r.pending),
    departments: r.departments ?? [],
  }));
}

/** What the month helpers below need to know about a month. */
export interface MonthLike {
  year: number;
  month: number;
  status: 'open' | 'closed';
}

const newestFirst = (a: MonthLike, b: MonthLike) => b.year * 12 + b.month - (a.year * 12 + a.month);

/**
 * The §35 "Current month": the open month that holds today. A month opened
 * early for planning (§37) must not push this month out of view, so a
 * future open month is never current while this one is open; with nothing
 * open this month, the newest open month stands in. Closed months are the
 * archive (§36). Months are compared in UTC, like every other month
 * computation in the portal.
 */
export function currentMonthOf<M extends MonthLike>(months: M[], today: Date = new Date()): M | null {
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1;
  const open = months.filter((m) => m.status === 'open').sort(newestFirst);
  return open.find((m) => m.year === year && m.month === month) ?? open[0] ?? null;
}

/**
 * The month "+ Create …" offers (brief §37): the one after the newest on
 * record, so a rep planning ahead can keep going — October, then November —
 * but never a month already behind us: a dormant client's next month is
 * this one, and so is a client's first.
 */
export function nextMonthToOpen(months: MonthLike[], today: Date = new Date()): { year: number; month: number } {
  const thisMonth = { year: today.getUTCFullYear(), month: today.getUTCMonth() + 1 };
  const newest = [...months].sort(newestFirst)[0];
  if (!newest) return thisMonth;
  const index = newest.year * 12 + newest.month; // the month after, as months since year 0
  const next = { year: Math.floor(index / 12), month: (index % 12) + 1 };
  return index < thisMonth.year * 12 + (thisMonth.month - 1) ? thisMonth : next;
}

/**
 * The "70%" of the §35 progress column: approved slots over all slots, to
 * the whole percent. Null while an order has no slots — not yet routed, or
 * every slot cancelled — since 0 of 0 is not 0% done.
 */
export function progressPercent(approved: number, total: number): number | null {
  return total > 0 ? Math.round((approved / total) * 100) : null;
}

/**
 * The §35 layout of a client's months: the current month on top, the months
 * opened ahead of it for planning (§37) apart, and every earlier month —
 * open or closed — under "View previous months". "Current" is what
 * `currentMonthOf` says it is; with no open month at all there is no current
 * month and the whole history is previous. Each list is newest first.
 */
export function groupMonths<M extends MonthLike>(
  months: M[],
  today: Date = new Date(),
): { current: M | null; upcoming: M[]; previous: M[] } {
  const current = currentMonthOf(months, today);
  const sorted = [...months].sort(newestFirst);
  if (!current) return { current: null, upcoming: [], previous: sorted };
  const index = (m: MonthLike) => m.year * 12 + m.month;
  const now = index(current);
  return {
    current,
    upcoming: sorted.filter((m) => index(m) > now),
    previous: sorted.filter((m) => index(m) < now),
  };
}

/** One order as the client overview lists it under its month (§35). */
export interface ClientProjectRow {
  id: number;
  clientMonthId: number;
  projectCode: string;
  title: string;
  status: string;
  /** The production teams on the order, in the departments' own order. */
  teams: string | null;
  /** Null for a viewer without pricing.view (§23), as a string for the others. */
  priceAmount: string | null;
  priceCurrency: string;
  total: number;
  approved: number;
  /** `progressPercent(approved, total)`. */
  percent: number | null;
}

export interface MonthBlock {
  month: MonthSummary;
  projects: ClientProjectRow[];
}

export interface ClientMonths {
  /** Every month on record, newest first, as `monthSummaries` gives them. */
  months: MonthSummary[];
  /** Every order visible to the viewer, newest filed first — the lifetime counters. */
  projects: ClientProjectRow[];
  showPricing: boolean;
  current: MonthBlock | null;
  upcoming: MonthBlock[];
  previous: MonthBlock[];
}

/**
 * What the client page shows of a client's months (§35): each month's line,
 * the orders visible to this viewer beneath it, and the months grouped as
 * `groupMonths` lays them out. Like `monthSummaries`, this does not check
 * that the client itself is visible — the page does, and 404s first — but
 * the orders are scoped, so a rep who reaches a foreign client through one
 * shared project gets its months with only that project listed.
 *
 * A Team Lead's month line stops at their teams' slots (`monthSummaries`),
 * while an order's approved/total here comes from v_project_progress and so
 * counts every team's slots; the two have always differed that way and the
 * percentage follows the order's own numbers.
 */
export async function loadClientMonths(
  actor: Actor,
  clientId: number,
  options: { today?: Date } = {},
): Promise<ClientMonths> {
  const showPricing = can(actor, 'pricing.view');
  const [months, rows] = await Promise.all([
    monthSummaries(actor, clientId),
    getDb().execute<{
      id: number; client_month_id: number; project_code: string; title: string; status: string;
      teams: string | null; price_amount: string | null; price_currency: string;
      total: number; approved: number;
    }>(sql`
      SELECT p.id, p.client_month_id, p.project_code, p.title, p.status,
             ${showPricing ? sql`p.price_amount` : sql`NULL::numeric`} AS price_amount,
             p.price_currency,
             (SELECT string_agg(d.name, ', ' ORDER BY d.sort_order)
                FROM project_departments pd JOIN departments d ON d.id = pd.department_id
               WHERE pd.project_id = p.id) AS teams,
             prog.total::int AS total, prog.approved::int AS approved
      FROM projects p
      JOIN v_project_progress prog ON prog.project_id = p.id
      WHERE p.client_id = ${clientId} AND ${projectScope(actor, 'p', { shared: true })}
      ORDER BY p.created_at DESC
    `),
  ]);

  const projects: ClientProjectRow[] = rows.map((r) => {
    const total = Number(r.total);
    const approved = Number(r.approved);
    return {
      id: Number(r.id),
      clientMonthId: Number(r.client_month_id),
      projectCode: r.project_code,
      title: r.title,
      status: r.status,
      teams: r.teams,
      priceAmount: r.price_amount === null ? null : String(r.price_amount),
      priceCurrency: r.price_currency,
      total,
      approved,
      percent: progressPercent(approved, total),
    };
  });

  const byMonth = new Map<number, ClientProjectRow[]>();
  for (const p of projects) {
    const list = byMonth.get(p.clientMonthId) ?? [];
    list.push(p);
    byMonth.set(p.clientMonthId, list);
  }
  const block = (month: MonthSummary): MonthBlock => ({ month, projects: byMonth.get(month.id) ?? [] });

  const grouped = groupMonths(months, options.today);
  return {
    months,
    projects,
    showPricing,
    current: grouped.current ? block(grouped.current) : null,
    upcoming: grouped.upcoming.map(block),
    previous: grouped.previous.map(block),
  };
}
