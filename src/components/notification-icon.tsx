import type { NotificationStyle } from './notification-meta';

export function NotificationIcon({
  kind,
  className = 'h-4 w-4',
}: {
  kind: NotificationStyle['iconKind'];
  className?: string;
}) {
  switch (kind) {
    case 'check':
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5l3.5 3.5 7.5-7.5" />
        </svg>
      );
    case 'x':
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l8 8M14 6l-8 8" />
        </svg>
      );
    case 'alert':
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M10 6.5v4m0 3h.01M3.6 15.5h12.8c1.1 0 1.8-1.2 1.2-2.1L11.2 3.2c-.6-.9-1.8-.9-2.4 0L2.4 13.4c-.6.9.1 2.1 1.2 2.1z" />
        </svg>
      );
    case 'route':
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h8.5a3.5 3.5 0 110 7H6m0 0l2.5-2.5M6 13l2.5 2.5" />
        </svg>
      );
    case 'upload':
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M10 13V4m0 0L6.5 7.5M10 4l3.5 3.5M4 15.5h12" />
        </svg>
      );
    case 'task':
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
          <rect x="3.5" y="3.5" width="13" height="13" rx="2.5" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M7 10l2 2 4-4" />
        </svg>
      );
    case 'revision':
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 9.5a5.5 5.5 0 019.3-3.9L15.5 7M15.5 3.5V7H12M15.5 10.5a5.5 5.5 0 01-9.3 3.9L4.5 13M4.5 16.5V13H8" />
        </svg>
      );
    case 'comment':
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 5.5A1.5 1.5 0 015.5 4h9A1.5 1.5 0 0116 5.5v6a1.5 1.5 0 01-1.5 1.5H8l-3.5 3v-3H5.5A1.5 1.5 0 014 11.5v-6z" />
        </svg>
      );
    case 'clock':
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
          <circle cx="10" cy="10" r="6.5" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M10 6.5V10l2.5 1.5" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 6A1.5 1.5 0 015 4.5h3.2l1.6 1.8H15A1.5 1.5 0 0116.5 7.8v6.7A1.5 1.5 0 0115 16H5a1.5 1.5 0 01-1.5-1.5V6z" />
        </svg>
      );
  }
}

