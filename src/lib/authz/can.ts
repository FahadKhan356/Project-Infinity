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
    'projects.viewAll', 'projects.create', 'projects.triage', 'planning.viewAllDepartments',
    'assignments.create', 'qa.reviewAsTeamLead', 'qa.reviewAsProjectManager',
    'delivery.manage', 'revisions.create', 'month.close', 'month.reopen',
    'files.delete', 'reports.export',
  ]),
  coo: new Set<Action>([
    'users.view', 'users.manage', 'pricing.view', 'clients.viewAll', 'clients.manage',
    'projects.viewAll', 'projects.create', 'projects.triage', 'planning.viewAllDepartments',
    'assignments.create', 'qa.reviewAsTeamLead', 'qa.reviewAsProjectManager',
    'delivery.manage', 'revisions.create', 'month.close', 'month.reopen',
    'files.delete', 'reports.export',
  ]),
  // Admin administers the system. It is deliberately NOT a business role:
  // no QA sign-off, no delivery, no triage.
  admin: new Set<Action>([
    'users.view', 'users.manage', 'clients.viewAll', 'clients.manage',
    'projects.viewAll', 'pricing.view', 'files.delete', 'reports.export',
    'month.reopen',
  ]),
  sales: new Set<Action>([
    'pricing.view', 'clients.manage', 'projects.create', 'revisions.create',
    'delivery.manage', 'month.close',
  ]),
  project_manager: new Set<Action>([
    'pricing.view', 'clients.viewAll', 'projects.viewAll', 'projects.create',
    'projects.triage', 'planning.viewAllDepartments', 'assignments.create',
    'qa.reviewAsTeamLead', 'qa.reviewAsProjectManager', 'revisions.create',
    'month.close', 'reports.export',
  ]),
  team_lead: new Set<Action>([
    'assignments.create', 'qa.reviewAsTeamLead',
  ]),
  executive: new Set<Action>([]),
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

export function can(actor: Actor, action: Action): boolean {
  // A deactivated account can do nothing, whatever its role says.
  if (!actor.isActive) return false;

  if (ROLE_CAPABILITIES[actor.role].has(action)) return true;

  const unlock = PERMISSION_UNLOCKS[action];
  return unlock !== undefined && actor.permissions.has(unlock);
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
