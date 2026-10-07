'use client';

import { useActionState } from 'react';
import { closeClientMonth, reopenClientMonth, type ClientFormState } from '../actions';

const initial: ClientFormState = {};
const button =
  'rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-background disabled:opacity-60';

/**
 * Close / reopen for one month (brief §36). The refusal a close can get —
 * "3 projects are still open: …" — is the useful part, so it renders right
 * under the button rather than as a redirect.
 */
export function MonthControls({
  clientMonthId, status, canClose, canReopen,
}: {
  clientMonthId: number;
  status: 'open' | 'closed';
  canClose: boolean;
  canReopen: boolean;
}) {
  const [closeState, closeAction, closing] = useActionState(closeClientMonth, initial);
  const [reopenState, reopenAction, reopening] = useActionState(reopenClientMonth, initial);

  if (status === 'open' && !canClose) return null;
  if (status === 'closed' && !canReopen) return null;

  // After a successful close or reopen the page revalidates and the other
  // form takes this one's place, so the notice is read from whichever
  // action last spoke rather than from the form now on screen.
  const state = {
    error: status === 'open' ? closeState.error : reopenState.error,
    notice: closeState.notice ?? reopenState.notice,
  };

  return (
    <div className="flex flex-col items-end gap-1">
      {status === 'open' ? (
        <form action={closeAction}>
          <input type="hidden" name="clientMonthId" value={clientMonthId} />
          <button type="submit" disabled={closing} className={button}>
            {closing ? 'Closing…' : 'Close month'}
          </button>
        </form>
      ) : (
        <form action={reopenAction}>
          <input type="hidden" name="clientMonthId" value={clientMonthId} />
          <button type="submit" disabled={reopening} className={button}>
            {reopening ? 'Reopening…' : 'Reopen month'}
          </button>
        </form>
      )}
      {state.error ? (
        <p role="alert" className="max-w-sm text-right text-xs text-red-600 dark:text-red-400">{state.error}</p>
      ) : null}
      {state.notice ? <p role="status" className="text-xs text-muted">{state.notice}</p> : null}
    </div>
  );
}
