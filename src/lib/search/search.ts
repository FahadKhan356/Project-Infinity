import 'server-only';
import { sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { can, clientScope, projectScope, revisionScope } from '@/lib/authz';
import { parseMonthValue } from '@/lib/projects/intake';

export const PROJECT_STATUSES = [
  'new', 'awaiting_assignment', 'planned', 'in_progress', 'qa', 'revision_required', 'approved',
  'ready_for_delivery', 'delivered', 'completed', 'on_hold', 'cancelled',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const DELIVERY_STATUSES = [
  'pending_delivery', 'delivered', 'client_feedback_received', 'revision_required', 'completed',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Everything brief §22 says a person can search or filter by. */
export interface SearchFilters {
  /** Free text: project name, code, client, team lead, executive, deliverable, file, revision. */
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
  return !isBlank(value) && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/**
 * Global search (brief §22). One query, always composed with `projectScope`,
 * so a person finds only what they could open anyway — an Executive cannot
 * discover a project by guessing a colleague's name. Revision text is
 * additionally gated by `revisionScope`, so the Design lead does not find
 * the video project through the client's note about the video.
 *
 * Free text is matched as a substring, case-insensitively, across the
 * fields the brief lists; the trigram indexes on titles and client names
 * carry the `ILIKE`. The result says which field matched.
 */
export async function searchProjects(actor: Actor, filters: SearchFilters): Promise<SearchHit[]> {
  if (!actor.isActive) return [];
  const where: SQL[] = [projectScope(actor, 'p')];

  const q = isBlank(filters.q) ? null : filters.q.trim().slice(0, 200);
  const pattern = q === null ? null : `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

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
    WHERE mr.project_id = p.id AND ${revisionScope(actor, 'mr')}
      AND (mr.title ILIKE ${pattern} OR mr.client_feedback ILIKE ${pattern}))`;

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
      AND fr.status IN ('new','assigned','in_progress','awaiting_qa'))`);
  }
  const period = isBlank(filters.period) ? null : parseMonthValue(filters.period);
  if (period) {
    where.push(sql`cm.period_year = ${period.year} AND cm.period_month = ${period.month}`);
  }
  const from = isoDate(filters.deadlineFrom);
  const to = isoDate(filters.deadlineTo);
  if (from) where.push(sql`p.deadline >= ${from}::date`);
  if (to) where.push(sql`p.deadline <= ${to}::date`);

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
              AND r.status IN ('new','assigned','in_progress','awaiting_qa')) AS open_revisions,
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

export interface SearchOptions {
  departments: { id: number; name: string }[];
  teamLeads: { id: number; name: string }[];
  executives: { id: number; name: string }[];
  clients: { id: number; name: string }[];
  /** True when the actor can choose a team lead or executive at all. */
  canFilterByPeople: boolean;
}

/**
 * The choices offered in the filter bar. People are offered only to those
 * who see across teams (brief §6, §23): an Executive filters their own
 * projects by status and date, not by colleague.
 */
export async function searchOptions(actor: Actor): Promise<SearchOptions> {
  const db = getDb();
  const canFilterByPeople =
    can(actor, 'planning.viewAllDepartments') || can(actor, 'projects.viewAll')
    || actor.leadDepartmentIds.length > 0 || actor.role === 'sales';

  const [departments, clients, people] = await Promise.all([
    db.execute<{ id: number; name: string }>(sql`
      SELECT id, name FROM departments WHERE is_production AND is_active ORDER BY sort_order`),
    db.execute<{ id: number; name: string }>(sql`
      SELECT c.id, c.name FROM clients c WHERE ${clientScope(actor, 'c')} ORDER BY c.name`),
    canFilterByPeople
      ? db.execute<{ id: number; name: string; is_lead: boolean }>(sql`
          SELECT u.id, u.full_name AS name, bool_or(dm.is_lead) AS is_lead
          FROM users u JOIN department_members dm ON dm.user_id = u.id
          WHERE u.is_active
          GROUP BY u.id, u.full_name ORDER BY u.full_name`)
      : Promise.resolve([] as { id: number; name: string; is_lead: boolean }[]),
  ]);

  return {
    departments: departments.map((d) => ({ id: Number(d.id), name: d.name })),
    clients: clients.map((c) => ({ id: Number(c.id), name: c.name })),
    teamLeads: people.filter((p) => p.is_lead).map((p) => ({ id: Number(p.id), name: p.name })),
    executives: people.filter((p) => !p.is_lead).map((p) => ({ id: Number(p.id), name: p.name })),
    canFilterByPeople,
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
  };
}

/** True when any filter or text is set — an empty search lists everything visible. */
export function hasAnyFilter(f: SearchFilters): boolean {
  return !isBlank(f.q) || (f.status?.length ?? 0) > 0 || !!f.departmentId || !!f.teamLeadId
    || !!f.executiveId || !!f.clientId || !!f.deliveryStatus || !!f.openRevisions
    || !isBlank(f.period) || !isBlank(f.deadlineFrom) || !isBlank(f.deadlineTo);
}
