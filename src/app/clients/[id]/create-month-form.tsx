'use client';

import { useActionState } from 'react';
import { createNextMonth, type ClientFormState } from '../actions';
import { Feedback } from './feedback';

const initial: ClientFormState = {};

/**
 * "+ Create October 2026" (brief §37): opens the month after the newest on
 * record, by hand, so a rep can plan ahead. It sits at the foot of the
 * Services card, and stands in for the current month's table when the
 * client has no open month at all (§35). The page picks the month.
 */
export function CreateMonthForm({ clientId, nextMonth: next, className }: {
  clientId: number;
  nextMonth: { year: number; month: number; label: string };
  className?: string;
}) {
  const [state, action, pending] = useActionState(createNextMonth, initial);
  return (
    <form action={action} className={className}>
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="year" value={next.year} />
      <input type="hidden" name="month" value={next.month} />
      <h3 className="text-sm font-semibold">Create new month</h3>
      <p className="mt-1 text-xs text-muted">
        Creates the {next.label} workspace without re-entering anything about the client.
        Filing a project for a month opens it automatically, so this is only needed to plan ahead.
      </p>
      <Feedback state={state} />
      <button type="submit" disabled={pending}
        className="mt-4 rounded-md border border-border px-3 py-2 text-sm font-medium disabled:opacity-60">
        {pending ? 'Creating…' : `+ Create ${next.label}`}
      </button>
    </form>
  );
}
