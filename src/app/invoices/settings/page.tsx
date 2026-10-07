import Link from 'next/link';
import { requireActor } from '@/lib/auth/dal';
import { AccessDenied } from '@/components/access-denied';
import { AppShell } from '@/components/app-shell';
import { can } from '@/lib/authz';
import { billingSettings } from '@/lib/invoices/invoices';
import { SettingsForm } from '../invoice-forms';

export default async function BillingSettingsPage() {
  const actor = await requireActor();
  if (!can(actor, 'invoices.configure')) return <AppShell actor={actor}><AccessDenied what="billing settings" /></AppShell>;
  return (
    <AppShell actor={actor}>
      <Link href="/invoices" className="text-sm text-muted hover:text-foreground">← Invoices</Link>
      <h1 className="mt-2 mb-4 text-lg font-semibold tracking-tight">Billing settings</h1>
      <SettingsForm s={await billingSettings()} />
    </AppShell>
  );
}
