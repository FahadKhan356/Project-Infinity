'use client';

/**
 * Safety net. Authorization is normally handled by rendering AccessDenied, so
 * anything reaching here is a genuine fault — never a permissions decision.
 */
export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="flex min-h-svh items-center justify-center px-6 py-12">
      <div className="max-w-md rounded-lg border border-border bg-surface px-6 py-8">
        <h1 className="text-lg font-semibold tracking-tight">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted">
          The portal hit an unexpected error. Try again, and tell an administrator if it keeps
          happening.
        </p>
        <button
          onClick={reset}
          className="mt-6 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
