import type { Action, Actor, Permission, Role } from './types';

/**
 * Capabilities granted by role alone. Brief §23.
 *
 * Anything a role does NOT hold here can still be granted per user through
 * `user_permissions` — that is how §23's "Team Leads ... no pricing visibility
 * unless specifically authorized" is expressed without inventing a new role.
 */
const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Action>> = {
  ceo: new Set<Action>([
    'users.view', 'users.manage', 'pricing.view', 'clients.viewAll', 'clients.manage',
    'projects.viewAll', 'projects.create', 'projects.triage', 'projects.changeStatus', 'projects.edit',
    'projects.share', 'planning.viewAllDepartments',
    'assignments.create', 'qa.reviewAsTeamLead', 'qa.reviewAsProjectManager',
    'delivery.view', 'delivery.manage', 'revisions.create', 'month.close', 'month.reopen',
    'files.delete', 'files.download', 'reports.export', 'costs.manage', 'pipeline.manage',
    'invoices.manage', 'invoices.configure',
  ]),
  coo: new Set<Action>([
    'users.view', 'users.manage', 'pricing.view', 'clients.viewAll', 'clients.manage',
    'projects.viewAll', 'projects.create', 'projects.triage', 'projects.changeStatus', 'projects.edit',
    'projects.share', 'planning.viewAllDepartments',
    'assignments.create', 'qa.reviewAsTeamLead', 'qa.reviewAsProjectManager',
    'delivery.view', 'delivery.manage', 'revisions.create', 'month.close', 'month.reopen',
    'files.delete', 'files.download', 'reports.export', 'costs.manage', 'pipeline.manage',
    'invoices.manage', 'invoices.configure',
  ]),
  // Admin administers the system. It is deliberately NOT a business role:
  // no QA sign-off, no delivery, no triage. Sharing a project is access
  // control, which is what the role is for.
  admin: new Set<Action>([
    'users.view', 'users.manage', 'clients.viewAll', 'clients.manage',
    'projects.viewAll', 'projects.share', 'pricing.view', 'files.delete', 'files.download',
    'reports.export', 'month.reopen',
  ]),
  sales: new Set<Action>([
    'pricing.view', 'clients.manage', 'projects.create', 'projects.changeStatus', 'projects.edit',
    'revisions.create', 'files.download',
    'delivery.view', 'delivery.manage', 'month.close', 'pipeline.manage', 'invoices.manage',
  ]),
  // The PM sees deliveries (§5, §23) but does not make them: that is Sales' (§14).
  project_manager: new Set<Action>([
    'pricing.view', 'clients.viewAll', 'projects.viewAll', 'projects.create',
    'projects.triage', 'projects.changeStatus', 'projects.edit', 'projects.share',
    'planning.viewAllDepartments', 'assignments.create',
    'qa.reviewAsTeamLead', 'qa.reviewAsProjectManager', 'delivery.view', 'revisions.create',
    'month.close', 'reports.export', 'files.download',
  ]),
  team_lead: new Set<Action>([
    'assignments.create', 'qa.reviewAsTeamLead', 'files.download',
  ]),
  // The one thing an Executive holds: keeping a copy of a file they can
  // already see (§43). It is on files they can see, not portal-wide — what
  // they see is still their own assignments (§22, §23).
  executive: new Set<Action>(['files.download']),
  // A client portal login does nothing inside the portal proper — not even
  // with a per-user grant (see can()). What it may see lives in lib/portal.
  client: new Set<Action>([]),
};

/** Per-user grants that unlock an action the role does not carry. */
const PERMISSION_UNLOCKS: Partial<Record<Action, Permission>> = {
  'pricing.view': 'view_pricing',
  'users.manage': 'manage_users',
  'users.view': 'manage_users',
  'clients.viewAll': 'view_all_clients',
  'month.close': 'close_month',
  'month.reopen': 'reopen_month',
  'files.delete': 'delete_files',
  'reports.export': 'export_reports',
};

/**
 * Per-user restrictions that take away an action the role does carry
 * (brief §43: who may download is decided apart from who may view). The
 * model is otherwise additive — a row unlocks — so a right every staff
 * role holds by default is withheld by the presence of a row, not the
 * absence of one: existing accounts and fixtures need no backfill.
 *
 * A restriction row lingers across role changes exactly as a grant does
 * (updateUser does not prune user_permissions): an Executive promoted to
 * CEO keeps the row and can() ignores it, because a CEO cannot hold it;
 * demoted back, it applies again. That is the stray-grant rule, applied
 * in both directions on purpose.
 */
const PERMISSION_RESTRICTIONS: Partial<Record<Action, Permission>> = {
  'files.download': 'no_download',
};

/** The keys that take away rather than add: the admin form lists them apart. */
export const RESTRICTION_KEYS: ReadonlySet<Permission> = new Set(Object.values(PERMISSION_RESTRICTIONS));

/**
 * Every user_permissions key there is — the single source for the admin
 * action's whitelist, kept equal to the permission_key enum by
 * tests/authz.test.ts.
 */
export const ALL_PERMISSIONS: readonly Permission[] = [
  'view_pricing', 'manage_users', 'close_month', 'reopen_month',
  'delete_files', 'export_reports', 'view_all_clients', 'no_download',
];

/**
 * Every user_permissions row a role may hold, restrictions included
 * (brief §23, §43).
 *
 * A Team Lead may be authorised to see pricing; an Executive may not, and
 * has no business with any other grant either: their access is "only" their
 * own assignments. Management already holds everything, and is never
 * restricted (§23: full access); admin is the systems role and needs
 * downloads for recovery. The admin form offers only these, the save
 * refuses anything else, and can() ignores a row that slipped in some
 * other way.
 */
const GRANTABLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  ceo: [],
  coo: [],
  admin: ['close_month'],
  sales: ['view_all_clients', 'export_reports', 'delete_files', 'reopen_month', 'no_download'],
  project_manager: ['delete_files', 'reopen_month', 'no_download'],
  team_lead: ['view_pricing', 'export_reports', 'delete_files', 'no_download'],
  executive: ['no_download'],
  client: [],
};

export function grantablePermissions(role: Role): Permission[] {
  return [...GRANTABLE_PERMISSIONS[role]];
}

export function can(actor: Actor, action: Action): boolean {
  // A deactivated account can do nothing, whatever its role says.
  if (!actor.isActive) return false;
  if (actor.role === 'client') return false;

  // A restriction the role may hold, and does, takes the action away
  // before the role is consulted; one the role cannot hold counts for
  // nothing, as a stray grant does.
  const restriction = PERMISSION_RESTRICTIONS[action];
  if (restriction !== undefined
    && actor.permissions.has(restriction)
    && GRANTABLE_PERMISSIONS[actor.role].includes(restriction)) {
    return false;
  }

  if (ROLE_CAPABILITIES[actor.role].has(action)) return true;

  const unlock = PERMISSION_UNLOCKS[action];
  return unlock !== undefined
    && actor.permissions.has(unlock)
    && GRANTABLE_PERMISSIONS[actor.role].includes(unlock);
}

/** Throwing variant for server actions and route handlers. */
export function assertCan(actor: Actor, action: Action): void {
  if (!can(actor, action)) {
    throw new AuthorizationError(`${actor.role} is not permitted to ${action}`);
  }
}

export class AuthorizationError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

/** Can this actor sign off QA at the given stage for the given department? */
export function canReviewDepartment(actor: Actor, departmentId: number): boolean {
  if (!actor.isActive) return false;
  if (can(actor, 'qa.reviewAsProjectManager')) return true;
  return actor.leadDepartmentIds.includes(departmentId);
}

/**
 * May this actor plan one team's work on a project (brief §6, §7)? The
 * Project Manager plans every team. A lead plans the teams of a department
 * they lead once the PM has routed the work there — "their team", not only
 * the rows naming them, so a co-lead shares the board as /planning shows it.
 */
export function canPlanTeam(
  actor: Actor,
  team: { departmentId: number; teamLeadId: number | null },
): boolean {
  if (!actor.isActive) return false;
  if (can(actor, 'planning.viewAllDepartments')) return true;
  return team.teamLeadId !== null && actor.leadDepartmentIds.includes(team.departmentId);
}
