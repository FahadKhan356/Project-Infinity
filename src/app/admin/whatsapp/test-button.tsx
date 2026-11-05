'use client';

import { useActionState } from 'react';
import { sendTestAlert, type WhatsAppAdminState } from './actions';

const initial: WhatsAppAdminState = {};

export function WhatsAppTestButton() {
  const [state, formAction, pending] = useActionState(sendTestAlert, initial);

  return (
    <form action={formAction} className="mt-4">
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-emerald-500 disabled:opacity-60"
      >
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 10l4 4 8-8" />
        </svg>
        <span>{pending ? 'Sending test alert…' : 'Send Test WhatsApp Alert to CEO & Vice President'}</span>
      </button>

      {state.success ? (
        <div role="status" className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-400">
          {state.success}
        </div>
      ) : null}

      {state.error ? (
        <div role="alert" className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-400">
          {state.error}
        </div>
      ) : null}
    </form>
  );
}
