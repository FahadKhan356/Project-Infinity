export {
  can, assertCan, canPlanTeam, canReviewDepartment, grantablePermissions, AuthorizationError,
  ALL_PERMISSIONS, RESTRICTION_KEYS,
} from './can';
export { projectScope, clientScope, revisionScope, stripRestrictedFields } from './scope';
export type { ScopeOptions } from './scope';
export type { Action, Actor, Permission, Role } from './types';
