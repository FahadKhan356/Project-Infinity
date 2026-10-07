import 'server-only';
import { sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { AuthorizationError, can, clientScope, projectScope } from '@/lib/authz';
import { toActivityLines, type ActivityLine, type ActivityRow } from './feed';

/**
 * The management-wide activity log (brief §25): every project's record on
 * one page, newest first, for those who may see every project — management,
 * the administrator and the Project Manager. A Team Lead or an Executive
 * reads a project's own timeline on its page instead.
 */
export function canViewActivityLog(actor: Actor): boolean {
  return actor.isActive && can(actor, 'projects.viewAll');
}

export const ACTIVITY_PAGE_SIZE = 50;

export interface ActivityLogFilters {
  clientId?: number | null;
  /** A substring of the project code, matched case-insensitively. */
  projectCode?: string | null;
  actorId?: number | null;
  /** One action name, exactly: 'qa.reviewed'. */
  action?: string | null;
  /** YYYY-MM-DD, inclusive at both ends, read in the database's day. */
  from?: string | null;
  to?: string | null;
  /** 1-based; anything else reads as the first page. */
  page?: number | null;
}

export interface ActivityLogRow extends ActivityLine {
  projectId: number;
  projectCode: string;
  projectTitle: string;
  clientId: number;
  clientName: string;
}

export interface ActivityLogPage {
  rows: ActivityLogRow[];
  page: number;
  pageSize: number;
  /** Whether a later page exists; the total is never counted. */
  hasMore: boolean;
}

export interface ActivityLogOptions {
  clients: { id: number; name: string }[];
  actors: { id: number; name: string }[];
  actions: string[];
}

type Params = Record<string, string | string[] | undefined>;

const one = (params: Params, key: string): string | null => {
  const v = params[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined || s.trim() === '' ? null : s.trim();
};
const id = (params: Params, key: string): number | null => {
  const n = Number(one(params, key));
  return Number.isInteger(n) && n > 0 ? n : null;
};

const ACTION_NAME = /^[a-z_]+\.[a-z_]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_MAX = 40;

const isoDate = (value: string | null | undefined): string | null =>
  value != null && ISO_DATE.test(value) ? value : null;
const actionName = (value: string | null | undefined): string | null =>
  value != null && ACTION_NAME.test(value) ? value : null;
const pageNo = (value: number | null | undefined): number =>
  value != null && Number.isInteger(value) && value >= 1 ? value : 1;

/** Query string → filters. Unknown values are dropped, never errors. */
export function parseActivityLogParams(params: Params): Required<ActivityLogFilters> {
  const code = one(params, 'code');
  const page = Number(one(params, 'page'));
  return {
    clientId: id(params, 'client'),
    projectCode: code === null ? null : code.slice(0, CODE_MAX),
    actorId: id(params, 'actor'),
    action: actionName(one(params, 'action')),
    from: isoDate(one(params, 'from')),
    to: isoDate(one(params, 'to')),
    page: pageNo(page),
  };
}

/** True when any filter is set — an empty log lists everything visible. */
export function hasAnyActivityFilter(f: ActivityLogFilters): boolean {
  return !!f.clientId || !!f.projectCode?.trim() || !!f.actorId || !!f.action || !!f.from || !!f.to;
}

function refuse(actor: Actor): never {
  throw new AuthorizationError(`${actor.role} is not permitted to view the activity log`);
}

type LogRow = ActivityRow & {
  project_id: number;
  project_code: string;
  project_title: string;
  client_id: number;
  client_name: string;
};

/**
 * One page of the log. Only rows tied to a project are listed: the page
 * exists to track accountability across projects, and every line links to
 * its project, so a login or a user-admin entry has no place here. Every
 * action is listed, not only the project page's feed — downloads and refused
 * attempts are kept for exactly this query — and the action filter narrows.
 * The project scope is composed as everywhere else, so the page stays right
 * if who may open it is ever widened.
 */
export async function activityLog(actor: Actor, filters: ActivityLogFilters): Promise<ActivityLogPage> {
  if (!canViewActivityLog(actor)) refuse(actor);
  const page = pageNo(filters.page);
  const where: SQL[] = [projectScope(actor, 'p')];

  if (filters.clientId) where.push(sql`p.client_id = ${filters.clientId}`);
  const code = filters.projectCode?.trim().slice(0, CODE_MAX);
  if (code) {
    const pattern = `%${code.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(sql`p.project_code ILIKE ${pattern}`);
  }
  if (filters.actorId) where.push(sql`al.actor_id = ${filters.actorId}`);
  const action = actionName(filters.action);
  if (action) where.push(sql`al.action = ${action}`);
  const from = isoDate(filters.from);
  if (from) where.push(sql`al.created_at >= ${from}::date`);
  const to = isoDate(filters.to);
  if (to) where.push(sql`al.created_at < ${to}::date + interval '1 day'`);

  // One row past the page says whether there is a next one; no count query.
  const rows = await getDb().execute<LogRow>(sql`
    SELECT al.id,
           to_char(al.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
           u.full_name AS actor_name, al.action, al.metadata,
           p.id AS project_id, p.project_code, p.title AS project_title,
           c.id AS client_id, c.name AS client_name
    FROM activity_log al
    JOIN projects p ON p.id = al.project_id
    JOIN clients c  ON c.id = p.client_id
    LEFT JOIN users u ON u.id = al.actor_id
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY al.created_at DESC, al.id DESC
    LIMIT ${ACTIVITY_PAGE_SIZE + 1} OFFSET ${(page - 1) * ACTIVITY_PAGE_SIZE}
  `);
  const hasMore = rows.length > ACTIVITY_PAGE_SIZE;
  const pageRows = hasMore ? rows.slice(0, ACTIVITY_PAGE_SIZE) : rows;

  const byId = new Map(pageRows.map((r) => [Number(r.id), r]));
  const lines = toActivityLines(pageRows, { showPricing: can(actor, 'pricing.view') });
  return {
    rows: lines.map((line) => {
      const r = byId.get(line.id)!;
      return {
        ...line,
        projectId: Number(r.project_id),
        projectCode: r.project_code,
        projectTitle: r.project_title,
        clientId: Number(r.client_id),
        clientName: r.client_name,
      };
    }),
    page,
    pageSize: ACTIVITY_PAGE_SIZE,
    hasMore,
  };
}

/**
 * What the filter form offers: the clients this person may see, every
 * member of staff (a deactivated account keeps its past actions), and the
 * action names that have actually been recorded against a project.
 */
export async function activityLogOptions(actor: Actor): Promise<ActivityLogOptions> {
  if (!canViewActivityLog(actor)) refuse(actor);
  const db = getDb();
  const [clients, actors, actions] = await Promise.all([
    db.execute<{ id: number; name: string }>(sql`
      SELECT c.id, c.name FROM clients c WHERE ${clientScope(actor, 'c')} ORDER BY c.name`),
    db.execute<{ id: number; name: string }>(sql`
      SELECT id, full_name AS name FROM users WHERE role <> 'client' ORDER BY full_name`),
    db.execute<{ action: string }>(sql`
      SELECT DISTINCT action FROM activity_log WHERE project_id IS NOT NULL ORDER BY action`),
  ]);
  return {
    clients: clients.map((c) => ({ id: Number(c.id), name: c.name })),
    actors: actors.map((u) => ({ id: Number(u.id), name: u.name })),
    actions: actions.map((a) => a.action),
  };
}
