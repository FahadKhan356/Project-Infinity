import 'server-only';
import { sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor, ScopeOptions } from '@/lib/authz';
import { can, clientScope, projectScope, revisionScope } from '@/lib/authz';
import { FEED_ACTIONS, toActivityLines, type ActivityLine, type ActivityRow } from '@/lib/activity/feed';
import { convertCurrencyAmount, normalizeCurrency, USD_TO_PKR_RATE } from '@/lib/currency';

/**
 * Monthly reporting (brief §39) and the month folder's contents (§33).
 *
 * Every number is computed over the projects the actor could open — the same
 * projectScope() every list composes — so Sales' report covers their own
 * clients and an Executive's covers the projects they work on. A Team Lead
 * (only here with an export grant) is further held to the teams they lead,
 * the rule revisionScope() applies: the Design lead does not report on the
 * Video team's slots.
 *
 * One client's month (loadClientReport) is the month folder the client page
 * links to, so it is read with the same `shared` scope as that page: a
 * project shared with a rep to view is in it. The portfolio report sums a
 * rep's own book and keeps the default scope, as lib/authz/scope says.
 *
 * The month folder is an archive (§33): besides the numbers and the final
 * files it lists every deliverable slot of its projects and every version
 * ever uploaded to them, with the QA verdicts each one got — the superseded
 * v1 and its rejection read alongside the approved v2.
 *
 * Deliverable counts are a partition, so the columns add up to the total
 * the way the §39 example does (47 = 42 + 3 + 2):
 *
 *   in revision — not cancelled and touched by a revision still being reworked
 *   completed   — delivered to the client
 *   in QA       — waiting on a Team Lead or PM decision
 *   ready       — approved, not yet delivered
 *   pending     — everything else: unassigned, in progress, sent back
 *
 * Cancelled projects and cancelled slots are left out: nothing was delivered
 * and nothing is owed.
 */
export interface Period {
  year: number;
  month: number;
}

export interface BucketCounts {
  deliverables: number;
  completed: number;
  ready: number;
  inQa: number;
  inRevision: number;
  pending: number;
}

/** Only ever populated for actors who may see pricing (brief §21, §23). */
export interface OrderValue {
  amount: string;
  /** More than one currency is listed, not converted: "AED/USD". */
  currency: string;
}

export interface PortfolioRow extends BucketCounts {
  clientId: number;
  clientName: string;
  projects: number;
  departments: string[];
  value: OrderValue | null;
}

export interface DepartmentRow extends BucketCounts {
  departmentId: number;
  name: string;
  projects: number;
}

export interface PortfolioReport {
  period: Period;
  showPricing: boolean;
  rows: PortfolioRow[];
  totals: Omit<PortfolioRow, 'clientId' | 'clientName'>;
  departments: DepartmentRow[];
}

export interface ReportProject {
  id: number;
  projectCode: string;
  title: string;
  status: string;
  teams: string | null;
  approved: number;
  total: number;
  deadline: string | null;
  deliveredOn: string | null;
  /** Comments on the project, its slots, its file versions and its revisions (§33 "comments"). */
  comments: number;
  value: OrderValue | null;
}

export interface ReportFile {
  deliverableId: number;
  deliverableName: string;
  projectId: number;
  projectCode: string;
  department: string;
  versionNo: number;
  status: 'approved' | 'delivered';
  originalFilename: string;
  sizeBytes: number;
  deliveredOn: string | null;
  downloadUrl: string;
}

/** One QA decision on a version (§12, §13), as the workspace keeps it. */
export interface ReportReview {
  stage: 'team_lead' | 'project_manager';
  decision: 'approved' | 'changes_requested' | 'rejected';
  reviewer: string;
  /** ISO UTC. */
  reviewedAt: string;
  comments: string | null;
}

/** One upload to a slot, current or superseded. */
export interface ReportVersion {
  id: number;
  versionNo: number;
  originalFilename: string;
  sizeBytes: number;
  uploadedBy: string;
  /** ISO UTC. */
  uploadedAt: string;
  /** What the uploader said with it. */
  notes: string | null;
  /** The client revision it was uploaded for, when it was. */
  revisionNo: number | null;
  /** The newest decision on this version, or 'pending' while it has none. */
  qaStatus: 'pending' | 'approved' | 'changes_requested' | 'rejected';
  /** Every decision on this version, newest first. */
  reviews: ReportReview[];
  isDeleted: boolean;
  /**
   * Null when the download route would refuse it (lib/files/access
   * decideFileAccess): a deleted file, unless the reader may delete files.
   * The row stays — the archive records that the version existed.
   */
  downloadUrl: string | null;
}

/** One deliverable slot of a month's project, with its whole upload history. */
export interface ReportDeliverable {
  id: number;
  projectId: number;
  projectCode: string;
  department: string;
  sequenceNo: number;
  name: string;
  status: string;
  dueDate: string | null;
  assignee: string | null;
  /** Oldest first: v1, v2, … */
  versions: ReportVersion[];
}

export interface ReportRevision {
  id: number;
  projectId: number;
  projectCode: string;
  revisionNo: number;
  title: string;
  status: string;
  openedOn: string;
  closedOn: string | null;
  deliverables: number;
  /**
   * Whether /revisions/[id] would open for this reader (loadRevision's rule).
   * The archive is history (§33): an Executive reads every revision on a
   * previous project of theirs here, but opens only those on their current
   * work (§16), so the view links only what `canOpen`.
   */
  canOpen: boolean;
}

export interface ReportPerson {
  userId: number;
  fullName: string;
  department: string;
  isLead: boolean;
  /** Slots assigned to this person on the month's projects. */
  slots: number;
}

export interface ReportComment {
  id: number;
  author: string;
  body: string;
  at: string;
  projectId: number;
  projectCode: string;
  /**
   * Where it was left: 'project', the deliverable's name, 'Thumbnail 01 v3'
   * for a file version (§10, §19), 'Revision #NN' or the assignment's title.
   */
  about: string;
}

export interface ClientReport {
  client: { id: number; name: string };
  period: Period;
  month: { id: number; status: 'open' | 'closed' } | null;
  showPricing: boolean;
  /** Whether the reader may keep a copy of the files listed (files.download, §43). */
  canDownload: boolean;
  headline: Omit<PortfolioRow, 'clientId' | 'clientName'>;
  departments: DepartmentRow[];
  projects: ReportProject[];
  /**
   * §33: every slot of the month's visible projects — cancelled ones
   * excluded, like the counts — with every version and its QA history.
   * `files` below is the narrower "final approved files" block.
   */
  deliverables: ReportDeliverable[];
  files: ReportFile[];
  revisions: ReportRevision[];
  people: ReportPerson[];
  /** What was said on the month's projects (§33), oldest first; revision threads under `revisionScope`. */
  comments: ReportComment[];
  /**
   * The month's complete activity (§36): every feed line of its visible
   * projects plus the month's own opening, closing, reopening and copies,
   * oldest first.
   */
  activity: ActivityLine[];
}

/** Who may open /reports: management and PMs, Sales for their own book, or an export grant. */
export function canViewReports(actor: Actor): boolean {
  return can(actor, 'projects.viewAll') || can(actor, 'projects.create') || can(actor, 'reports.export');
}

/** `2026-09` → { 2026, 9 }; anything else falls back to the current month. */
export function parsePeriod(value: string | null | undefined, now = new Date()): Period {
  const match = /^(\d{4})-(\d{2})$/.exec(value ?? '');
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (year >= 2020 && year <= 2100 && month >= 1 && month <= 12) return { year, month };
  }
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

export function periodValue(p: Period): string {
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

export function shiftPeriod(p: Period, delta: number): Period {
  const d = new Date(Date.UTC(p.year, p.month - 1 + delta, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

function idList(ids: number[]): SQL {
  return sql.join(ids.map((id) => sql`${id}`), sql`, `);
}

/**
 * A Team Lead's report stops at the teams they lead; everyone else sees
 * whole projects. An `AND …` clause on a project_departments alias, empty
 * for everyone but a lead. Shared with the client page's month lines
 * (lib/months/queries), which count the same way.
 */
export function leadTeamFilter(actor: Actor, alias = 'pd'): SQL {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`Unsafe SQL alias: ${alias}`);
  if (actor.role !== 'team_lead' || can(actor, 'projects.viewAll')) return sql``;
  if (actor.leadDepartmentIds.length === 0) return sql`AND false`;
  return sql`AND ${sql.raw(alias)}.department_id IN (${idList(actor.leadDepartmentIds)})`;
}

/**
 * The three CTEs every report query starts from:
 *   visible — the period's projects this actor can open
 *   teams   — their department rows, held to a lead's own teams
 *   slots   — their deliverables, each in exactly one bucket
 */
function reportCtes(actor: Actor, period: Period, clientId: number | null, scope: ScopeOptions = {}): SQL {
  return sql`
    visible AS (
      SELECT p.id, p.client_id, p.project_code, p.title, p.status, p.deadline,
             p.price_amount, p.price_currency
      FROM projects p
      JOIN client_months cm ON cm.id = p.client_month_id
      WHERE cm.period_year = ${period.year} AND cm.period_month = ${period.month}
        AND p.status <> 'cancelled'
        AND ${projectScope(actor, 'p', scope)}
        ${clientId === null ? sql`` : sql`AND p.client_id = ${clientId}`}
    ),
    teams AS (
      SELECT pd.id, pd.project_id, pd.department_id, pd.team_lead_id
      FROM project_departments pd
      JOIN visible v ON v.id = pd.project_id
      WHERE true ${leadTeamFilter(actor, 'pd')}
    ),
    slots AS (
      SELECT d.id, d.project_id, t.department_id, d.status,
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
      FROM deliverables d
      JOIN teams t ON t.id = d.project_department_id
      WHERE d.status <> 'cancelled'
    )`;
}

const BUCKET_COLUMNS = sql`
  count(*)::int AS deliverables,
  count(*) FILTER (WHERE s.bucket = 'completed')::int   AS completed,
  count(*) FILTER (WHERE s.bucket = 'ready')::int       AS ready,
  count(*) FILTER (WHERE s.bucket = 'in_qa')::int       AS in_qa,
  count(*) FILTER (WHERE s.bucket = 'in_revision')::int AS in_revision,
  count(*) FILTER (WHERE s.bucket = 'pending')::int     AS pending`;

type BucketRow = {
  deliverables: number; completed: number; ready: number; in_qa: number; in_revision: number; pending: number;
};

function buckets(r: Partial<BucketRow> | undefined): BucketCounts {
  return {
    deliverables: Number(r?.deliverables ?? 0),
    completed: Number(r?.completed ?? 0),
    ready: Number(r?.ready ?? 0),
    inQa: Number(r?.in_qa ?? 0),
    inRevision: Number(r?.in_revision ?? 0),
    pending: Number(r?.pending ?? 0),
  };
}

function orderValue(amount: string | null, currency: string | null): OrderValue {
  return { amount: amount ?? '0.00', currency: normalizeCurrency(currency) };
}

/** Decimal strings summed in integer cents, normalized to USD. */
function sumMoney(values: OrderValue[]): OrderValue {
  const cents = values.reduce(
    (acc, v) => acc + Math.round(convertCurrencyAmount(Number(v.amount), v.currency, 'USD') * 100),
    0,
  );
  return { amount: (cents / 100).toFixed(2), currency: 'USD' };
}

function totalsOf(rows: PortfolioRow[], showPricing: boolean): PortfolioReport['totals'] {
  const sum = (key: keyof BucketCounts | 'projects') => rows.reduce((acc, r) => acc + r[key], 0);
  return {
    projects: sum('projects'),
    deliverables: sum('deliverables'),
    completed: sum('completed'),
    ready: sum('ready'),
    inQa: sum('inQa'),
    inRevision: sum('inRevision'),
    pending: sum('pending'),
    departments: [...new Set(rows.flatMap((r) => r.departments))].sort(),
    value: showPricing ? sumMoney(rows.map((r) => r.value ?? orderValue(null, null))) : null,
  };
}

async function portfolioRows(
  actor: Actor, period: Period, clientId: number | null, showPricing: boolean, scope: ScopeOptions = {},
) {
  const rows = await getDb().execute<BucketRow & {
    client_id: number; client_name: string; projects: number; departments: string[] | null;
    value: string | null; currency: string | null;
  }>(sql`
    WITH ${reportCtes(actor, period, clientId, scope)}
    SELECT c.id AS client_id, c.name AS client_name,
           (SELECT count(*)::int FROM visible v WHERE v.client_id = c.id) AS projects,
           s.*,
           (SELECT array_agg(DISTINCT dep.name ORDER BY dep.name)
              FROM teams t
              JOIN visible v ON v.id = t.project_id
              JOIN departments dep ON dep.id = t.department_id
             WHERE v.client_id = c.id) AS departments,
           ${showPricing
             ? sql`(SELECT COALESCE(sum(CASE WHEN v.price_currency = 'PKR' THEN v.price_amount / ${USD_TO_PKR_RATE} ELSE v.price_amount END), 0)::numeric(14,2)::text FROM visible v WHERE v.client_id = c.id)`
             : sql`NULL::text`} AS value,
           ${showPricing
             ? sql`'USD'::text`
             : sql`NULL::text`} AS currency
    FROM clients c
    JOIN LATERAL (
      SELECT ${BUCKET_COLUMNS}
      FROM slots s JOIN visible v ON v.id = s.project_id
      WHERE v.client_id = c.id
    ) s ON true
    WHERE EXISTS (SELECT 1 FROM visible v WHERE v.client_id = c.id)
    ORDER BY c.name, c.id
  `);

  return rows.map((r): PortfolioRow => ({
    clientId: Number(r.client_id),
    clientName: r.client_name,
    projects: Number(r.projects),
    ...buckets(r),
    departments: r.departments ?? [],
    value: showPricing ? orderValue(r.value, r.currency) : null,
  }));
}

async function departmentRows(
  actor: Actor, period: Period, clientId: number | null, scope: ScopeOptions = {},
): Promise<DepartmentRow[]> {
  const rows = await getDb().execute<BucketRow & { id: number; name: string; projects: number }>(sql`
    WITH ${reportCtes(actor, period, clientId, scope)}
    SELECT dep.id, dep.name,
           (SELECT count(DISTINCT t.project_id)::int FROM teams t WHERE t.department_id = dep.id) AS projects,
           s.*
    FROM departments dep
    JOIN LATERAL (SELECT ${BUCKET_COLUMNS} FROM slots s WHERE s.department_id = dep.id) s ON true
    WHERE EXISTS (SELECT 1 FROM teams t WHERE t.department_id = dep.id)
    ORDER BY dep.sort_order
  `);
  return rows.map((r) => ({
    departmentId: Number(r.id), name: r.name, projects: Number(r.projects), ...buckets(r),
  }));
}

/** One row per client with work filed in the period, a totals row, and the same by team. */
export async function loadPortfolioReport(actor: Actor, period: Period): Promise<PortfolioReport> {
  const showPricing = can(actor, 'pricing.view');
  const [rows, departments] = await Promise.all([
    portfolioRows(actor, period, null, showPricing),
    departmentRows(actor, period, null),
  ]);
  return { period, showPricing, rows, totals: totalsOf(rows, showPricing), departments };
}

/**
 * One client's month: the §39 headline, and what §33 says opening a month
 * shows — projects, every deliverable slot with every version and its QA
 * verdicts, final approved files, revisions, the people involved and
 * delivery dates. Null when the client is not visible, so a guessed id
 * reads the same as a missing one.
 */
export async function loadClientReport(actor: Actor, clientId: number, period: Period): Promise<ClientReport | null> {
  const db = getDb();
  // The month folder is read with the client page's scope (shared: true):
  // what that page lists for a month is what opening the month shows.
  const scope: ScopeOptions = { shared: true };
  const [client] = await db.execute<{ id: number; name: string }>(sql`
    SELECT c.id, c.name FROM clients c WHERE c.id = ${clientId} AND ${clientScope(actor, 'c', scope)}
  `);
  if (!client) return null;

  const showPricing = can(actor, 'pricing.view');
  const ctes = reportCtes(actor, period, clientId, scope);

  const [
    monthRows, headlineRows, departments, projectRows, fileRows, revisionRows, peopleRows, activityRows, commentRows,
    slotRows, versionRows, reviewRows,
  ] = await Promise.all([
    db.execute<{ id: number; status: 'open' | 'closed' }>(sql`
      SELECT cm.id, cm.status FROM client_months cm
      WHERE cm.client_id = ${clientId} AND cm.period_year = ${period.year} AND cm.period_month = ${period.month}
    `),
    portfolioRows(actor, period, clientId, showPricing, scope),
    departmentRows(actor, period, clientId, scope),
    db.execute<{
      id: number; project_code: string; title: string; status: string; deadline: string | null;
      teams: string | null; total: number; approved: number; delivered_on: string | null; comments: number;
      price_amount: string | null; price_currency: string | null;
    }>(sql`
      WITH ${ctes}
      SELECT v.id, v.project_code, v.title, v.status,
             to_char(v.deadline, 'YYYY-MM-DD') AS deadline,
             (SELECT string_agg(dep.name, ', ' ORDER BY dep.sort_order)
                FROM teams t JOIN departments dep ON dep.id = t.department_id
               WHERE t.project_id = v.id) AS teams,
             (SELECT count(*)::int FROM slots s WHERE s.project_id = v.id) AS total,
             (SELECT count(*)::int FROM slots s
               WHERE s.project_id = v.id AND s.status IN ('approved','delivered')) AS approved,
             (SELECT to_char(max(dl.delivered_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD')
                FROM deliveries dl JOIN slots s ON s.id = dl.deliverable_id
               WHERE dl.project_id = v.id) AS delivered_on,
             -- A comment hangs off the project, a slot, an assignment, a
             -- revision or a file version (lib/workspace/comments); all of
             -- them are the project's.
             (SELECT count(*)::int FROM comments c
                LEFT JOIN deliverables cd ON cd.id = c.deliverable_id
                LEFT JOIN assignments  ca ON ca.id = c.assignment_id
                LEFT JOIN revisions    cr ON cr.id = c.revision_id
                LEFT JOIN deliverable_versions cv ON cv.id = c.version_id
                LEFT JOIN deliverables cvd        ON cvd.id = cv.deliverable_id
               WHERE COALESCE(c.project_id, cd.project_id, ca.project_id, cr.project_id, cvd.project_id) = v.id) AS comments,
             ${showPricing ? sql`v.price_amount::text` : sql`NULL::text`} AS price_amount,
             ${showPricing ? sql`v.price_currency::text` : sql`NULL::text`} AS price_currency
      FROM visible v
      ORDER BY v.project_code
    `),
    // The current version of every approved or delivered slot: what the
    // client has, or is about to get. Deleted files are not offered.
    db.execute<{
      deliverable_id: number; deliverable_name: string; project_id: number; project_code: string;
      department: string; version_no: number; status: 'approved' | 'delivered';
      original_filename: string; size_bytes: string; storage_key: string; delivered_on: string | null;
    }>(sql`
      WITH ${ctes}
      SELECT d.id AS deliverable_id, d.name AS deliverable_name, v.id AS project_id, v.project_code,
             dep.name AS department, ver.version_no, d.status,
             f.original_filename, f.size_bytes::text AS size_bytes, f.storage_key::text AS storage_key,
             (SELECT to_char(max(dl.delivered_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD')
                FROM deliveries dl WHERE dl.deliverable_version_id = ver.id) AS delivered_on
      FROM slots s
      JOIN deliverables d          ON d.id = s.id
      JOIN visible v               ON v.id = s.project_id
      JOIN departments dep         ON dep.id = s.department_id
      JOIN deliverable_versions ver ON ver.deliverable_id = d.id AND ver.is_current
      JOIN files f                 ON f.id = ver.file_id AND f.deleted_at IS NULL
      WHERE d.status IN ('approved','delivered')
      ORDER BY v.project_code, dep.sort_order, d.sequence_no
    `),
    // The month's revisions — every round the client asked for on this
    // month's projects, open or closed.
    db.execute<{
      id: number; project_id: number; project_code: string; revision_no: number; title: string;
      status: string; opened_on: string; closed_on: string | null; deliverables: number; can_open: boolean;
    }>(sql`
      WITH ${ctes}
      SELECT r.id, v.id AS project_id, v.project_code, r.revision_no, r.title, r.status,
             to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS opened_on,
             to_char(r.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS closed_on,
             (SELECT count(*)::int FROM revision_deliverables rd WHERE rd.revision_id = r.id) AS deliverables,
             -- The rule /revisions/[id] applies (loadRevision, no history):
             -- the archive links only what would open.
             ${revisionScope(actor, 'r', scope)} AS can_open
      FROM revisions r
      JOIN visible v ON v.id = r.project_id
      -- The month archive is history (§33): an Executive reads every revision
      -- on a project of theirs here, not only those on their current work.
      WHERE ${revisionScope(actor, 'r', { ...scope, history: true })}
      ORDER BY r.created_at, r.id
    `),
    db.execute<{ user_id: number; full_name: string; department: string; is_lead: boolean; slots: number }>(sql`
      WITH ${ctes},
      people AS (
        SELECT t.team_lead_id AS user_id, t.department_id, true AS is_lead, 0 AS slots
        FROM teams t WHERE t.team_lead_id IS NOT NULL
        UNION ALL
        SELECT a.assignee_id, t.department_id, false,
               (SELECT count(*)::int FROM slots s JOIN deliverables d ON d.id = s.id
                 WHERE d.assignment_id = a.id)
        FROM assignments a
        JOIN teams t ON t.id = a.project_department_id
        WHERE a.status <> 'cancelled'
      )
      SELECT u.id AS user_id, u.full_name, dep.name AS department,
             bool_or(pp.is_lead) AS is_lead, sum(pp.slots)::int AS slots
      FROM people pp
      JOIN users u         ON u.id = pp.user_id
      JOIN departments dep ON dep.id = pp.department_id
      GROUP BY u.id, u.full_name, dep.id, dep.name, dep.sort_order
      ORDER BY dep.sort_order, bool_or(pp.is_lead) DESC, u.full_name
    `),
    // The month's complete activity (§36): the feed of every visible
    // project, plus the month's own lines — opened, closed, reopened,
    // copied into — which hang off the client_month row.
    db.execute<ActivityRow>(sql`
      WITH ${ctes}
      SELECT al.id,
             to_char(al.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
             u.full_name AS actor_name, al.action, al.metadata
      FROM activity_log al
      LEFT JOIN users u ON u.id = al.actor_id
      WHERE (al.project_id IN (SELECT v.id FROM visible v)
             AND al.action IN (${sql.join(FEED_ACTIONS.map((a) => sql`${a}`), sql`, `)}))
         OR (al.entity_type = 'client_month' AND al.client_id = ${clientId}
             AND al.entity_id = (SELECT cm.id FROM client_months cm
                                  WHERE cm.client_id = ${clientId}
                                    AND cm.period_year = ${period.year} AND cm.period_month = ${period.month}))
      ORDER BY al.created_at, al.id
      LIMIT 1000
    `),
    // The month's comments (§33): wherever one hangs — project, slot,
    // assignment, revision or file version — it belongs to a visible
    // project. A revision thread is additionally held to revisionScope,
    // like the revision itself.
    db.execute<{
      id: number; author: string; body: string; at: string; project_id: number; project_code: string; about: string;
    }>(sql`
      WITH ${ctes}
      SELECT c.id, u.full_name AS author, c.body,
             to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
             v.id AS project_id, v.project_code,
             CASE
               WHEN cv.id IS NOT NULL THEN cvd.name || ' v' || cv.version_no
               WHEN cr.id IS NOT NULL THEN 'Revision #' || lpad(cr.revision_no::text, 2, '0')
               WHEN cd.id IS NOT NULL THEN cd.name
               WHEN ca.id IS NOT NULL THEN ca.title
               ELSE 'project'
             END AS about
      FROM comments c
      JOIN users u ON u.id = c.author_id
      LEFT JOIN deliverables cd ON cd.id = c.deliverable_id
      LEFT JOIN assignments  ca ON ca.id = c.assignment_id
      LEFT JOIN revisions    cr ON cr.id = c.revision_id
      LEFT JOIN deliverable_versions cv ON cv.id = c.version_id
      LEFT JOIN deliverables cvd        ON cvd.id = cv.deliverable_id
      JOIN visible v ON v.id = COALESCE(c.project_id, cd.project_id, ca.project_id, cr.project_id, cvd.project_id)
      WHERE cr.id IS NULL OR ${revisionScope(actor, 'cr', { ...scope, history: true })}
      ORDER BY c.created_at, c.id
      LIMIT 500
    `),
    // §33, the archive proper: every slot of the month's projects, whatever
    // its state. Read through the `slots` CTE so a lead sees their teams'
    // slots only and cancelled slots stay out, exactly as the counts do.
    db.execute<{
      id: number; project_id: number; project_code: string; department: string; sequence_no: number;
      name: string; status: string; due_date: string | null; assignee: string | null;
    }>(sql`
      WITH ${ctes}
      SELECT d.id, v.id AS project_id, v.project_code, dep.name AS department,
             d.sequence_no, d.name, d.status,
             to_char(d.due_date, 'YYYY-MM-DD') AS due_date,
             u.full_name AS assignee
      FROM slots s
      JOIN deliverables d     ON d.id = s.id
      JOIN visible v          ON v.id = s.project_id
      JOIN departments dep    ON dep.id = s.department_id
      LEFT JOIN assignments a ON a.id = d.assignment_id
      LEFT JOIN users u       ON u.id = a.assignee_id
      ORDER BY v.project_code, dep.sort_order, d.sequence_no
    `),
    // Every version ever uploaded to those slots, superseded ones included.
    // Unlike the Final files block this does not drop deleted files: the
    // archive keeps the row and withholds the link (see the mapping below).
    db.execute<{
      id: number; deliverable_id: number; version_no: number; notes: string | null;
      original_filename: string; size_bytes: string; storage_key: string; deleted: boolean;
      uploaded_by: string; uploaded_at: string; revision_no: number | null;
    }>(sql`
      WITH ${ctes}
      SELECT ver.id, ver.deliverable_id, ver.version_no, ver.notes,
             f.original_filename, f.size_bytes::text AS size_bytes, f.storage_key::text AS storage_key,
             (f.deleted_at IS NOT NULL) AS deleted,
             u.full_name AS uploaded_by,
             to_char(ver.uploaded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS uploaded_at,
             r.revision_no
      FROM deliverable_versions ver
      JOIN slots s          ON s.id = ver.deliverable_id
      JOIN files f          ON f.id = ver.file_id
      JOIN users u          ON u.id = ver.uploaded_by
      LEFT JOIN revisions r ON r.id = ver.revision_id
      ORDER BY ver.deliverable_id, ver.version_no
    `),
    // Every QA decision on those versions, newest first (as the workspace
    // lists them, lib/workspace/workspace).
    db.execute<{
      version_id: number; stage: ReportReview['stage']; decision: ReportReview['decision'];
      comments: string | null; reviewer: string; reviewed_at: string;
    }>(sql`
      WITH ${ctes}
      SELECT ver.id AS version_id, q.stage, q.decision, q.comments, ru.full_name AS reviewer,
             to_char(q.reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS reviewed_at
      FROM qa_reviews q
      JOIN deliverable_versions ver ON ver.id = q.deliverable_version_id
      JOIN slots s                  ON s.id = ver.deliverable_id
      JOIN users ru                 ON ru.id = q.reviewer_id
      ORDER BY q.reviewed_at DESC, q.id DESC
    `),
  ]);

  const reviewsByVersion = new Map<number, ReportReview[]>();
  for (const r of reviewRows) {
    const list = reviewsByVersion.get(Number(r.version_id)) ?? [];
    list.push({ stage: r.stage, decision: r.decision, reviewer: r.reviewer, reviewedAt: r.reviewed_at, comments: r.comments });
    reviewsByVersion.set(Number(r.version_id), list);
  }

  // Whether a version's file may be offered is decideFileAccess's rule
  // (lib/files/access), applied here without a query per file. Its project
  // half for a read is isProjectVisible(…, { shared: true }) — the very
  // predicate the `visible` CTE already filtered on — and a deliverable
  // version is never orphaned, so the one rule left is the deleted file:
  // withheld unless the reader may delete files. The page renders a link
  // only where this is non-null, so it never offers what the route refuses.
  const mayOpenDeleted = can(actor, 'files.delete');
  const versionsBySlot = new Map<number, ReportVersion[]>();
  for (const r of versionRows) {
    const reviews = reviewsByVersion.get(Number(r.id)) ?? [];
    const isDeleted = r.deleted === true;
    const list = versionsBySlot.get(Number(r.deliverable_id)) ?? [];
    list.push({
      id: Number(r.id),
      versionNo: Number(r.version_no),
      originalFilename: r.original_filename,
      sizeBytes: Number(r.size_bytes),
      uploadedBy: r.uploaded_by,
      uploadedAt: r.uploaded_at,
      notes: r.notes,
      revisionNo: r.revision_no === null ? null : Number(r.revision_no),
      qaStatus: reviews[0]?.decision ?? 'pending',
      reviews,
      isDeleted,
      downloadUrl: isDeleted && !mayOpenDeleted ? null : `/api/files/${r.storage_key}`,
    });
    versionsBySlot.set(Number(r.deliverable_id), list);
  }

  const headline = headlineRows[0];
  const month = monthRows[0];
  return {
    client: { id: Number(client.id), name: client.name },
    period,
    month: month ? { id: Number(month.id), status: month.status } : null,
    showPricing,
    canDownload: can(actor, 'files.download'),
    headline: headline
      ? {
          projects: headline.projects, deliverables: headline.deliverables, completed: headline.completed,
          ready: headline.ready, inQa: headline.inQa, inRevision: headline.inRevision, pending: headline.pending,
          departments: headline.departments, value: headline.value,
        }
      : totalsOf([], showPricing),
    departments,
    projects: projectRows.map((r) => ({
      id: Number(r.id),
      projectCode: r.project_code,
      title: r.title,
      status: r.status,
      teams: r.teams,
      approved: Number(r.approved),
      total: Number(r.total),
      deadline: r.deadline,
      deliveredOn: r.delivered_on,
      comments: Number(r.comments),
      value: showPricing ? orderValue(r.price_amount, r.price_currency) : null,
    })),
    deliverables: slotRows.map((r) => ({
      id: Number(r.id),
      projectId: Number(r.project_id),
      projectCode: r.project_code,
      department: r.department,
      sequenceNo: Number(r.sequence_no),
      name: r.name,
      status: r.status,
      dueDate: r.due_date,
      assignee: r.assignee,
      versions: versionsBySlot.get(Number(r.id)) ?? [],
    })),
    files: fileRows.map((r) => ({
      deliverableId: Number(r.deliverable_id),
      deliverableName: r.deliverable_name,
      projectId: Number(r.project_id),
      projectCode: r.project_code,
      department: r.department,
      versionNo: Number(r.version_no),
      status: r.status,
      originalFilename: r.original_filename,
      sizeBytes: Number(r.size_bytes),
      deliveredOn: r.delivered_on,
      downloadUrl: `/api/files/${r.storage_key}`,
    })),
    comments: commentRows.map((r) => ({
      id: Number(r.id), author: r.author, body: r.body, at: r.at,
      projectId: Number(r.project_id), projectCode: r.project_code, about: r.about,
    })),
    revisions: revisionRows.map((r) => ({
      id: Number(r.id),
      projectId: Number(r.project_id),
      projectCode: r.project_code,
      revisionNo: Number(r.revision_no),
      title: r.title,
      status: r.status,
      openedOn: r.opened_on,
      closedOn: r.closed_on,
      deliverables: Number(r.deliverables),
      canOpen: r.can_open === true,
    })),
    people: peopleRows.map((r) => ({
      userId: Number(r.user_id),
      fullName: r.full_name,
      department: r.department,
      isLead: r.is_lead === true,
      slots: Number(r.slots),
    })),
    activity: toActivityLines(activityRows, { showPricing }),
  };
}
