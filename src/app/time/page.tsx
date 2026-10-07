import Link from 'next/link';
import { requireActor } from '@/lib/auth/dal';
import { AppShell } from '@/components/app-shell';
import { BACKDATE_DAYS, loggableAssignments, myTimeEntries } from '@/lib/time/entries';
import { formatMinutes } from '@/lib/time/format';
import { DeleteEntryButton, LogTimeForm } from './time-forms';

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** My time (brief §29): log hours against your own assignments and see the last two weeks. */
export default async function TimePage() {
  const actor = await requireActor();
  const [assignments, entries] = await Promise.all([loggableAssignments(actor), myTimeEntries(actor, 14)]);
  const now = new Date();
  const today = isoDay(now);
  const minDate = isoDay(new Date(now.getTime() - BACKDATE_DAYS * 86_400_000));

  const days = new Map<string, typeof entries>();
  for (const e of entries) days.set(e.workDate, [...(days.get(e.workDate) ?? []), e]);
  const total = entries.reduce((sum, e) => sum + e.minutes, 0);

  return (
    <AppShell actor={actor}>
      <h1 className="text-lg font-semibold tracking-tight">My time</h1>
      <p className="mt-1 max-w-prose text-sm text-muted">
        Log the hours you spend on each assignment. Your Team Lead and the Project Manager see the
        totals in the productivity report. Entries can be dated up to {BACKDATE_DAYS} days back.
      </p>

      <div className="mt-6">
        <LogTimeForm
          today={today}
          minDate={minDate}
          assignments={assignments.map((a) => ({
            id: a.id, label: `${a.projectCode} · ${a.title} — ${a.clientName}`,
          }))}
        />
      </div>

      <section className="mt-8">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Last two weeks</h2>
          <span className="text-sm tabular-nums text-muted">{formatMinutes(total)} in total</span>
        </div>
        {entries.length === 0 ? (
          <p className="mt-3 rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">Nothing logged yet.</p>
        ) : (
          <div className="mt-3 space-y-3">
            {[...days.entries()].map(([day, list]) => (
              <div key={day} className="overflow-hidden rounded-lg border border-border bg-surface">
                <div className="flex justify-between border-b border-border px-4 py-2 text-xs font-medium">
                  <span>{new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}</span>
                  <span className="tabular-nums">{formatMinutes(list.reduce((s, e) => s + e.minutes, 0))}</span>
                </div>
                <ul className="divide-y divide-border text-sm">
                  {list.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2">
                      <span>
                        <Link href={`/projects/${e.projectId}`} className="font-mono text-xs hover:underline">{e.projectCode}</Link>
                        {' '}<span className="font-medium">{e.assignmentTitle}</span>
                        {e.note ? <span className="text-muted"> — {e.note}</span> : null}
                      </span>
                      <span className="flex items-baseline gap-3">
                        <span className="tabular-nums">{formatMinutes(e.minutes)}</span>
                        {e.monthClosed ? null : <DeleteEntryButton entryId={e.id} />}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </AppShell>
  );
}
