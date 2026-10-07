import 'server-only';
import { sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { can, clientScope, projectScope, revisionScope } from '@/lib/authz';
import { parseMonthValue } from '@/lib/projects/intake';
import { OPEN_REVISION_STATUSES } from '@/lib/revisions/status';

/**
 * The statuses offered as a filter. `approved` is in the enum but never a
 * stage the portal sets: a file that clears its final QA is queued for Sales
 * in the same transaction, so Approved and Ready for Delivery are one moment
 * (qa/project-status). `qa` is derived from the slots and stays.
 */
export const PROJECT_STATUSES = [
  'new', 'awaiting_assignment', 'planned', 'in_progress', 'qa', 'revision_required',
  'ready_for_delivery', 'delivered', 'completed', 'on_hold', 'cancelled',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const DELIVERY_STATUSES = [
  'pending_delivery', 'delivered', 'client_feedback_received', 'revision_required', 'completed',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Everything brief §22 says a person can search or filter by. */
export interface SearchFilters {
  /**
   * Free text: project name, code, client, team lead, executive, deliverable,
   * file, revision — or a revision's number as the portal prints it (§15):
   * "#03", "rev 3", "Revision #03".
   */
  q?: string | null;
  status?: ProjectStatus[];
  departmentId?: number | null;
  teamLeadId?: number | null;
  executiveId?: number | null;
  clientId?: number | null;
  /** Matches a project whose most recent delivery on any slot has this status. */
  deliveryStatus?: DeliveryStatus | null;
  openRevisions?: boolean;
  /** YYYY-MM: the client month the project belongs to. */
  period?: string | null;
  deadlineFrom?: string | null;
  deadlineTo?: string | null;
  /** YYYY-MM-DD, inclusive: when the project was filed (projects.created_at). */
  createdFrom?: string | null;
  createdTo?: string | null;
  /**
   * YYYY-MM-DD, inclusive: a project any of whose deliveries was marked
   * delivered in the range (deliveries.delivered_at, set by Sales or the
   * client portal). The delivery may have moved on since — feedback,
   * revision, completed — it was still delivered then.
   */
  deliveredFrom?: string | null;
  deliveredTo?: string | null;
}

export type MatchedOn = 'code' | 'title' | 'client' | 'team_lead' | 'executive' | 'deliverable' | 'file' | 'revision';

export interface SearchHit {
  id: number;
  projectCode: string;
  title: string;
  status: string;
  priority: string;
  deadline: string | null;
  clientId: number;
  clientName: string;
  year: number;
  month: number;
  teams: string[];
  teamLeads: string[];
  executives: string[];
  total: number;
  approved: number;
  latestDeliveryStatus: string | null;
  openRevisions: number;
  /** Which fields the free text hit, so the row can say why it is here. */
  matchedOn: MatchedOn[];
}

const MAX_RESULTS = 200;

function isBlank(value: string | null | undefined): value is null | undefined {
  return value === null || value === undefined || value.trim() === '';
}

function isoDate(value: string | null | undefined): string | null {
  if (isBlank(value) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  // A shape-valid but impossible date (2026-02-30) would otherwise make
  // `::date` throw; like a bad month, it is dropped instead.
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : null;
}

/**
 * `col` on or after `from` and before the day after `to`: whole calendar
 * days in the database's time zone, for a timestamptz column.
 */
function dayRange(col: SQL, from: string | null, to: string | null): SQL[] {
  const out: SQL[] = [];
  if (from) out.push(sql`${col} >= ${from}::date`);
  if (to) out.push(sql`${col} < ${to}::date + 1`);
  return out;
}

/**
 * The whole text read as a revision reference — "#03", "#3", "rev 3",
 * "Revision #03" — the way the portal labels a revision (§15). Only the
 * whole text counts: revisions are numbered per project, so every project
 * with a revision has a #01, and a bare "1" or "Video 01" is a code or a
 * deliverable, not a revision.
 */
const REVISION_REF = /^(?:rev(?:ision)?\.?\s*#?\s*|#\s*)0*(\d{1,4})$/i;

function revisionRef(q: string): number | null {
  const m = REVISION_REF.exec(q);
  return m ? Number(m[1]) : null;
}

/** `status IN (…)` over the statuses in which a revision is still open. */
const openRevision = sql.join(OPEN_REVISION_STATUSES.map((s) => sql`${s}::revision_status`), sql`, `);

/**
 * Global search (brief §22). One query, always composed with `projectScope`,
 * so a person finds only what they could open anyway — an Executive cannot
 * discover a project by guessing a colleague's name. A project shared with
 * a Sales rep to view (§23) is found like their own. Revisions — the text
 * match, the number, the "has an open revision" filter and the count on the
 * row — are additionally gated by `revisionScope`, so the Design lead does
 * not find, or learn of, the video project's revision through the client's
 * note about the video.
 *
 * Free text is matched as a substring, case-insensitively, across the
 * fields the brief lists; the trigram indexes on titles and client names
 * carry the `ILIKE`. The result says which field matched.
 */
export async function searchProjects(actor: Actor, filters: SearchFilters): Promise<SearchHit[]> {
  if (!actor.isActive) return [];
  const where: SQL[] = [projectScope(actor, 'p', { shared: true })];

  const q = isBlank(filters.q) ? null : filters.q.trim().slice(0, 200);
  const pattern = q === null ? null : `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const revisionNo = q === null ? null : revisionRef(q);

  // Each candidate field is a boolean column in the SELECT, so the row can
  // report why it matched; the WHERE is simply "any of them".
  const matchCode = pattern === null ? sql`false` : sql`p.project_code ILIKE ${pattern}`;
  const matchTitle = pattern === null ? sql`false` : sql`p.title ILIKE ${pattern}`;
  const matchClient = pattern === null ? sql`false` : sql`c.name ILIKE ${pattern} OR c.company_name ILIKE ${pattern}`;
  const matchLead = pattern === null ? sql`false` : sql`EXISTS (
    SELECT 1 FROM project_departments mpd JOIN users mu ON mu.id = mpd.team_lead_id
    WHERE mpd.project_id = p.id AND mu.full_name ILIKE ${pattern})`;
  const matchExecutive = pattern === null ? sql`false` : sql`EXISTS (
    SELECT 1 FROM assignments ma JOIN users mu ON mu.id = ma.assignee_id
    WHERE ma.project_id = p.id AND mu.full_name ILIKE ${pattern})`;
  const matchDeliverable = pattern === null ? sql`false` : sql`EXISTS (
    SELECT 1 FROM deliverables md WHERE md.project_id = p.id AND md.name ILIKE ${pattern})`;
  const matchFile = pattern === null ? sql`false` : sql`EXISTS (
    SELECT 1 FROM deliverables md
    JOIN deliverable_versions mv ON mv.deliverable_id = md.id
    JOIN files mf ON mf.id = mv.file_id
    WHERE md.project_id = p.id AND mf.deleted_at IS NULL AND mf.original_filename ILIKE ${pattern})`;
  const matchRevision = pattern === null ? sql`false` : sql`EXISTS (
    SELECT 1 FROM revisions mr
    WHERE mr.project_id = p.id AND ${revisionScope(actor, 'mr', { shared: true })}
      AND (mr.title ILIKE ${pattern} OR mr.client_feedback ILIKE ${pattern}
           ${revisionNo === null ? sql`` : sql`OR mr.revision_no = ${revisionNo}`}))`;

  if (pattern !== null) {
    where.push(sql`(${matchCode} OR ${matchTitle} OR ${matchClient} OR ${matchLead} OR ${matchExecutive}
                    OR ${matchDeliverable} OR ${matchFile} OR ${matchRevision})`);
  }

  const statuses = (filters.status ?? []).filter((s): s is ProjectStatus => PROJECT_STATUSES.includes(s));
  if (statuses.length > 0) {
    where.push(sql`p.status IN (${sql.join(statuses.map((s) => sql`${s}::project_status`), sql`, `)})`);
  }
  if (filters.departmentId) {
    where.push(sql`EXISTS (SELECT 1 FROM project_departments fpd
      WHERE fpd.project_id = p.id AND fpd.department_id = ${filters.departmentId})`);
  }
  if (filters.teamLeadId) {
    where.push(sql`EXISTS (SELECT 1 FROM project_departments fpd
      WHERE fpd.project_id = p.id AND fpd.team_lead_id = ${filters.teamLeadId})`);
  }
  if (filters.executiveId) {
    where.push(sql`EXISTS (SELECT 1 FROM assignments fa
      WHERE fa.project_id = p.id AND fa.assignee_id = ${filters.executiveId})`);
  }
  if (filters.clientId) where.push(sql`p.client_id = ${filters.clientId}`);
  if (filters.deliveryStatus && DELIVERY_STATUSES.includes(filters.deliveryStatus)) {
    where.push(sql`EXISTS (
      SELECT 1 FROM deliveries fdl
      WHERE fdl.project_id = p.id AND fdl.status = ${filters.deliveryStatus}::delivery_status
        AND fdl.id = (SELECT max(id) FROM deliveries WHERE deliverable_id = fdl.deliverable_id))`);
  }
  if (filters.openRevisions) {
    where.push(sql`EXISTS (SELECT 1 FROM revisions fr WHERE fr.project_id = p.id
      AND fr.status IN (${openRevision}) AND ${revisionScope(actor, 'fr', { shared: true })})`);
  }
  const period = isBlank(filters.period) ? null : parseMonthValue(filters.period);
  if (period) {
    where.push(sql`cm.period_year = ${period.year} AND cm.period_month = ${period.month}`);
  }
  const from = isoDate(filters.deadlineFrom);
  const to = isoDate(filters.deadlineTo);
  if (from) where.push(sql`p.deadline >= ${from}::date`);
  if (to) where.push(sql`p.deadline <= ${to}::date`);
  where.push(...dayRange(sql`p.created_at`, isoDate(filters.createdFrom), isoDate(filters.createdTo)));
  // Any delivery on the project marked delivered in the range counts — not
  // only the latest per slot, and whatever its status is now.
  const delivered = dayRange(sql`fdd.delivered_at`, isoDate(filters.deliveredFrom), isoDate(filters.deliveredTo));
  if (delivered.length > 0) {
    where.push(sql`EXISTS (SELECT 1 FROM deliveries fdd
      WHERE fdd.project_id = p.id AND fdd.delivered_at IS NOT NULL AND ${sql.join(delivered, sql` AND `)})`);
  }

  const rows = await getDb().execute<{
    id: number; project_code: string; title: string; status: string; priority: string;
    deadline: string | null; client_id: number; client_name: string;
    period_year: number; period_month: number;
    teams: string[] | null; team_leads: string[] | null; executives: string[] | null;
    total: number; approved: number; latest_delivery: string | null; open_revisions: number;
    m_code: boolean; m_title: boolean; m_client: boolean; m_lead: boolean; m_executive: boolean;
    m_deliverable: boolean; m_file: boolean; m_revision: boolean;
  }>(sql`
    SELECT p.id, p.project_code, p.title, p.status, p.priority,
           to_char(p.deadline, 'YYYY-MM-DD') AS deadline,
           p.client_id, c.name AS client_name, cm.period_year, cm.period_month,
           (SELECT array_agg(d.name ORDER BY d.sort_order)
              FROM project_departments pd JOIN departments d ON d.id = pd.department_id
             WHERE pd.project_id = p.id) AS teams,
           (SELECT array_agg(DISTINCT u.full_name)
              FROM project_departments pd JOIN users u ON u.id = pd.team_lead_id
             WHERE pd.project_id = p.id) AS team_leads,
           (SELECT array_agg(DISTINCT u.full_name)
              FROM assignments a JOIN users u ON u.id = a.assignee_id
             WHERE a.project_id = p.id) AS executives,
           prog.total, prog.approved,
           (SELECT dl.status::text FROM deliveries dl
             WHERE dl.project_id = p.id ORDER BY dl.updated_at DESC, dl.id DESC LIMIT 1) AS latest_delivery,
           (SELECT count(*)::int FROM revisions r WHERE r.project_id = p.id
              AND r.status IN (${openRevision}) AND ${revisionScope(actor, 'r', { shared: true })}) AS open_revisions,
           (${matchCode}) AS m_code, (${matchTitle}) AS m_title, (${matchClient}) AS m_client,
           (${matchLead}) AS m_lead, (${matchExecutive}) AS m_executive,
           (${matchDeliverable}) AS m_deliverable, (${matchFile}) AS m_file, (${matchRevision}) AS m_revision
    FROM projects p
    JOIN clients c        ON c.id = p.client_id
    JOIN client_months cm ON cm.id = p.client_month_id
    JOIN v_project_progress prog ON prog.project_id = p.id
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY ${pattern === null ? sql`p.created_at DESC` : sql`m_code DESC, m_title DESC, p.created_at DESC`}
    LIMIT ${MAX_RESULTS}
  `);

  return rows.map((r) => {
    const matchedOn: MatchedOn[] = [];
    if (r.m_code) matchedOn.push('code');
    if (r.m_title) matchedOn.push('title');
    if (r.m_client) matchedOn.push('client');
    if (r.m_lead) matchedOn.push('team_lead');
    if (r.m_executive) matchedOn.push('executive');
    if (r.m_deliverable) matchedOn.push('deliverable');
    if (r.m_file) matchedOn.push('file');
    if (r.m_revision) matchedOn.push('revision');
    return {
      id: Number(r.id),
      projectCode: r.project_code,
      title: r.title,
      status: r.status,
      priority: r.priority,
      deadline: r.deadline,
      clientId: Number(r.client_id),
      clientName: r.client_name,
      year: Number(r.period_year),
      month: Number(r.period_month),
      teams: r.teams ?? [],
      teamLeads: r.team_leads ?? [],
      executives: r.executives ?? [],
      total: Number(r.total),
      approved: Number(r.approved),
      latestDeliveryStatus: r.latest_delivery,
      openRevisions: Number(r.open_revisions),
      matchedOn,
    };
  });
}

export interface ClientHit {
  id: number;
  name: string;
  companyName: string | null;
  status: string;
  activeProjects: number;
  totalProjects: number;
}

/**
 * Clients by name or company (brief §48). Project search finds a client
 * only through its projects, so a client just signed — no month, no order
 * yet — would be invisible. This looks at the client record itself, under
 * the same `clientScope` as the client list: a rep sees their own book, a
 * lead or executive the clients they have worked for.
 */
export async function searchClients(actor: Actor, q: string | null | undefined): Promise<ClientHit[]> {
  if (!actor.isActive || isBlank(q)) return [];
  const text = q!.trim().slice(0, 200);
  const pattern = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await getDb().execute<{
    id: number; name: string; company_name: string | null; status: string;
    active_projects: number; total_projects: number;
  }>(sql`
    SELECT c.id, c.name, c.company_name, c.status,
           (SELECT count(*) FROM projects p WHERE p.client_id = c.id
              AND p.status NOT IN ('completed','cancelled'))::int AS active_projects,
           (SELECT count(*) FROM projects p WHERE p.client_id = c.id)::int AS total_projects
    FROM clients c
    WHERE ${clientScope(actor, 'c', { shared: true })}
      AND (c.name ILIKE ${pattern} OR c.company_name ILIKE ${pattern})
    ORDER BY c.name
    LIMIT 20
  `);
  return rows.map((r) => ({
    id: Number(r.id), name: r.name, companyName: r.company_name, status: r.status,
    activeProjects: Number(r.active_projects), totalProjects: Number(r.total_projects),
  }));
}

export interface SearchOptions {
  departments: { id: number; name: string }[];
  teamLeads: { id: number; name: string }[];
  executives: { id: number; name: string }[];
  clients: { id: number; name: string }[];
  /** True when the actor can choose a team lead or executive at all. */
  canFilterByPeople: boolean;
}

/**
 * Which department members (`users u`, `department_members dm`) the actor
 * may pick from, or `null` for a role that does not browse staff (§23).
 * Management and the PM see every active member; a Team Lead the members of
 * the departments they lead; a Sales rep whoever leads a team or holds an
 * assignment on a project they can see, shared ones included — so a name in
 * the list is never one they could learn nothing else about.
 */
function peopleInReach(actor: Actor): SQL | null {
  if (can(actor, 'planning.viewAllDepartments') || can(actor, 'projects.viewAll')) return sql`true`;
  if (actor.leadDepartmentIds.length > 0) {
    return sql`dm.department_id IN (${sql.join(actor.leadDepartmentIds.map((d) => sql`${d}`), sql`, `)})`;
  }
  if (actor.role === 'sales') {
    return sql`EXISTS (
      SELECT 1 FROM projects sp
      WHERE ${projectScope(actor, 'sp', { shared: true })}
        AND (EXISTS (SELECT 1 FROM project_departments spd
                     WHERE spd.project_id = sp.id AND spd.team_lead_id = u.id)
          OR EXISTS (SELECT 1 FROM assignments sa
                     WHERE sa.project_id = sp.id AND sa.assignee_id = u.id)))`;
  }
  return null;
}

/**
 * The choices offered in the filter bar. People are offered only to those
 * who plan or sell across a team (brief §6, §23), and only the people in
 * their reach (`peopleInReach`): an Executive filters their own projects by
 * status and date, not by colleague.
 */
export async function searchOptions(actor: Actor): Promise<SearchOptions> {
  const db = getDb();
  const people = peopleInReach(actor);

  const [departments, clients, members] = await Promise.all([
    db.execute<{ id: number; name: string }>(sql`
      SELECT id, name FROM departments WHERE is_production AND is_active ORDER BY sort_order`),
    db.execute<{ id: number; name: string }>(sql`
      SELECT c.id, c.name FROM clients c WHERE ${clientScope(actor, 'c', { shared: true })} ORDER BY c.name`),
    people !== null
      ? db.execute<{ id: number; name: string; is_lead: boolean }>(sql`
          SELECT u.id, u.full_name AS name, bool_or(dm.is_lead) AS is_lead
          FROM users u JOIN department_members dm ON dm.user_id = u.id
          WHERE u.is_active AND ${people}
          GROUP BY u.id, u.full_name ORDER BY u.full_name`)
      : Promise.resolve([] as { id: number; name: string; is_lead: boolean }[]),
  ]);

  return {
    departments: departments.map((d) => ({ id: Number(d.id), name: d.name })),
    clients: clients.map((c) => ({ id: Number(c.id), name: c.name })),
    teamLeads: members.filter((p) => p.is_lead).map((p) => ({ id: Number(p.id), name: p.name })),
    executives: members.filter((p) => !p.is_lead).map((p) => ({ id: Number(p.id), name: p.name })),
    canFilterByPeople: people !== null,
  };
}

type Params = Record<string, string | string[] | undefined>;

const one = (params: Params, key: string): string | null => {
  const v = params[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined || s.trim() === '' ? null : s.trim();
};
const many = (params: Params, key: string): string[] => {
  const v = params[key];
  return (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((s) => s.trim() !== '');
};
const id = (params: Params, key: string): number | null => {
  const n = Number(one(params, key));
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Query string → filters. Unknown values are dropped, never errors. */
export function parseSearchParams(params: Params): SearchFilters {
  const deliveryStatus = one(params, 'delivery');
  return {
    q: one(params, 'q'),
    status: many(params, 'status').filter((s): s is ProjectStatus => PROJECT_STATUSES.includes(s as ProjectStatus)),
    departmentId: id(params, 'team'),
    teamLeadId: id(params, 'lead'),
    executiveId: id(params, 'executive'),
    clientId: id(params, 'client'),
    deliveryStatus: DELIVERY_STATUSES.includes(deliveryStatus as DeliveryStatus)
      ? (deliveryStatus as DeliveryStatus) : null,
    openRevisions: one(params, 'revisions') === 'open',
    period: one(params, 'period'),
    deadlineFrom: one(params, 'from'),
    deadlineTo: one(params, 'to'),
    createdFrom: one(params, 'created_from'),
    createdTo: one(params, 'created_to'),
    deliveredFrom: one(params, 'delivered_from'),
    deliveredTo: one(params, 'delivered_to'),
  };
}

/** True when any filter or text is set — an empty search lists everything visible. */
export function hasAnyFilter(f: SearchFilters): boolean {
  return !isBlank(f.q) || (f.status?.length ?? 0) > 0 || !!f.departmentId || !!f.teamLeadId
    || !!f.executiveId || !!f.clientId || !!f.deliveryStatus || !!f.openRevisions
    || !isBlank(f.period) || !isBlank(f.deadlineFrom) || !isBlank(f.deadlineTo)
    || !isBlank(f.createdFrom) || !isBlank(f.createdTo) || !isBlank(f.deliveredFrom) || !isBlank(f.deliveredTo);
}
