import { redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { can, clientScope, projectScope, type Action } from '@/lib/authz';

/**
 * M1 dashboard. Deliberately thin — the real per-role dashboards are Phase 1b
 * (brief §21). What it does show is the policy layer working end to end: the
 * counts below are produced by composing projectScope()/clientScope(), which
 * is exactly how every list query in M3 onward must be written.
 */
export default async function DashboardPage() {
  const actor = await requireActor();
  // An Executive's primary page is their work list (brief §8).
  if (actor.role === 'executive') redirect('/work');
  const db = getDb();

  const [{ projects }] = await db.execute<{ projects: number }>(
    sql`SELECT count(*)::int AS projects FROM projects WHERE ${projectScope(actor)}`,
  );
  const [{ clients }] = await db.execute<{ clients: number }>(
    sql`SELECT count(*)::int AS clients FROM clients WHERE ${clientScope(actor)}`,
  );

  const capabilities: Action[] = [
    'projects.create', 'projects.triage', 'assignments.create',
    'qa.reviewAsTeamLead', 'qa.reviewAsProjectManager', 'delivery.manage',
    'pricing.view', 'users.manage',
  ];

  return (
    <AppShell actor={actor}>
      <h1 className="text-lg font-semibold tracking-tight">Dashboard</h1>
      <p className="mt-1 text-sm text-muted">
        Signed in as {actor.email}. Everything below is filtered by your permissions.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Stat label="Projects visible to you" value={projects} />
        <Stat label="Clients visible to you" value={clients} />
      </div>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">What you can do</h2>
        <ul className="mt-3 grid gap-1.5 text-sm sm:grid-cols-2">
          {capabilities.map((action) => (
            <li key={action} className="flex items-center gap-2">
              <span aria-hidden className={can(actor, action) ? 'text-accent' : 'text-muted'}>
                {can(actor, action) ? '●' : '○'}
              </span>
              <span className={can(actor, action) ? '' : 'text-muted'}>{action}</span>
            </li>
          ))}
        </ul>
      </section>

      <p className="mt-8 rounded-md border border-border bg-surface px-4 py-3 text-xs text-muted">
        M1 delivers authentication, roles and the policy layer. Project intake,
        planning, QA and delivery arrive in M3–M7.
      </p>
    </AppShell>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-muted">{label}</div>
    </div>
  );
}
