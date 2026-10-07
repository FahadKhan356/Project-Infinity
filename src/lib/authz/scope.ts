import { sql, type SQL } from 'drizzle-orm';
import { can } from './can';
import type { Actor } from './types';

const ALL = sql`true`;
const NONE = sql`false`;

/** `id IN (1, 2, 3)` with every value bound, never string-concatenated. */
function idList(ids: number[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

/**
 * These fragments are composed into queries that often alias their tables
 * (`FROM projects p`), and an alias shadows the table name — so the caller
 * says which name to correlate against. The value comes from our own code,
 * never from a request, and is checked anyway.
 */
function identifier(alias: string): SQL {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error(`Unsafe SQL alias: ${alias}`);
  }
  return sql.raw(alias);
}

export interface ScopeOptions {
  /**
   * Also count the projects shared with a Sales rep to view (project_viewers,
   * §23). Off by default, so a share can never widen what a rep changes, or
   * what is summed as their own book: only a read-only view — a list, a page,
   * a download — passes `true`. Anything that writes, or counts a rep's work
   * (dashboard, reports, invoicing), keeps the default. Sales-only: no other
   * role's rule reads it — revisionScope's Executive branch in particular.
   */
  shared?: boolean;
  /**
   * Read as project history (brief §8, §33): an Executive sees every revision
   * on a project they may open, not only those on their current work (§16).
   * Set by the project page, its attachment list and the month archive; the
   * revisions list, a revision's page, the dashboard count and search keep
   * the default. Only revisionScope reads it.
   */
  history?: boolean;
}

/**
 * Row visibility for projects. Compose this into EVERY project list query,
 * including search (brief §22).
 *
 * | Role            | Sees                                                     |
 * |-----------------|----------------------------------------------------------|
 * | CEO/COO/Admin   | everything                                               |
 * | Project Manager | everything, all departments (§6)                          |
 * | Sales           | projects they own or created, and their clients' projects |
 * |                 | (+ projects shared with them to view: `shared: true`, §23) |
 * | Team Lead       | projects the PM has routed to a department they lead      |
 * | Executive       | projects they hold an assignment on — which also grants   |
 * |                 | the shared workspace for that project (§10)               |
 *
 * The `projects` table must be in scope in the surrounding query for the
 * correlated subqueries to bind.
 */
export function projectScope(actor: Actor, alias = 'projects', options: ScopeOptions = {}): SQL {
  if (!actor.isActive) return NONE;
  if (can(actor, 'projects.viewAll')) return ALL;
  const p = identifier(alias);

  switch (actor.role) {
    case 'sales':
      // Scoped by client ownership, not only by who typed the form: a rep must
      // not lose sight of their own client because a colleague filed one order.
      return sql`(
        ${p}.sales_owner_id = ${actor.id}
        OR ${p}.created_by = ${actor.id}
        OR EXISTS (
          SELECT 1 FROM clients scope_c
          WHERE scope_c.id = ${p}.client_id AND scope_c.owner_user_id = ${actor.id}
        )
        ${options.shared ? sql`OR EXISTS (
          SELECT 1 FROM project_viewers scope_pv
          WHERE scope_pv.project_id = ${p}.id AND scope_pv.user_id = ${actor.id}
        )` : sql``}
      )`;

    case 'team_lead':
      if (actor.leadDepartmentIds.length === 0) return NONE;
      // Sales' form creates the department rows at intake; the work is the
      // team's only once the PM has routed it to a lead (§4, §5).
      return sql`EXISTS (
        SELECT 1 FROM project_departments scope_pd
        WHERE scope_pd.project_id = ${p}.id
          AND scope_pd.department_id IN (${idList(actor.leadDepartmentIds)})
          AND scope_pd.team_lead_id IS NOT NULL
      )`;

    case 'executive':
      return sql`EXISTS (
        SELECT 1 FROM assignments scope_a
        WHERE scope_a.project_id = ${p}.id AND scope_a.assignee_id = ${actor.id}
      )`;

    default:
      return NONE;
  }
}

/**
 * Row visibility for clients. A client is visible when the actor can see at
 * least one of its projects, so production staff can read the client history
 * §33 requires without being handed the whole client book. With
 * `shared: true`, a project shared with a rep opens its client to them the
 * same way — to read, never to edit, bill or hand out portal logins for.
 */
export function clientScope(actor: Actor, alias = 'clients', options: ScopeOptions = {}): SQL {
  if (!actor.isActive) return NONE;
  if (can(actor, 'clients.viewAll')) return ALL;
  const c = identifier(alias);

  switch (actor.role) {
    case 'sales':
      return sql`(
        ${c}.owner_user_id = ${actor.id}
        OR EXISTS (
          SELECT 1 FROM projects scope_p
          WHERE scope_p.client_id = ${c}.id
            AND (scope_p.sales_owner_id = ${actor.id} OR scope_p.created_by = ${actor.id}
              ${options.shared ? sql`OR EXISTS (
                SELECT 1 FROM project_viewers scope_pv
                WHERE scope_pv.project_id = scope_p.id AND scope_pv.user_id = ${actor.id}
              )` : sql``})
        )
      )`;

    case 'team_lead':
      if (actor.leadDepartmentIds.length === 0) return NONE;
      return sql`EXISTS (
        SELECT 1 FROM projects scope_p
        JOIN project_departments scope_pd ON scope_pd.project_id = scope_p.id
        WHERE scope_p.client_id = ${c}.id
          AND scope_pd.department_id IN (${idList(actor.leadDepartmentIds)})
          AND scope_pd.team_lead_id IS NOT NULL
      )`;

    case 'executive':
      return sql`EXISTS (
        SELECT 1 FROM projects scope_p
        JOIN assignments scope_a ON scope_a.project_id = scope_p.id
        WHERE scope_p.client_id = ${c}.id AND scope_a.assignee_id = ${actor.id}
      )`;

    default:
      return NONE;
  }
}

/**
 * Row visibility for revisions (brief §16). A revision is visible when its
 * project is, with two roles held closer:
 *
 * - A Team Lead sees only revisions that touch a deliverable in a team they
 *   lead — the Design lead does not see the client's note about the video.
 * - An Executive sees the revisions related to their current work: those on
 *   a project where they hold an open assignment (planned, in progress or
 *   submitted), or that touch a slot assigned to them — so a closed round
 *   on their own slot stays theirs to look up. A completed assignment on the
 *   project is history, not current work: the project stays open to them
 *   (§8, projectScope), and with `history: true` its revisions are read
 *   under that project rule instead.
 */
export function revisionScope(actor: Actor, alias = 'revisions', options: ScopeOptions = {}): SQL {
  if (!actor.isActive) return NONE;
  const r = identifier(alias);
  const viaProject = sql`EXISTS (
    SELECT 1 FROM projects scope_rp
    WHERE scope_rp.id = ${r}.project_id AND ${projectScope(actor, 'scope_rp', options)}
  )`;

  if (actor.role === 'executive' && !can(actor, 'projects.viewAll') && !options.history) {
    // Both clauses imply an assignment on the project, so projectScope's
    // executive rule is already satisfied and is not composed again.
    return sql`(EXISTS (
      SELECT 1 FROM assignments scope_a
      WHERE scope_a.project_id = ${r}.project_id AND scope_a.assignee_id = ${actor.id}
        AND scope_a.status IN ('planned', 'in_progress', 'submitted')
    ) OR EXISTS (
      SELECT 1 FROM revision_deliverables scope_rd
      JOIN deliverables scope_rdd ON scope_rdd.id = scope_rd.deliverable_id
      JOIN assignments scope_ra   ON scope_ra.id = scope_rdd.assignment_id
      WHERE scope_rd.revision_id = ${r}.id AND scope_ra.assignee_id = ${actor.id}
    ))`;
  }

  if (actor.role === 'team_lead' && !can(actor, 'projects.viewAll')) {
    if (actor.leadDepartmentIds.length === 0) return NONE;
    return sql`(${viaProject} AND EXISTS (
      SELECT 1 FROM revision_deliverables scope_rd
      JOIN deliverables scope_rdd        ON scope_rdd.id = scope_rd.deliverable_id
      JOIN project_departments scope_rpd ON scope_rpd.id = scope_rdd.project_department_id
      WHERE scope_rd.revision_id = ${r}.id
        AND scope_rpd.department_id IN (${idList(actor.leadDepartmentIds)})
        AND scope_rpd.team_lead_id IS NOT NULL
    ))`;
  }
  return viaProject;
}

/**
 * Field-level rule for pricing (brief §3, §23). Pricing is stripped on the
 * server — never sent to the browser and hidden with CSS.
 */
export function stripRestrictedFields<T extends Record<string, unknown>>(
  actor: Actor,
  row: T,
): Partial<T> {
  if (can(actor, 'pricing.view')) return row;
  const { priceAmount: _amount, priceCurrency: _currency, ...rest } = row;
  return rest as Partial<T>;
}
