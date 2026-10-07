/**
 * Capability matrix. Pure logic, no database — asserts both directions for
 * every role so a future edit to ROLE_CAPABILITIES cannot silently widen or
 * narrow access.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { permissionKey } from '../src/db/schema';
import {
  ALL_PERMISSIONS, RESTRICTION_KEYS, can, canPlanTeam, canReviewDepartment, grantablePermissions,
} from '../src/lib/authz/can';
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

describe('which grants a role can hold (brief §23)', () => {
  test('an Executive can be granted nothing: no pricing, no all-clients', () => {
    // The one row an Executive may hold takes something away (§43); it is
    // not a grant.
    assert.deepEqual(grantablePermissions('executive').filter((k) => !RESTRICTION_KEYS.has(k)), []);
  });

  test('a grant a role cannot hold is ignored even if a row exists', () => {
    const exec = actor('executive', { permissions: new Set<Permission>(['view_pricing', 'view_all_clients']) });
    assert.equal(can(exec, 'pricing.view'), false);
    assert.equal(can(exec, 'clients.viewAll'), false);
  });

  test('a Team Lead may be authorised for pricing, but not for all clients', () => {
    assert.ok(grantablePermissions('team_lead').includes('view_pricing'));
    assert.ok(!grantablePermissions('team_lead').includes('view_all_clients'));
    const lead = actor('team_lead', { permissions: new Set<Permission>(['view_all_clients']) });
    assert.equal(can(lead, 'clients.viewAll'), false);
  });

  test('a rep may be trusted with every client', () => {
    assert.ok(grantablePermissions('sales').includes('view_all_clients'));
    const rep = actor('sales', { permissions: new Set<Permission>(['view_all_clients']) });
    assert.equal(can(rep, 'clients.viewAll'), true);
  });

  test('management needs no grants', () => {
    assert.deepEqual(grantablePermissions('ceo'), []);
    assert.deepEqual(grantablePermissions('coo'), []);
  });
});

describe('downloading is a right of its own (brief §43)', () => {
  const staff: Role[] = ['ceo', 'coo', 'admin', 'sales', 'project_manager', 'team_lead', 'executive'];
  const restrictable: Role[] = ['executive', 'team_lead', 'sales', 'project_manager'];
  const unrestrictable: Role[] = ['ceo', 'coo', 'admin'];
  const withheld = (role: Role, extra: Permission[] = []) =>
    actor(role, { permissions: new Set<Permission>(['no_download', ...extra]) });

  for (const role of staff) {
    test(`${role} downloads by default`, () => assert.equal(can(actor(role), 'files.download'), true));
  }
  test('a client login is governed by the portal, not by can()', () => {
    assert.equal(can(actor('client'), 'files.download'), false);
  });

  for (const role of restrictable) {
    test(`a no_download row withholds it from a ${role}`, () => {
      assert.equal(can(withheld(role), 'files.download'), false);
      assert.ok(grantablePermissions(role).includes('no_download'), 'the admin form offers it');
    });
  }

  test('the restriction is narrow: everything else the account holds survives', () => {
    const lead = withheld('team_lead', ['delete_files']);
    assert.equal(can(lead, 'files.download'), false);
    assert.equal(can(lead, 'files.delete'), true);
    assert.equal(can(lead, 'qa.reviewAsTeamLead'), true);
    const rep = withheld('sales');
    assert.equal(can(rep, 'projects.create'), true);
    assert.equal(can(rep, 'delivery.manage'), true);
  });

  for (const role of unrestrictable) {
    test(`a stray row on a ${role} counts for nothing, as a stray grant does`, () => {
      assert.equal(can(withheld(role), 'files.download'), true);
      assert.ok(!grantablePermissions(role).includes('no_download'));
    });
  }

  test('an Executive may hold the restriction and no grant', () => {
    assert.deepEqual(grantablePermissions('executive'), ['no_download']);
    assert.deepEqual([...RESTRICTION_KEYS], ['no_download']);
  });

  test('a deactivated account downloads nothing, restricted or not', () => {
    assert.equal(can(actor('ceo', { isActive: false }), 'files.download'), false);
    assert.equal(can(withheld('team_lead', []), 'files.download'), false);
  });

  test('the Permission type, the permission_key enum and the admin whitelist agree', () => {
    // schema.test.ts checks tables and columns, not enums: this is the guard
    // that a key added in one place is added in the other two.
    assert.deepEqual(new Set(ALL_PERMISSIONS), new Set(permissionKey.enumValues));
    for (const role of [...staff, 'client'] as Role[]) {
      for (const key of grantablePermissions(role)) {
        assert.ok(ALL_PERMISSIONS.includes(key), `${role} may hold ${key}, which ALL_PERMISSIONS lacks`);
      }
    }
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
    'projects.viewAll', 'projects.create', 'projects.triage', 'projects.changeStatus', 'projects.edit',
    'projects.share',
    'planning.viewAllDepartments', 'assignments.create', 'qa.reviewAsTeamLead', 'qa.reviewAsProjectManager',
    'delivery.view', 'delivery.manage', 'revisions.create', 'month.close', 'month.reopen',
    'files.delete', 'reports.export', 'costs.manage', 'pipeline.manage',
    'invoices.manage', 'invoices.configure',
  ];

  test('every action is denied', () => {
    const granted = everyAction.filter((a) => can(actor('executive'), a));
    assert.deepEqual(granted, []);
  });
});

describe('the delivery list is the PM’s to read and Sales’ to move (brief §5, §14, §23)', () => {
  const viewers: Role[] = ['ceo', 'coo', 'sales', 'project_manager'];
  const others: Role[] = ['admin', 'team_lead', 'executive', 'client'];
  for (const role of viewers) {
    test(`${role} sees deliveries`, () => assert.equal(can(actor(role), 'delivery.view'), true));
  }
  for (const role of others) {
    test(`${role} does not`, () => assert.equal(can(actor(role), 'delivery.view'), false));
  }

  test('the Project Manager reads the list but does not mark deliveries', () => {
    assert.equal(can(actor('project_manager'), 'delivery.manage'), false);
  });

  test('whoever may mark a delivery may also see the list', () => {
    const roles: Role[] = ['ceo', 'coo', 'admin', 'sales', 'project_manager', 'team_lead', 'executive', 'client'];
    const blind = roles.filter((r) => can(actor(r), 'delivery.manage') && !can(actor(r), 'delivery.view'));
    assert.deepEqual(blind, []);
  });
});

describe('sharing a project with a Sales rep is management’s and the PM’s (brief §23)', () => {
  for (const role of ['ceo', 'coo', 'admin', 'project_manager'] as Role[]) {
    test(`${role} may`, () => assert.equal(can(actor(role), 'projects.share'), true));
  }
  for (const role of ['sales', 'team_lead', 'executive', 'client'] as Role[]) {
    test(`${role} may not`, () => assert.equal(can(actor(role), 'projects.share'), false));
  }
  test('no per-user grant hands it to a rep', () => {
    const granted = actor('sales', {
      permissions: new Set<Permission>(['view_all_clients', 'manage_users', 'view_pricing']),
    });
    assert.equal(can(granted, 'projects.share'), false);
  });
});

describe('planning a team (brief §6, §7)', () => {
  const routed = { departmentId: 1, teamLeadId: 7 };

  test('the named lead plans it', () => {
    const lead = actor('team_lead', { id: 7, leadDepartmentIds: [1] });
    assert.equal(canPlanTeam(lead, routed), true);
  });

  test('a co-lead of the same department plans the same board', () => {
    const coLead = actor('team_lead', { id: 8, leadDepartmentIds: [1] });
    assert.equal(canPlanTeam(coLead, routed), true);
  });

  test('a lead of another department does not', () => {
    const other = actor('team_lead', { id: 9, leadDepartmentIds: [2] });
    assert.equal(canPlanTeam(other, routed), false);
  });

  test('nobody but the PM plans a team the PM has not routed yet (§4, §5)', () => {
    const lead = actor('team_lead', { id: 7, leadDepartmentIds: [1] });
    assert.equal(canPlanTeam(lead, { departmentId: 1, teamLeadId: null }), false);
    assert.equal(canPlanTeam(actor('project_manager'), { departmentId: 1, teamLeadId: null }), true);
  });

  test('an Executive or a deactivated lead does not', () => {
    assert.equal(canPlanTeam(actor('executive', { id: 7 }), routed), false);
    const dead = actor('team_lead', { id: 7, leadDepartmentIds: [1], isActive: false });
    assert.equal(canPlanTeam(dead, routed), false);
  });
});

describe('holding and cancelling a project (brief §18)', () => {
  const allowed: Role[] = ['ceo', 'coo', 'sales', 'project_manager'];
  const denied: Role[] = ['admin', 'team_lead', 'executive'];
  for (const role of allowed) {
    test(`${role} may`, () => assert.equal(can(actor(role), 'projects.changeStatus'), true));
  }
  for (const role of denied) {
    test(`${role} may not`, () => assert.equal(can(actor(role), 'projects.changeStatus'), false));
  }
});

describe('editing what Sales filed (brief §3, §27)', () => {
  const allowed: Role[] = ['ceo', 'coo', 'sales', 'project_manager'];
  const denied: Role[] = ['admin', 'team_lead', 'executive'];
  for (const role of allowed) {
    test(`${role} may`, () => assert.equal(can(actor(role), 'projects.edit'), true));
  }
  for (const role of denied) {
    test(`${role} may not`, () => assert.equal(can(actor(role), 'projects.edit'), false));
  }
});

describe('individual cost rates are for the CEO and COO alone (brief §29)', () => {
  for (const role of ['ceo', 'coo'] as Role[]) {
    test(`${role} may`, () => assert.equal(can(actor(role), 'costs.manage'), true));
  }
  for (const role of ['admin', 'sales', 'project_manager', 'team_lead', 'executive'] as Role[]) {
    test(`${role} may not`, () => assert.equal(can(actor(role), 'costs.manage'), false));
  }
});

describe('the sales pipeline is Sales’ and management’s (brief §29)', () => {
  for (const role of ['ceo', 'coo', 'sales'] as Role[]) {
    test(`${role} may`, () => assert.equal(can(actor(role), 'pipeline.manage'), true));
  }
  for (const role of ['admin', 'project_manager', 'team_lead', 'executive'] as Role[]) {
    test(`${role} may not`, () => assert.equal(can(actor(role), 'pipeline.manage'), false));
  }
});

describe('invoices are Sales’ and management’s; billing settings management’s (brief §29)', () => {
  for (const role of ['ceo', 'coo', 'sales'] as Role[]) {
    test(`${role} may manage invoices`, () => assert.equal(can(actor(role), 'invoices.manage'), true));
  }
  for (const role of ['admin', 'project_manager', 'team_lead', 'executive', 'client'] as Role[]) {
    test(`${role} may not manage invoices`, () => assert.equal(can(actor(role), 'invoices.manage'), false));
  }
  test('only the CEO and COO configure billing', () => {
    assert.deepEqual((['ceo', 'coo', 'admin', 'sales'] as Role[]).filter((r) => can(actor(r), 'invoices.configure')), ['ceo', 'coo']);
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
