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
  | 'ceo' | 'coo' | 'admin' | 'sales' | 'project_manager' | 'team_lead' | 'executive'
  /**
   * A login for someone at the client (brief §29, client portal). Holds no
   * capability and no scope inside the portal proper; it reaches only
   * /portal, which reads what was delivered to its own client.
   */
  | 'client';

export type Permission =
  | 'view_pricing' | 'manage_users' | 'close_month' | 'reopen_month'
  | 'delete_files' | 'export_reports' | 'view_all_clients'
  /**
   * The one key that takes something away (brief §43): the account keeps
   * viewing and previewing files but may not keep a copy. See
   * PERMISSION_RESTRICTIONS in ./can.
   */
  | 'no_download';

export type Action =
  | 'users.view'
  | 'users.manage'
  | 'pricing.view'
  | 'clients.viewAll'
  | 'clients.manage'
  | 'projects.viewAll'
  | 'projects.create'
  | 'projects.triage'
  /** Put on hold, resume, cancel (brief §18) — the statuses people decide. */
  | 'projects.changeStatus'
  /** Correct what Sales filed: name, objective, PO, requirements, notes, price (brief §3, §27). */
  | 'projects.edit'
  /**
   * Let a Sales rep view one project without moving its client to them
   * (brief §23: "projects they create/are authorized to view").
   */
  | 'projects.share'
  | 'planning.viewAllDepartments'
  | 'assignments.create'
  | 'qa.reviewAsTeamLead'
  | 'qa.reviewAsProjectManager'
  /** See the delivery list (brief §5, §14, §23). Marking a status is delivery.manage. */
  | 'delivery.view'
  | 'delivery.manage'
  | 'revisions.create'
  | 'month.close'
  | 'month.reopen'
  | 'files.delete'
  /**
   * Keep a copy of a file one may already see (brief §43: the portal
   * controls who may download separately from who may view). Held by every
   * staff role; withheld per user with the `no_download` restriction.
   */
  | 'files.download'
  | 'reports.export'
  /** Set and read individual hourly cost rates (brief §29 profitability). */
  | 'costs.manage'
  /** Track unconfirmed work through to a filed project (brief §29 sales pipeline). */
  | 'pipeline.manage'
  /** Draft, issue and track invoices for clients one may see (brief §29). */
  | 'invoices.manage'
  /** Company billing details, VAT rate and terms. */
  | 'invoices.configure';

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
  /** The client a portal login belongs to; absent or null for staff. */
  clientId?: number | null;
}
