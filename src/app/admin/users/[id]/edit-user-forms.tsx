'use client';

import { useActionState } from 'react';
import { RESTRICTION_KEYS, grantablePermissions } from '@/lib/authz/can';
import type { Permission, Role } from '@/lib/authz/types';
import {
  resetPassword,
  setDepartments,
  setPermissions,
  updateUser,
  type FormState,
} from '../actions';

const initial: FormState = {};
const field =
  'mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent';
const card = 'rounded-lg border border-border bg-surface p-6';

interface Props {
  canManage: boolean;
  isSelf: boolean;
  user: { id: number; fullName: string; role: string; isActive: boolean };
  memberships: { departmentId: number; isLead: boolean }[];
  grants: string[];
  departments: { id: number; name: string; isProduction: boolean }[];
}

const PERMISSION_LABELS: Record<Permission, string> = {
  view_pricing: 'See project pricing',
  manage_users: 'Manage users',
  close_month: 'Close a client month',
  reopen_month: 'Reopen a closed month',
  delete_files: 'Delete files',
  export_reports: 'Export reports',
  view_all_clients: 'See all clients, not only their own',
  no_download: 'Cannot download files (view and preview in the portal only)',
};

function Feedback({ state }: { state: FormState }) {
  return (
    <>
      {state.error ? (
        <p role="alert" className="mt-4 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      {state.notice ? (
        <p role="status" className="mt-4 rounded-md bg-accent/10 px-3 py-2 text-sm">
          {state.notice}
        </p>
      ) : null}
      {state.temporaryPassword ? (
        <p className="mt-2 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm">
          {state.temporaryPassword}
        </p>
      ) : null}
    </>
  );
}

export function EditUserForms({ canManage, isSelf, user, memberships, grants: held, departments }: Props) {
  const grantable = grantablePermissions(user.role as Role);
  // What a row adds, and what it takes away (§43), listed apart; both are
  // rows of user_permissions and travel in the same form.
  const grants = grantable.filter((key) => !RESTRICTION_KEYS.has(key));
  const restrictions = grantable.filter((key) => RESTRICTION_KEYS.has(key));
  const [detailState, detailAction, detailPending] = useActionState(updateUser, initial);
  const [deptState, deptAction, deptPending] = useActionState(setDepartments, initial);
  const [permState, permAction, permPending] = useActionState(setPermissions, initial);
  const [resetState, resetAction, resetPending] = useActionState(resetPassword, initial);

  const memberOf = new Set(memberships.map((m) => m.departmentId));
  const leadOf = new Set(memberships.filter((m) => m.isLead).map((m) => m.departmentId));

  if (!canManage) {
    return (
      <p className="mt-6 rounded-md border border-border bg-surface px-4 py-3 text-sm text-muted">
        You can view this account but not change it.
      </p>
    );
  }

  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-2">
      <section className={card}>
        <h2 className="text-sm font-semibold">Account</h2>
        <form action={detailAction} className="mt-4">
          <input type="hidden" name="userId" value={user.id} />

          <label className="block text-sm font-medium" htmlFor="fullName">Name</label>
          <input id="fullName" name="fullName" defaultValue={user.fullName} required className={field} />

          <label className="mt-4 block text-sm font-medium" htmlFor="role">Role</label>
          <select id="role" name="role" defaultValue={user.role} disabled={isSelf} className={field}>
            <option value="executive">Executive</option>
            <option value="team_lead">Team Lead</option>
            <option value="project_manager">Project Manager</option>
            <option value="sales">Sales</option>
            <option value="admin">Administrator</option>
            <option value="coo">Vice President</option>
            <option value="ceo">CEO</option>
          </select>
          {isSelf ? (
            <p className="mt-1 text-xs text-muted">You cannot change your own role or status.</p>
          ) : null}

          <label className="mt-4 flex items-center gap-2 text-sm">
            <input type="checkbox" name="isActive" defaultChecked={user.isActive} disabled={isSelf} />
            Active
          </label>

          <Feedback state={detailState} />

          <button type="submit" disabled={detailPending}
            className="mt-6 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
            {detailPending ? 'Saving…' : 'Save'}
          </button>
        </form>
      </section>

      <section className={card}>
        <h2 className="text-sm font-semibold">Teams</h2>
        <p className="mt-1 text-xs text-muted">
          Leading a team implies belonging to it. A Team Lead may cover more than one.
        </p>
        <form action={deptAction} className="mt-4">
          <input type="hidden" name="userId" value={user.id} />
          <ul className="space-y-2">
            {departments.filter((d) => d.isProduction).map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="department" value={d.id} defaultChecked={memberOf.has(d.id)} />
                  {d.name}
                </label>
                <label className="flex items-center gap-2 text-xs text-muted">
                  <input type="checkbox" name="lead" value={d.id} defaultChecked={leadOf.has(d.id)} />
                  lead
                </label>
              </li>
            ))}
          </ul>

          <Feedback state={deptState} />

          <button type="submit" disabled={deptPending}
            className="mt-6 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
            {deptPending ? 'Saving…' : 'Save teams'}
          </button>
        </form>
      </section>

      <section className={card}>
        <h2 className="text-sm font-semibold">Extra permissions</h2>
        <p className="mt-1 text-xs text-muted">
          Granted on top of the role. This is how a Team Lead is authorised to see pricing (brief §23).
        </p>
        <form action={permAction} className="mt-4">
          <input type="hidden" name="userId" value={user.id} />
          <ul className="space-y-2">
            {grants.map((key) => (
              <li key={key}>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="permission" value={key} defaultChecked={held.includes(key)} />
                  {PERMISSION_LABELS[key]}
                </label>
              </li>
            ))}
          </ul>
          {grants.length === 0 ? (
            <p className="mt-2 text-xs text-muted">
              {user.role === 'executive'
                ? 'An Executive holds no extra permissions: their access is their own assignments only (brief §23).'
                : 'This role already holds everything a grant could add.'}
            </p>
          ) : null}
          {restrictions.length > 0 ? (
            <>
              <h3 className="mt-5 text-sm font-semibold">Restrictions</h3>
              <p className="mt-1 text-xs text-muted">
                Taken away from the role. A restricted account still sees and previews the files it may see (brief §43).
              </p>
              <ul className="mt-3 space-y-2">
                {restrictions.map((key) => (
                  <li key={key}>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="permission" value={key} defaultChecked={held.includes(key)} />
                      {PERMISSION_LABELS[key]}
                    </label>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <Feedback state={permState} />

          <button type="submit" disabled={permPending}
            className="mt-6 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
            {permPending ? 'Saving…' : 'Save permissions'}
          </button>
        </form>
      </section>

      <section className={card}>
        <h2 className="text-sm font-semibold">Password</h2>
        <p className="mt-1 text-xs text-muted">
          Generates a temporary password, ends all their sessions, and forces a change at next login.
        </p>
        <form action={resetAction} className="mt-4">
          <input type="hidden" name="userId" value={user.id} />
          <Feedback state={resetState} />
          <button type="submit" disabled={resetPending}
            className="mt-4 rounded-md border border-border px-3 py-2 text-sm font-medium disabled:opacity-60">
            {resetPending ? 'Resetting…' : 'Reset password'}
          </button>
        </form>
      </section>
    </div>
  );
}
