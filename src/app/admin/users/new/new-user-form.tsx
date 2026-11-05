'use client';

import { useActionState } from 'react';
import { createUser, type FormState } from '../actions';

const initial: FormState = {};
const field =
  'mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent';

export function NewUserForm() {
  const [state, formAction, pending] = useActionState(createUser, initial);

  return (
    <form action={formAction} className="rounded-lg border border-border bg-surface p-6">
      <label className="block text-sm font-medium" htmlFor="fullName">Name</label>
      <input id="fullName" name="fullName" required className={field} />

      <label className="mt-4 block text-sm font-medium" htmlFor="email">Email</label>
      <input id="email" name="email" type="email" required className={field} />

      <label className="mt-4 block text-sm font-medium" htmlFor="role">Role</label>
      <select id="role" name="role" required defaultValue="executive" className={field}>
        <option value="executive">Executive</option>
        <option value="team_lead">Team Lead</option>
        <option value="project_manager">Project Manager</option>
        <option value="sales">Sales</option>
        <option value="admin">Administrator</option>
        <option value="coo">Vice President</option>
        <option value="ceo">CEO</option>
      </select>

      <label className="mt-4 block text-sm font-medium" htmlFor="password">Temporary password</label>
      <input id="password" name="password" type="text" required minLength={12} className={field} />
      <p className="mt-1 text-xs text-muted">
        At least 12 characters, with letters and numbers. Hand it over directly.
      </p>

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

      <button type="submit" disabled={pending}
        className="mt-6 w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
        {pending ? 'Creating…' : 'Create user'}
      </button>
    </form>
  );
}
