import type { Role } from '@/lib/authz';

/** The roles a staff account can hold. Client portal logins are made from the client's page. */
export const ROLES: Role[] = ['ceo', 'coo', 'admin', 'sales', 'project_manager', 'team_lead', 'executive'];

/**
 * The role and status an Account form save ends with.
 *
 * Your own stay as they are, whatever the form sends — the form disables
 * both, so they are not even submitted. Saving your own name works;
 * demoting or deactivating yourself (and so locking the last administrator
 * out of the portal) does not. Pure, so the rule is tested without a session.
 */
export function resolveAccountFields(
  isSelf: boolean,
  stored: { role: Role; isActive: boolean },
  formData: FormData,
): { role: Role; isActive: boolean } | { error: string } {
  if (isSelf) return { role: stored.role, isActive: stored.isActive };
  const role = String(formData.get('role') ?? '') as Role;
  if (!ROLES.includes(role)) return { error: 'Choose a role.' };
  return { role, isActive: formData.get('isActive') === 'on' };
}
