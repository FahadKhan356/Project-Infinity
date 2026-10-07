'use client';

import { useActionState } from 'react';
import { summariseProject, type SummaryState } from './summary-actions';

const initial: SummaryState = {};

export function SummaryButton({ projectId, hasSummary }: { projectId: number; hasSummary: boolean }) {
  const [state, action, pending] = useActionState(summariseProject, initial);
  return (
    <form action={action}>
      <input type="hidden" name="projectId" value={projectId} />
      <button type="submit" disabled={pending}
        className="rounded-md border border-border px-2.5 py-1 text-xs disabled:opacity-60">
        {pending ? 'Summarising…' : hasSummary ? 'Refresh summary' : 'Summarise with AI'}
      </button>
      {state.error ? <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{state.error}</p> : null}
    </form>
  );
}
