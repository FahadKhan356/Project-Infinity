export function AccessDenied({ what }: { what?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-6 py-8">
      <h1 className="text-lg font-semibold tracking-tight">You do not have access</h1>
      <p className="mt-2 max-w-prose text-sm text-muted">
        {what
          ? `Your role does not include ${what}.`
          : 'Your role does not include this part of the portal.'}{' '}
        If you believe this is wrong, ask an administrator to review your permissions.
      </p>
    </div>
  );
}
