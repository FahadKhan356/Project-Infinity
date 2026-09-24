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

/**
 * Row visibility for projects. Compose this into EVERY project list query,
 * including search (brief §22).
 *
 * | Role            | Sees                                                     |
 * |-----------------|----------------------------------------------------------|
 * | CEO/COO/Admin   | everything                                               |
 * | Project Manager | everything, all departments (§6)                          |
 * | Sales           | projects they own or created, and their clients' projects |
 * | Team Lead       | projects with work in a department they lead              |
 * | Executive       | projects they hold an assignment on — which also grants   |
 * |                 | the shared workspace for that project (§10)               |
 *
 * The `projects` table must be in scope in the surrounding query for the
 * correlated subqueries to bind.
 */
export function projectScope(actor: Actor, alias = 'projects'): SQL {
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
      )`;

    case 'team_lead':
      if (actor.leadDepartmentIds.length === 0) return NONE;
      return sql`EXISTS (
        SELECT 1 FROM project_departments scope_pd
        WHERE scope_pd.project_id = ${p}.id
          AND scope_pd.department_id IN (${idList(actor.leadDepartmentIds)})
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
 * §33 requires without being handed the whole client book.
 */
export function clientScope(actor: Actor, alias = 'clients'): SQL {
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
            AND (scope_p.sales_owner_id = ${actor.id} OR scope_p.created_by = ${actor.id})
        )
      )`;

    case 'team_lead':
      if (actor.leadDepartmentIds.length === 0) return NONE;
      return sql`EXISTS (
        SELECT 1 FROM projects scope_p
        JOIN project_departments scope_pd ON scope_pd.project_id = scope_p.id
        WHERE scope_p.client_id = ${c}.id
          AND scope_pd.department_id IN (${idList(actor.leadDepartmentIds)})
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
 * project is. A Team Lead additionally sees only revisions that touch a
 * deliverable in a team they lead — the Design lead does not see the
 * client's note about the video.
 */
export function revisionScope(actor: Actor, alias = 'revisions'): SQL {
  if (!actor.isActive) return NONE;
  const r = identifier(alias);
  const viaProject = sql`EXISTS (
    SELECT 1 FROM projects scope_rp
    WHERE scope_rp.id = ${r}.project_id AND ${projectScope(actor, 'scope_rp')}
  )`;

  if (actor.role === 'team_lead' && !can(actor, 'projects.viewAll')) {
    if (actor.leadDepartmentIds.length === 0) return NONE;
    return sql`(${viaProject} AND EXISTS (
      SELECT 1 FROM revision_deliverables scope_rd
      JOIN deliverables scope_rdd        ON scope_rdd.id = scope_rd.deliverable_id
      JOIN project_departments scope_rpd ON scope_rpd.id = scope_rdd.project_department_id
      WHERE scope_rd.revision_id = ${r}.id
        AND scope_rpd.department_id IN (${idList(actor.leadDepartmentIds)})
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
