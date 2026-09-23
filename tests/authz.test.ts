/**
 * Capability matrix. Pure logic, no database — asserts both directions for
 * every role so a future edit to ROLE_CAPABILITIES cannot silently widen or
 * narrow access.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { can, canReviewDepartment } from '../src/lib/authz/can';
import type { Action, Actor, Permission, Role } from '../src/lib/authz/types';

function actor(role: Role, over: Partial<Actor> = {}): Actor {
  return {
    id: 1,
    email: `${role}@aktivacity.local`,
    fullName: role,
    role,
    isActive: true,
    mustChangePassword: false,
    leadDepartmentIds: [],
    departmentIds: [],
    permissions: new Set<Permission>(),
    ...over,
  };
}

describe('pricing visibility (brief §3, §23)', () => {
  const allowed: Role[] = ['ceo', 'coo', 'admin', 'sales', 'project_manager'];
  const denied: Role[] = ['team_lead', 'executive'];

  for (const role of allowed) {
    test(`${role} sees pricing`, () => assert.equal(can(actor(role), 'pricing.view'), true));
  }
  for (const role of denied) {
    test(`${role} does NOT see pricing`, () =>
      assert.equal(can(actor(role), 'pricing.view'), false));
  }

  test('a Team Lead granted view_pricing does see it', () => {
    const granted = actor('team_lead', { permissions: new Set<Permission>(['view_pricing']) });
    assert.equal(can(granted, 'pricing.view'), true);
  });

  test('the grant does not leak to other actions', () => {
    const granted = actor('team_lead', { permissions: new Set<Permission>(['view_pricing']) });
    assert.equal(can(granted, 'users.manage'), false);
    assert.equal(can(granted, 'projects.viewAll'), false);
  });
});

describe('user administration', () => {
  for (const role of ['ceo', 'coo', 'admin'] as Role[]) {
    test(`${role} can manage users`, () => assert.equal(can(actor(role), 'users.manage'), true));
  }
  for (const role of ['sales', 'project_manager', 'team_lead', 'executive'] as Role[]) {
    test(`${role} cannot manage users`, () =>
      assert.equal(can(actor(role), 'users.manage'), false));
  }
});

describe('QA authority (brief §12, §13)', () => {
  test('a Team Lead signs off only for the departments they lead', () => {
    const lead = actor('team_lead', { leadDepartmentIds: [1, 2], departmentIds: [1, 2] });
    assert.equal(canReviewDepartment(lead, 1), true);
    assert.equal(canReviewDepartment(lead, 2), true);
    assert.equal(canReviewDepartment(lead, 3), false);
  });

  test('a Project Manager signs off for any department', () => {
    const pm = actor('project_manager');
    assert.equal(canReviewDepartment(pm, 99), true);
  });

  test('an Executive never signs off', () => {
    assert.equal(canReviewDepartment(actor('executive'), 1), false);
    assert.equal(can(actor('executive'), 'qa.reviewAsTeamLead'), false);
  });
});

describe('an Executive holds no portal-wide capability', () => {
  const everyAction: Action[] = [
    'users.view', 'users.manage', 'pricing.view', 'clients.viewAll', 'clients.manage',
    'projects.viewAll', 'projects.create', 'projects.triage', 'planning.viewAllDepartments',
    'assignments.create', 'qa.reviewAsTeamLead', 'qa.reviewAsProjectManager',
    'delivery.manage', 'revisions.create', 'month.close', 'month.reopen',
    'files.delete', 'reports.export',
  ];

  test('every action is denied', () => {
    const granted = everyAction.filter((a) => can(actor('executive'), a));
    assert.deepEqual(granted, []);
  });
});

describe('deactivation overrides everything', () => {
  test('a deactivated CEO can do nothing', () => {
    const dead = actor('ceo', { isActive: false });
    assert.equal(can(dead, 'users.manage'), false);
    assert.equal(can(dead, 'pricing.view'), false);
    assert.equal(canReviewDepartment(dead, 1), false);
  });
});

describe('admin is a systems role, not a business role', () => {
  test('it cannot sign off QA or deliver to clients', () => {
    const a = actor('admin');
    assert.equal(can(a, 'qa.reviewAsProjectManager'), false);
    assert.equal(can(a, 'qa.reviewAsTeamLead'), false);
    assert.equal(can(a, 'delivery.manage'), false);
    assert.equal(can(a, 'projects.triage'), false);
  });
});
