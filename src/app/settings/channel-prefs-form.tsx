'use client';

import { useActionState } from 'react';
import { saveChannelPref, type PrefState } from './actions';

const initial: PrefState = {};
const LABELS = {
  email: { name: 'Email', field: 'Send to', placeholder: 'your login address', hint: 'Leave blank to use the address you sign in with.' },
  slack: { name: 'Slack', field: 'Slack member ID', placeholder: 'U0123ABCD', hint: 'In Slack: your profile → ⋮ → Copy member ID.' },
  whatsapp: { name: 'WhatsApp', field: 'WhatsApp number', placeholder: '+971501234567', hint: 'International format, with the country code.' },
} as const;

export function ChannelPrefForm({ pref }: {
  pref: { channel: 'email' | 'slack' | 'whatsapp'; enabled: boolean; address: string | null; lastError: string | null };
}) {
  const [state, action, pending] = useActionState(saveChannelPref, initial);
  const l = LABELS[pref.channel];
  return (
    <form action={action} className="rounded-lg border border-border bg-surface p-4">
      <input type="hidden" name="channel" value={pref.channel} />
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" name="enabled" defaultChecked={pref.enabled} />
        {l.name}
      </label>
      <label className="mt-3 block text-xs font-medium" htmlFor={`addr-${pref.channel}`}>{l.field}</label>
      <input id={`addr-${pref.channel}`} name="address" defaultValue={pref.address ?? ''} placeholder={l.placeholder}
        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent" />
      <p className="mt-1 text-xs text-muted">{l.hint}</p>
      {pref.lastError ? (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">Last attempt failed: {pref.lastError}</p>
      ) : null}
      {state.error ? <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{state.error}</p>
        : state.notice ? <p role="status" className="mt-2 text-sm text-muted">{state.notice}</p> : null}
      <button type="submit" disabled={pending}
        className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-60">
        {pending ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}
