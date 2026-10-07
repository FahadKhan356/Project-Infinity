import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireActor } from '@/lib/auth/dal';
import { AccessDenied } from '@/components/access-denied';
import { AppShell } from '@/components/app-shell';
import { can } from '@/lib/authz';
import { MonthError } from '@/lib/months/lifecycle';
import { copyMonthPlan, copyTarget } from '@/lib/months/copy';
import { CopyMonthForm } from './copy-form';

export default async function CopyMonthPage(props: PageProps<'/clients/[id]/months/[monthId]/copy'>) {
  const actor = await requireActor();
  if (!can(actor, 'projects.create')) {
    return (
      <AppShell actor={actor}>
        <AccessDenied what="filing projects" />
      </AppShell>
    );
  }

  const { id, monthId } = await props.params;
  const clientId = Number(id);
  const fromMonthId = Number(monthId);
  if (!Number.isInteger(clientId) || !Number.isInteger(fromMonthId)) notFound();

  // A `?to=` that is not a month — the page's own field, on a browser that
  // renders type="month" as plain text, or a hand-edited URL — is shown as
  // the field's error over the default target, not answered with a 404.
  const { to } = await props.searchParams;
  const target = copyTarget(Array.isArray(to) ? to[0] : to);

  let plan;
  try {
    plan = await copyMonthPlan(actor, { clientId, fromMonthId, period: target.period });
  } catch (error) {
    // What is left: no such client, no such month.
    if (error instanceof MonthError) notFound();
    throw error;
  }

  return (
    <AppShell actor={actor}>
      <Link href={`/clients/${clientId}`} className="text-sm text-muted hover:text-foreground">
        ← {plan.clientName}
      </Link>
      <h1 className="mt-2 text-lg font-semibold tracking-tight">
        Copy {plan.source.label} → {plan.target.label}
      </h1>
      <p className="mt-1 max-w-prose text-sm text-muted">
        The order structure comes across — projects, teams, quantities, requirements, pricing and
        notes — and you can change any of it here. Files, deliverables and revisions stay in{' '}
        {plan.source.label}; nothing is delivered twice.
      </p>

      <div className="mt-6 max-w-3xl">
        <CopyMonthForm plan={plan} canSetPricing={can(actor, 'pricing.view')} monthError={target.error} />
      </div>
    </AppShell>
  );
}
