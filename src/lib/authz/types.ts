/**
 * The policy layer. Nothing outside this directory may hand-roll a role check.
 *
 * Two entry points, and only two:
 *   can(actor, action)            — yes/no on a capability
 *   projectScope(actor) / clientScope(actor)
 *                                 — a WHERE fragment every list query composes
 *
 * Brief §23 is the specification; brief §22 is the reason this is centralised
 * ("an Executive should not be able to search and discover projects they don't
 * have access to").
 */

export type Role =
  | 'ceo' | 'coo' | 'admin' | 'sales' | 'project_manager' | 'team_lead' | 'executive';

export type Permission =
  | 'view_pricing' | 'manage_users' | 'close_month' | 'reopen_month'
  | 'delete_files' | 'export_reports' | 'view_all_clients';

export type Action =
  | 'users.view'
  | 'users.manage'
  | 'pricing.view'
  | 'clients.viewAll'
  | 'clients.manage'
  | 'projects.viewAll'
  | 'projects.create'
  | 'projects.triage'
  | 'planning.viewAllDepartments'
  | 'assignments.create'
  | 'qa.reviewAsTeamLead'
  | 'qa.reviewAsProjectManager'
  | 'delivery.manage'
  | 'revisions.create'
  | 'month.close'
  | 'month.reopen'
  | 'files.delete'
  | 'reports.export';

/**
 * Everything the policy layer is allowed to know about the current user.
 * Built once per request by the data access layer.
 */
export interface Actor {
  id: number;
  email: string;
  fullName: string;
  role: Role;
  isActive: boolean;
  mustChangePassword: boolean;
  /** Departments this user leads (brief §6: a lead may cover more than one). */
  leadDepartmentIds: number[];
  /** Departments this user belongs to, lead or not. */
  departmentIds: number[];
  permissions: ReadonlySet<Permission>;
}
