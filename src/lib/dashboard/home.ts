import type { Role } from '@/lib/authz';

/**
 * Where a role lands after signing in, and where "/" sends them. An
 * Executive's primary page is their projects — what is on their desk now and
 * what they did before (brief §8); a client login lives in the portal (§29);
 * everyone else opens their dashboard (§21). Pure, so the login action, the
 * root page and the header agree without a query.
 */
export function homePath(role: Role): string {
  switch (role) {
    case 'executive': return '/work';
    case 'client': return '/portal';
    default: return '/dashboard';
  }
}
