import 'server-only';
import { sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { can, projectScope } from '@/lib/authz';
import { entryCost, entryCostCurrency } from '@/lib/costs/rates';
import type { Period } from './monthly';

/**
 * Employee productivity, team performance and profitability (brief §29).
 *
 * Everything is read from what the portal already records, not from a form
 * anyone fills in for the report: the hours people log, the versions they
 * upload, the QA decisions on them, and when each file cleared QA. Figures
 * belong to the month the thing happened in.
 *
 *   hours       — time logged, dated by the day the work was done
 *   uploads     — versions uploaded
 *   approved    — files that cleared final QA, credited to their uploader
 *   first pass  — of those, how many were never sent back on the way
 *   on time     — of those with a due date, how many cleared QA by it
 *   reviews / sent back — QA decisions taken on the person's files
 *   estimate    — assignments finished this month that carried an
 *                 estimate: planned hours against hours actually logged
 *
 * A Team Lead sees their own teams only, and only the work done in them. The
 * Project Manager and management see every team. Profitability needs the
 * price, so it is shown to pricing roles alone. Each logged hour is costed
 * at its person's rate on the day it was worked (lib/costs), giving cost and
 * margin; individual rates themselves are never shown here.
 */

export function canViewProductivity(actor: Actor): boolean {
  return actor.isActive && (can(actor, 'projects.viewAll') || actor.leadDepartmentIds.length > 0);
}

export interface PerformanceFigures {
  minutes: number;
  uploads: number;
  approved: number;
  firstPass: number;
  withDueDate: number;
  onTime: number;
  reviews: number;
  sentBack: number;
  finishedWithEstimate: number;
  estimatedMinutes: number;
  actualMinutes: number;
}

export interface PersonRow extends PerformanceFigures {
  userId: number;
  name: string;
  role: string;
  teams: string;
}

export interface TeamRow extends PerformanceFigures {
  departmentId: number;
  name: string;
  members: number;
}

export interface ProfitabilityRow {
  projectId: number;
  projectCode: string;
  title: string;
  clientName: string;
  status: string;
  priceAmount: number | null;
  currency: string;
  loggedMinutes: number;
  estimatedMinutes: number;
  deliverables: number;
  approved: number;
  /** Price divided by logged hours; null without both. */
  valuePerHour: number | null;
  /** Logged time at each person's rate on the day. */
  cost: number;
  /** Logged minutes with no rate in force: the cost is understated by these. */
  unratedMinutes: number;
  /** Price less cost; null without a price, or when rates are in another currency. */
  margin: number | null;
}

export interface ProductivityReport {
  period: Period;
  allTeams: boolean;
  people: PersonRow[];
  teams: TeamRow[];
  /** null for those who may not see pricing. */
  profitability: ProfitabilityRow[] | null;
}

type Key = 'person' | 'team';

function bounds(p: Period): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const next = p.month === 12 ? { y: p.year + 1, m: 1 } : { y: p.year, m: p.month + 1 };
  return { from: `${p.year}-${pad(p.month)}-01`, to: `${next.y}-${pad(next.m)}-01` };
}

function departmentFilter(actor: Actor, column: SQL): SQL {
  if (can(actor, 'projects.viewAll')) return sql`TRUE`;
  if (actor.leadDepartmentIds.length === 0) return sql`FALSE`;
  return sql`${column} IN (${sql.join(actor.leadDepartmentIds.map((id) => sql`${id}`), sql`, `)})`;
}

/** The figures keyed by person or by team, over the teams the actor may see. */
async function figures(actor: Actor, period: Period, key: Key) {
  const { from, to } = bounds(period);
  const inScope = departmentFilter(actor, sql`pd.department_id`);
  const k = (personColumn: SQL): SQL => (key === 'person' ? personColumn : sql`s.department_id`);
  const rangeTs = (col: SQL) => sql`${col} >= ${from}::date AND ${col} < ${to}::date`;

  const rows = await getDb().execute<{
    k: number; minutes: number; uploads: number; approved: number; first_pass: number;
    with_due: number; on_time: number; reviews: number; sent_back: number;
    finished: number; est: number; actual: number;
  }>(sql`
    WITH s AS (SELECT pd.id, pd.department_id FROM project_departments pd WHERE ${inScope}),
    t AS (
      SELECT ${k(sql`te.user_id`)} AS k, sum(te.minutes)::int AS minutes
      FROM time_entries te
      JOIN assignments a ON a.id = te.assignment_id
      JOIN s ON s.id = a.project_department_id
      WHERE ${rangeTs(sql`te.work_date`)}
      GROUP BY 1),
    up AS (
      SELECT ${k(sql`v.uploaded_by`)} AS k, count(*)::int AS uploads
      FROM deliverable_versions v
      JOIN deliverables d ON d.id = v.deliverable_id
      JOIN s ON s.id = d.project_department_id
      WHERE ${rangeTs(sql`v.uploaded_at`)}
      GROUP BY 1),
    rv AS (
      SELECT ${k(sql`v.uploaded_by`)} AS k, count(*)::int AS reviews,
             count(*) FILTER (WHERE q.decision <> 'approved')::int AS sent_back
      FROM qa_reviews q
      JOIN deliverable_versions v ON v.id = q.deliverable_version_id
      JOIN deliverables d ON d.id = v.deliverable_id
      JOIN s ON s.id = d.project_department_id
      WHERE ${rangeTs(sql`q.reviewed_at`)}
      GROUP BY 1),
    ap AS (
      SELECT ${k(sql`v.uploaded_by`)} AS k, count(*)::int AS approved,
             count(*) FILTER (WHERE NOT EXISTS (
               SELECT 1 FROM qa_reviews q2
               JOIN deliverable_versions v2 ON v2.id = q2.deliverable_version_id
               WHERE v2.deliverable_id = d.id AND q2.decision <> 'approved'
                 AND q2.reviewed_at <= dl.approved_at))::int AS first_pass,
             count(*) FILTER (WHERE d.due_date IS NOT NULL)::int AS with_due,
             count(*) FILTER (WHERE d.due_date IS NOT NULL
                                AND dl.approved_at::date <= d.due_date)::int AS on_time
      FROM deliveries dl
      JOIN deliverable_versions v ON v.id = dl.deliverable_version_id
      JOIN deliverables d ON d.id = dl.deliverable_id
      JOIN s ON s.id = d.project_department_id
      WHERE ${rangeTs(sql`dl.approved_at`)}
      GROUP BY 1),
    est AS (
      SELECT ${k(sql`a.assignee_id`)} AS k, count(*)::int AS finished,
             sum(a.estimated_minutes)::int AS est,
             sum((SELECT COALESCE(sum(te.minutes), 0) FROM time_entries te
                   WHERE te.assignment_id = a.id))::int AS actual
      FROM assignments a
      JOIN s ON s.id = a.project_department_id
      WHERE a.status = 'completed' AND a.estimated_minutes IS NOT NULL
        AND ${rangeTs(sql`a.updated_at`)}
      GROUP BY 1),
    keys AS (
      SELECT k FROM t UNION SELECT k FROM up UNION SELECT k FROM rv
      UNION SELECT k FROM ap UNION SELECT k FROM est)
    SELECT keys.k,
           COALESCE(t.minutes, 0) AS minutes, COALESCE(up.uploads, 0) AS uploads,
           COALESCE(ap.approved, 0) AS approved, COALESCE(ap.first_pass, 0) AS first_pass,
           COALESCE(ap.with_due, 0) AS with_due, COALESCE(ap.on_time, 0) AS on_time,
           COALESCE(rv.reviews, 0) AS reviews, COALESCE(rv.sent_back, 0) AS sent_back,
           COALESCE(est.finished, 0) AS finished, COALESCE(est.est, 0) AS est,
           COALESCE(est.actual, 0) AS actual
    FROM keys
    LEFT JOIN t   ON t.k = keys.k
    LEFT JOIN up  ON up.k = keys.k
    LEFT JOIN rv  ON rv.k = keys.k
    LEFT JOIN ap  ON ap.k = keys.k
    LEFT JOIN est ON est.k = keys.k
  `);

  const byKey = new Map<number, PerformanceFigures>();
  for (const r of rows) {
    byKey.set(Number(r.k), {
      minutes: Number(r.minutes), uploads: Number(r.uploads), approved: Number(r.approved),
      firstPass: Number(r.first_pass), withDueDate: Number(r.with_due), onTime: Number(r.on_time),
      reviews: Number(r.reviews), sentBack: Number(r.sent_back),
      finishedWithEstimate: Number(r.finished), estimatedMinutes: Number(r.est), actualMinutes: Number(r.actual),
    });
  }
  return byKey;
}

const EMPTY: PerformanceFigures = {
  minutes: 0, uploads: 0, approved: 0, firstPass: 0, withDueDate: 0, onTime: 0,
  reviews: 0, sentBack: 0, finishedWithEstimate: 0, estimatedMinutes: 0, actualMinutes: 0,
};

export async function loadProductivityReport(actor: Actor, period: Period): Promise<ProductivityReport | null> {
  if (!canViewProductivity(actor)) return null;
  const db = getDb();
  const allTeams = can(actor, 'projects.viewAll');
  const [byPerson, byTeam] = await Promise.all([
    figures(actor, period, 'person'),
    figures(actor, period, 'team'),
  ]);

  // Everyone in the teams in view is listed, so a quiet month shows as zero
  // rather than as an absence; so is anyone with figures, a PM who uploaded say.
  const memberFilter = departmentFilter(actor, sql`dm.department_id`);
  const personIds = [...byPerson.keys()];
  const people = await db.execute<{ id: number; full_name: string; role: string; teams: string | null }>(sql`
    SELECT u.id, u.full_name, u.role,
           (SELECT string_agg(dep.name, ', ' ORDER BY dep.sort_order)
              FROM department_members dm JOIN departments dep ON dep.id = dm.department_id
             WHERE dm.user_id = u.id AND ${memberFilter}) AS teams
    FROM users u
    WHERE (u.is_active AND EXISTS (SELECT 1 FROM department_members dm
                                   WHERE dm.user_id = u.id AND ${memberFilter}))
       ${personIds.length > 0 ? sql`OR u.id IN (${sql.join(personIds.map((id) => sql`${id}`), sql`, `)})` : sql``}
    ORDER BY u.full_name
  `);

  const teams = await db.execute<{ id: number; name: string; members: number }>(sql`
    SELECT d.id, d.name,
           (SELECT count(*) FROM department_members dm JOIN users u ON u.id = dm.user_id
             WHERE dm.department_id = d.id AND u.is_active)::int AS members
    FROM departments d
    WHERE d.is_production AND d.is_active AND ${departmentFilter(actor, sql`d.id`)}
    ORDER BY d.sort_order
  `);

  let profitability: ProfitabilityRow[] | null = null;
  if (allTeams && can(actor, 'pricing.view')) {
    const rows = await db.execute<{
      id: number; project_code: string; title: string; client_name: string; status: string;
      price_amount: string | null; price_currency: string; logged: number; estimated: number;
      total: number; approved: number; cost: string; unrated: number; foreign_entries: number;
    }>(sql`
      SELECT p.id, p.project_code, p.title, c.name AS client_name, p.status,
             p.price_amount::text AS price_amount, p.price_currency,
             (SELECT COALESCE(sum(te.minutes), 0) FROM time_entries te WHERE te.project_id = p.id)::int AS logged,
             (SELECT COALESCE(sum(a.estimated_minutes), 0) FROM assignments a
               WHERE a.project_id = p.id AND a.status <> 'cancelled')::int AS estimated,
             prog.total, prog.approved,
             (SELECT COALESCE(sum(${entryCost}), 0) FROM time_entries te WHERE te.project_id = p.id)::text AS cost,
             (SELECT COALESCE(sum(te.minutes), 0) FROM time_entries te
               WHERE te.project_id = p.id AND ${entryCost} IS NULL)::int AS unrated,
             (SELECT count(*) FROM time_entries te
               WHERE te.project_id = p.id AND ${entryCostCurrency} <> p.price_currency)::int AS foreign_entries
      FROM projects p
      JOIN clients c            ON c.id = p.client_id
      JOIN client_months cm     ON cm.id = p.client_month_id
      JOIN v_project_progress prog ON prog.project_id = p.id
      WHERE cm.period_year = ${period.year} AND cm.period_month = ${period.month}
        AND p.status <> 'cancelled' AND ${projectScope(actor, 'p')}
      ORDER BY c.name, p.project_code
    `);
    profitability = rows.map((r) => {
      const price = r.price_amount === null ? null : Number(r.price_amount);
      const logged = Number(r.logged);
      const cost = Math.round(Number(r.cost) * 100) / 100;
      return {
        projectId: Number(r.id), projectCode: r.project_code, title: r.title, clientName: r.client_name,
        status: r.status, priceAmount: price, currency: r.price_currency,
        loggedMinutes: logged, estimatedMinutes: Number(r.estimated),
        deliverables: Number(r.total), approved: Number(r.approved),
        valuePerHour: price !== null && logged > 0 ? Math.round((price / (logged / 60)) * 100) / 100 : null,
        cost,
        unratedMinutes: Number(r.unrated),
        margin: price !== null && Number(r.foreign_entries) === 0 ? Math.round((price - cost) * 100) / 100 : null,
      };
    });
  }

  return {
    period,
    allTeams,
    people: people.map((u) => ({
      userId: Number(u.id), name: u.full_name, role: u.role, teams: u.teams ?? '',
      ...(byPerson.get(Number(u.id)) ?? EMPTY),
    })),
    teams: teams.map((d) => ({
      departmentId: Number(d.id), name: d.name, members: Number(d.members),
      ...(byTeam.get(Number(d.id)) ?? EMPTY),
    })),
    profitability,
  };
}

/** "83%" or "—" when there is nothing to divide by. */
export function rate(part: number, whole: number): string {
  return whole === 0 ? '—' : `${Math.round((part / whole) * 100)}%`;
}
