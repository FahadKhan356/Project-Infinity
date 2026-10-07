import Link from 'next/link';
import { requireClientActor } from '@/lib/auth/dal';
import { myChannelPrefs } from '@/lib/channels/prefs';
import { portalClientName } from '@/lib/portal/portal';
import { ChannelPrefForm } from '../../settings/channel-prefs-form';
import { PortalShell } from '../portal-shell';

/** A client chooses whether new files are also announced by email (brief §29). */
export default async function PortalSettingsPage() {
  const actor = await requireClientActor();
  const [prefs, clientName] = await Promise.all([myChannelPrefs(actor), portalClientName(actor)]);
  const email = prefs.find((p) => p.channel === 'email');
  return (
    <PortalShell actor={actor} clientName={clientName}>
      <Link href="/portal" className="text-sm text-muted hover:text-foreground">← All projects</Link>
      <h1 className="mt-2 text-lg font-semibold tracking-tight">Email alerts</h1>
      {email ? (
        <div className="mt-4 max-w-md">
          <p className="mb-3 text-sm text-muted">Get an email when a new file is ready for you to review.</p>
          <ChannelPrefForm pref={email} />
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted">Email alerts are not available yet. New files always appear here.</p>
      )}
    </PortalShell>
  );
}
