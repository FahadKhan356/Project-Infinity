import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { requireActor } from '@/lib/auth/dal';
import { AccessDenied } from '@/components/access-denied';
import { AppShell } from '@/components/app-shell';
import { can, clientScope } from '@/lib/authz';
import { formatMoney } from '@/lib/projects/intake';
import {
  OPEN_STAGES, STAGE_LABELS, STAGE_PROBABILITY, canUsePipeline, listOpportunities, stageTotals,
} from '@/lib/pipeline/opportunities';
import { CardControls, NewOpportunityForm } from './pipeline-forms';

/**
 * Sales pipeline (brief §29): unconfirmed work by stage, with a weighted
 * forecast. Winning a deal is filing its project, which keeps one record
 * from the first conversation to the delivered file.
 */
export default async function PipelinePage() {
  const actor = await requireActor();
  if (!canUsePipeline(actor)) {
    return <AppShell actor={actor}><AccessDenied what="the sales pipeline" /></AppShell>;
  }

  const [list, clients] = await Promise.all([
    listOpportunities(actor),
    getDb().execute<{ id: number; name: string; status: string }>(sql`
      SELECT c.id, c.name, c.status::text AS status FROM clients c
      WHERE ${clientScope(actor, 'c')} AND c.status <> 'churned' ORDER BY c.name
    `),
  ]);
  const totals = stageTotals(list);
  const currency = list.find((o) => o.estimatedValue !== null)?.currency ?? 'AED';
  const mixed = new Set(list.filter((o) => o.estimatedValue !== null).map((o) => o.currency)).size > 1;
  const weighted = totals.reduce((s, t) => s + t.weighted, 0);
  const openValue = totals.reduce((s, t) => s + t.value, 0);
  const closed = list.filter((o) => o.stage === 'won' || o.stage === 'lost');
  const canFile = can(actor, 'projects.create');

  return (
    <AppShell actor={actor}>
      <h1 className="text-lg font-semibold tracking-tight">Sales pipeline</h1>
      <p className="mt-1 max-w-prose text-sm text-muted">
        Work being discussed but not yet confirmed. When a deal is won, file its project from the card:
        the project is filed against the same client, and the deal is marked won.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <Tile label="Open deals" value={String(totals.reduce((s, t) => s + t.count, 0))} />
        <Tile label="Open value" value={mixed ? 'mixed currencies' : formatMoney(openValue, currency)} />
        <Tile label="Weighted forecast" value={mixed ? 'mixed currencies' : formatMoney(weighted, currency)}
          hint="Each deal's value × its stage's likelihood" />
      </div>

      <div className="mt-6">
        <NewOpportunityForm
          canCreateClients={can(actor, 'clients.manage')}
          clients={clients.map((c) => ({
            id: Number(c.id), label: c.status === 'prospect' ? `${c.name} (prospect)` : c.name,
          }))}
        />
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {OPEN_STAGES.map((stage) => {
          const t = totals.find((x) => x.stage === stage)!;
          const cards = list.filter((o) => o.stage === stage);
          return (
            <section key={stage} className="rounded-lg border border-border bg-surface">
              <header className="border-b border-border px-3 py-2.5">
                <div className="flex items-baseline justify-between">
                  <h2 className="text-sm font-semibold">{STAGE_LABELS[stage]}</h2>
                  <span className="text-xs text-muted">{t.count} · {Math.round(STAGE_PROBABILITY[stage] * 100)}%</span>
                </div>
                <div className="text-xs tabular-nums text-muted">{mixed ? '' : formatMoney(t.value, currency)}</div>
              </header>
              <ul className="space-y-2 p-2">
                {cards.length === 0 ? <li className="px-1 py-2 text-xs text-muted">Nothing here.</li> : null}
                {cards.map((o) => (
                  <li key={o.id} className="rounded-md border border-border bg-background p-2.5 text-sm">
                    <div className="font-medium">{o.title}</div>
                    <Link href={`/clients/${o.clientId}`} className="text-xs text-muted hover:underline">
                      {o.clientName}{o.clientStatus === 'prospect' ? ' · prospect' : ''}
                    </Link>
                    <div className="mt-1 flex flex-wrap justify-between gap-x-2 text-xs">
                      <span className="tabular-nums">{o.estimatedValue === null ? 'no value yet' : formatMoney(o.estimatedValue, o.currency)}</span>
                      <span className={o.overdue ? 'text-red-600 dark:text-red-400' : 'text-muted'}>
                        {o.expectedClose ? `${o.overdue ? 'was due' : 'closes'} ${o.expectedClose}` : 'no date'}
                      </span>
                    </div>
                    {o.notes ? <p className="mt-1 text-xs text-muted">{o.notes}</p> : null}
                    <div className="mt-1 text-xs text-muted">{o.owner}</div>
                    <CardControls canFile={canFile} opportunity={o} />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Closed in the last month</h2>
        {closed.length === 0 ? (
          <p className="mt-3 rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">Nothing won or lost recently.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-surface text-sm">
            {closed.map((o) => (
              <li key={o.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5">
                <span>
                  <span className={`mr-2 rounded px-1.5 py-0.5 text-xs ${o.stage === 'won'
                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-red-500/10 text-red-600 dark:text-red-400'}`}>
                    {STAGE_LABELS[o.stage]}
                  </span>
                  <span className="font-medium">{o.title}</span>
                  <span className="text-muted"> — {o.clientName}</span>
                  {o.stage === 'won' && o.wonProjectId ? (
                    <> · <Link href={`/projects/${o.wonProjectId}`} className="font-mono text-xs hover:underline">{o.wonProjectCode}</Link></>
                  ) : null}
                  {o.stage === 'lost' && o.lostReason ? <span className="text-muted"> · {o.lostReason}</span> : null}
                </span>
                <span className="text-xs tabular-nums text-muted">
                  {o.estimatedValue === null ? '' : `${formatMoney(o.estimatedValue, o.currency)} · `}{o.closedAt}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </AppShell>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3" title={hint}>
      <div className="text-sm font-medium tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-muted">{label}</div>
    </div>
  );
}
