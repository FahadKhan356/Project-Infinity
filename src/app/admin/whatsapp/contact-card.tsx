'use client';

import { useActionState, useState } from 'react';
import { saveExecutiveContact, removeExecutiveContact, WhatsAppAdminState } from './actions';
import type { ExecutiveContact } from '@/lib/whatsapp/executive-alerts';

interface ContactCardProps {
  contact: ExecutiveContact;
}

export function ContactCard({ contact }: ContactCardProps) {
  const [state, formAction, isPending] = useActionState<WhatsAppAdminState, FormData>(
    saveExecutiveContact,
    {},
  );
  const [removeState, removeAction, isRemoving] = useActionState<WhatsAppAdminState, FormData>(
    removeExecutiveContact,
    {},
  );

  const [phone, setPhone] = useState(contact.phone || '');
  const [enabled, setEnabled] = useState(contact.enabled);

  const roleColors: Record<string, string> = {
    ceo: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
    coo: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
    admin: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    project_manager: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  };

  const badgeClass = roleColors[contact.role] || 'bg-accent/15 text-accent border-accent/30';

  return (
    <div className="rounded-xl border border-border/80 bg-background/50 p-4 transition-all">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface border border-border/80 text-sm font-bold text-foreground shadow-2xs">
            {contact.fullName
              .split(' ')
              .map((n) => n[0])
              .join('')
              .slice(0, 2)
              .toUpperCase()}
          </span>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground">{contact.fullName}</span>
              <span className={`rounded-full border px-2 py-0.2 text-[10px] font-bold uppercase tracking-wider ${badgeClass}`}>
                {contact.role.replace('_', ' ')}
              </span>
              {contact.source === 'env' && (
                <span className="rounded bg-surface px-1.5 py-0.2 font-mono text-[9px] text-muted border border-border/60">
                  via .env
                </span>
              )}
            </div>
            <div className="text-xs text-muted">{contact.email}</div>
          </div>
        </div>

        {/* Status indicator */}
        <div className="flex items-center gap-2">
          {contact.enabled && contact.phone ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Active Recipient
            </span>
          ) : contact.phone ? (
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-medium text-amber-400">
              Alerts Paused
            </span>
          ) : (
            <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-0.5 text-[11px] font-medium text-red-400">
              No Number Set
            </span>
          )}
        </div>
      </div>

      {/* Interactive Edit Form */}
      <form action={formAction} className="mt-4 pt-3 border-t border-border/60">
        <input type="hidden" name="userId" value={contact.userId} />

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <input
              type="text"
              name="phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+923001234567"
              className="w-full rounded-lg border border-border/80 bg-surface/80 px-3 py-1.5 font-mono text-xs text-foreground placeholder:text-muted/50 focus:border-accent focus:outline-none"
            />
          </div>

          <label className="flex items-center gap-2 text-xs text-foreground select-none cursor-pointer">
            <input
              type="checkbox"
              name="enabled"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-border/80 bg-surface text-accent focus:ring-accent"
            />
            <span>Enabled</span>
          </label>

          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={isPending}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground shadow-2xs hover:bg-accent/90 disabled:opacity-50 transition-colors"
            >
              {isPending ? 'Saving...' : 'Save Number'}
            </button>

            {contact.phone && (
              <button
                type="submit"
                formAction={removeAction}
                disabled={isRemoving}
                className="rounded-lg border border-border/80 bg-surface/50 px-2.5 py-1.5 text-xs text-muted hover:text-red-400 hover:border-red-500/40 transition-colors"
                title="Pause alerts for this user"
              >
                {isRemoving ? '...' : 'Pause'}
              </button>
            )}
          </div>
        </div>

        {/* Feedback message */}
        {state.success && (
          <p className="mt-2 text-xs font-medium text-emerald-400 animate-fade-in">
            ✓ {state.success}
          </p>
        )}
        {state.error && (
          <p className="mt-2 text-xs font-medium text-red-400 animate-fade-in">
            ✕ {state.error}
          </p>
        )}
        {removeState.success && (
          <p className="mt-2 text-xs font-medium text-amber-400 animate-fade-in">
            ✓ {removeState.success}
          </p>
        )}
      </form>
    </div>
  );
}

interface AddRecipientFormProps {
  availableUsers: { id: number; full_name: string; role: string; email: string }[];
}

export function AddRecipientForm({ availableUsers }: AddRecipientFormProps) {
  const [state, formAction, isPending] = useActionState<WhatsAppAdminState, FormData>(
    saveExecutiveContact,
    {},
  );

  return (
    <div className="rounded-xl border border-dashed border-border/80 bg-surface/30 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
        Add Another Team Member to WhatsApp Alerts
      </h3>
      <p className="mt-0.5 text-xs text-muted">
        Assign any team lead, PM, or manager to receive real-time operational WhatsApp alerts.
      </p>

      <form action={formAction} className="mt-3 grid gap-3 sm:grid-cols-3">
        <select
          name="userId"
          required
          className="rounded-lg border border-border/80 bg-background px-3 py-1.5 text-xs text-foreground focus:border-accent focus:outline-none"
        >
          <option value="">Select team member...</option>
          {availableUsers.map((u) => (
            <option key={u.id} value={u.id}>
              {u.full_name} ({u.role}) — {u.email}
            </option>
          ))}
        </select>

        <input
          type="text"
          name="phone"
          required
          placeholder="WhatsApp phone (e.g. +923001234567)"
          className="rounded-lg border border-border/80 bg-background px-3 py-1.5 font-mono text-xs text-foreground placeholder:text-muted/50 focus:border-accent focus:outline-none"
        />

        <div className="flex items-center gap-2">
          <input type="hidden" name="enabled" value="true" />
          <button
            type="submit"
            disabled={isPending}
            className="w-full rounded-lg bg-surface border border-border/80 px-4 py-1.5 text-xs font-semibold text-foreground hover:bg-background transition-colors disabled:opacity-50"
          >
            {isPending ? 'Adding...' : '+ Add to Alerts'}
          </button>
        </div>

        {state.success && (
          <p className="col-span-full text-xs font-medium text-emerald-400">
            ✓ {state.success}
          </p>
        )}
        {state.error && (
          <p className="col-span-full text-xs font-medium text-red-400">
            ✕ {state.error}
          </p>
        )}
      </form>
    </div>
  );
}

