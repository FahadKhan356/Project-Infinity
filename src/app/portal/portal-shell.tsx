import Link from 'next/link';
import type { Actor } from '@/lib/authz';

/**
 * The client portal's own frame (brief §29). Deliberately not AppShell: a
 * client sees none of the internal navigation, not even as dead links.
 */
export function PortalShell({ actor, clientName, children }: {
  actor: Actor;
  clientName: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <Link href="/portal" className="text-sm font-semibold tracking-tight">
            Aktivacity <span className="font-normal text-muted">· {clientName}</span>
          </Link>
          <div className="ml-auto flex items-center gap-4 text-sm">
            <span className="hidden text-muted sm:inline">{actor.fullName}</span>
            <Link href="/portal/invoices" className="text-muted hover:text-foreground">Invoices</Link>
            <Link href="/portal/settings" className="text-muted hover:text-foreground">Alerts</Link>
            <Link href="/change-password" className="text-muted hover:text-foreground">Password</Link>
            <form action="/logout" method="post">
              <button type="submit" className="text-muted hover:text-foreground hover:underline">Sign out</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
