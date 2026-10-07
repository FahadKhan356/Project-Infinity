import Link from 'next/link';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { myChannelPrefs } from '@/lib/channels/prefs';
import { ChannelPrefForm } from '../channel-prefs-form';

/** Where one's notifications go besides the inbox (brief §29). */
export default async function NotificationSettingsPage() {
  const actor = await requireActor();
  const prefs = await myChannelPrefs(actor);
  return (
    <AppShell actor={actor}>
      <Link href="/notifications" className="text-sm text-muted hover:text-foreground">← Inbox</Link>
      <h1 className="mt-2 text-lg font-semibold tracking-tight">Notification settings</h1>
      <p className="mt-1 max-w-prose text-sm text-muted">
        Everything always arrives in your inbox here. You can also have a copy sent to you elsewhere.
      </p>
      {prefs.length === 0 ? (
        <p className="mt-6 rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">
          No outside channels are connected. An administrator can connect email, Slack or WhatsApp
          (see the runbook); until then the inbox is the only channel.
        </p>
      ) : (
        <div className="mt-6 grid max-w-3xl gap-4 sm:grid-cols-2">
          {prefs.map((p) => <ChannelPrefForm key={p.channel} pref={p} />)}
        </div>
      )}
    </AppShell>
  );
}
