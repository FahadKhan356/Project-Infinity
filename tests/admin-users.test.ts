/**
 * Saving an account on /admin/users/[id] (brief §28). On your own account
 * the form disables Role and Active, and a browser does not submit disabled
 * fields, so the save must keep what is stored rather than refuse or
 * deactivate: an administrator can rename themselves, but cannot demote or
 * deactivate themselves. No database.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ROLES, resolveAccountFields } from '../src/app/admin/users/account-fields';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  data.set('userId', '7');
  data.set('fullName', 'Renamed');
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const admin = { role: 'admin' as const, isActive: true };

describe('saving an account', () => {
  test('your own: role and status stay as stored when the form leaves them out', () => {
    assert.deepEqual(resolveAccountFields(true, admin, form({})), { role: 'admin', isActive: true });
  });

  test('your own: a crafted role or a missing Active tick changes nothing', () => {
    assert.deepEqual(resolveAccountFields(true, admin, form({ role: 'executive' })),
      { role: 'admin', isActive: true });
    assert.deepEqual(resolveAccountFields(true, { role: 'ceo', isActive: true }, form({ role: 'sales', isActive: 'on' })),
      { role: 'ceo', isActive: true });
  });

  test('someone else: the submitted role and status are used', () => {
    assert.deepEqual(resolveAccountFields(false, admin, form({ role: 'sales', isActive: 'on' })),
      { role: 'sales', isActive: true });
    // An unticked checkbox is not submitted at all: that is a deactivation.
    assert.deepEqual(resolveAccountFields(false, admin, form({ role: 'team_lead' })),
      { role: 'team_lead', isActive: false });
  });

  test('someone else: a missing or unknown role is refused', () => {
    assert.deepEqual(resolveAccountFields(false, admin, form({})), { error: 'Choose a role.' });
    assert.deepEqual(resolveAccountFields(false, admin, form({ role: 'superuser' })), { error: 'Choose a role.' });
    // Client portal logins are managed from the client's page, not here.
    assert.deepEqual(resolveAccountFields(false, admin, form({ role: 'client' })), { error: 'Choose a role.' });
    assert.ok(!ROLES.includes('client'));
  });
});
