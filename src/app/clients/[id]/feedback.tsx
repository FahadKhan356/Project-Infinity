import type { ClientFormState } from '../actions';

/** The one-line result of a client-page form: its error, or its notice. */
export function Feedback({ state }: { state: ClientFormState }) {
  if (state.error) {
    return (
      <p role="alert" className="mt-4 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
        {state.error}
      </p>
    );
  }
  if (state.notice) {
    return <p role="status" className="mt-4 rounded-md bg-accent/10 px-3 py-2 text-sm">{state.notice}</p>;
  }
  return null;
}
