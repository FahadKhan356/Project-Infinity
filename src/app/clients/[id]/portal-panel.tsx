'use client';

import { useActionState, useEffect, useRef } from 'react';
import {
  addPortalLogin, resetPortalLogin, toggleAutoDeliver, togglePortalLogin, type PortalFormState,
} from '../portal-actions';

const initial: PortalFormState = {};
const field =
  'mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent';

function Result({ state }: { state: PortalFormState }) {
  if (state.error) return <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{state.error}</p>;
  if (!state.notice) return null;
  return (
    <div role="status" className="mt-2 rounded-md bg-accent/10 px-3 py-2 text-sm">
      {state.notice}
      {state.temporaryPassword ? (
        <code className="ml-2 select-all rounded bg-background px-1.5 py-0.5 font-mono">{state.temporaryPassword}</code>
      ) : null}
    </div>
  );
}

interface Login { id: number; fullName: string; email: string; isActive: boolean; lastLoginAt: string | null }

function LoginRow({ login }: { login: Login }) {
  const [toggleState, toggleAction, toggling] = useActionState(togglePortalLogin, initial);
  const [resetState, resetAction, resetting] = useActionState(resetPortalLogin, initial);
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className={login.isActive ? '' : 'text-muted line-through'}>
          <span className="font-medium">{login.fullName}</span> <span className="text-xs text-muted">{login.email}</span>
        </span>
        <span className="flex items-center gap-3 text-xs">
          <span className="text-muted">{login.lastLoginAt ? `last in ${login.lastLoginAt}` : 'never signed in'}</span>
          {login.isActive ? (
            <form action={resetAction}>
              <input type="hidden" name="userId" value={login.id} />
              <button type="submit" disabled={resetting} className="text-muted hover:text-foreground">Reset password</button>
            </form>
          ) : null}
          <form action={toggleAction}>
            <input type="hidden" name="userId" value={login.id} />
            <input type="hidden" name="active" value={String(!login.isActive)} />
            <button type="submit" disabled={toggling} className="text-muted hover:text-foreground">
              {login.isActive ? 'Remove access' : 'Restore access'}
            </button>
          </form>
        </span>
      </div>
      <Result state={toggleState} />
      <Result state={resetState} />
    </li>
  );
}

/** Portal logins and delivery mode for one client (brief §29). */
export function PortalPanel({ clientId, logins, autoDeliver }: { clientId: number; logins: Login[]; autoDeliver: boolean }) {
  const [addState, addAction, adding] = useActionState(addPortalLogin, initial);
  const [autoState, autoAction, switching] = useActionState(toggleAutoDeliver, initial);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { if (addState.saved) form.current?.reset(); }, [addState.saved]);

  return (
    <section className="mt-8 rounded-lg border border-border bg-surface p-6">
      <h2 className="text-sm font-semibold">Client portal</h2>
      <p className="mt-1 max-w-prose text-xs text-muted">
        People at the client who can sign in to see their projects, download what was delivered, and approve it
        or ask for changes. They see nothing internal: no notes, comments, prices or unfinished work.
      </p>

      {logins.length === 0 ? (
        <p className="mt-3 text-sm text-muted">Nobody at this client has portal access yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border text-sm">
          {logins.map((l) => <LoginRow key={l.id} login={l} />)}
        </ul>
      )}

      <form ref={form} action={addAction} className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <input type="hidden" name="clientId" value={clientId} />
        <div>
          <label className="block text-xs font-medium" htmlFor="portal-name">Name</label>
          <input id="portal-name" name="fullName" required className={field} />
        </div>
        <div>
          <label className="block text-xs font-medium" htmlFor="portal-email">Email</label>
          <input id="portal-email" name="email" type="email" required className={field} />
        </div>
        <button type="submit" disabled={adding}
          className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
          {adding ? 'Creating…' : 'Give access'}
        </button>
      </form>
      <Result state={addState} />

      <form action={autoAction} className="mt-5 border-t border-border pt-4">
        <input type="hidden" name="clientId" value={clientId} />
        <input type="hidden" name="on" value={String(!autoDeliver)} />
        <p className="text-sm">
          {autoDeliver
            ? 'Files are delivered to the portal automatically as soon as they clear final QA.'
            : 'Sales delivers each approved file from the Deliveries page; it appears in the portal then.'}
        </p>
        <button type="submit" disabled={switching} className="mt-2 rounded-md border border-border px-3 py-1.5 text-sm">
          {autoDeliver ? 'Turn off automatic delivery' : 'Deliver automatically after QA'}
        </button>
        <Result state={autoState} />
      </form>
    </section>
  );
}
