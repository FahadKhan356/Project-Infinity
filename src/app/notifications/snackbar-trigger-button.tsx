'use client';

import type { SnackbarNotice } from '@/components/header-shell-client';

export function SnackbarTriggerButton({
  notice,
  label = 'Pop up',
  className = '',
}: {
  notice: SnackbarNotice;
  label?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        window.dispatchEvent(new CustomEvent<SnackbarNotice>('aktivacity:show-snackbar', { detail: notice }));
      }}
      className={
        className ||
        'inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:border-accent/40 hover:text-accent'
      }
    >
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M10 3a4.5 4.5 0 00-4.5 4.5v2.6c0 .6-.2 1.2-.6 1.6L3.8 13h12.4l-1.1-1.3c-.4-.4-.6-1-.6-1.6V7.5A4.5 4.5 0 0010 3zm-1.8 12.5a1.8 1.8 0 003.6 0" />
      </svg>
      <span>{label}</span>
    </button>
  );
}

