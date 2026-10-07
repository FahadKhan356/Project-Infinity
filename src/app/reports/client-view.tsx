import { Fragment } from 'react';
import Link from 'next/link';
import { formatMoney } from '@/lib/projects/intake';
import type {
  BucketCounts, ClientReport, DepartmentRow, OrderValue, ReportDeliverable, ReportVersion,
} from '@/lib/reports/monthly';
import { formatBytes, formatDateTime, statusLabel } from '@/lib/workspace/format';
import { FileLink } from '@/components/files/file-link';

export const th = 'px-4 py-2.5 font-medium';
export const thNum = 'px-4 py-2.5 font-medium text-right';
export const td = 'px-4 py-2.5';
export const tdNum = 'px-4 py-2.5 text-right tabular-nums';

export function money(value: OrderValue | null): string {
  return value ? formatMoney(value.amount, value.currency) : '—';
}

/**
 * One client's month, as the report page and the client's own month page
 * both show it (§33, §36): the same loader, the same sections, so what a
 * Sales rep reads on /reports is what a Team Lead reads under the client.
 */
export function ClientView({ report }: { report: ClientReport }) {
  const { headline, showPricing, canDownload } = report;
  const slotsByProject = new Map<number, ReportDeliverable[]>();
  for (const d of report.deliverables) {
    const list = slotsByProject.get(d.projectId) ?? [];
    list.push(d);
    slotsByProject.set(d.projectId, list);
  }
  return (
    <>
      <p className="mt-4 text-sm text-muted">
        {report.month
          ? `Month ${report.month.status === 'closed' ? 'closed' : 'open'}.`
          : 'No month has been opened for this client in this period.'}
        {headline.departments.length > 0 ? ` Departments involved: ${headline.departments.join(', ')}.` : null}
      </p>
      <Headline counts={headline} />

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Projects</h2>
        {report.projects.length === 0 ? (
          <p className="mt-3 rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">
            No projects you can see in this month.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className={th}>Project</th>
                  <th className={th}>Status</th>
                  <th className={th}>Teams</th>
                  <th className={thNum}>Approved</th>
                  <th className={th}>Deadline</th>
                  <th className={th}>Delivered</th>
                  <th className={thNum}>Comments</th>
                  {showPricing ? <th className={thNum}>Value</th> : null}
                </tr>
              </thead>
              <tbody>
                {report.projects.map((p) => (
                  <tr key={p.id} className="border-b border-border last:border-0">
                    <td className={td}>
                      <Link href={`/projects/${p.id}`} className="font-medium hover:underline">{p.title}</Link>
                      <div className="font-mono text-xs text-muted">{p.projectCode}</div>
                    </td>
                    <td className={`${td} capitalize`}>{statusLabel(p.status)}</td>
                    <td className={`${td} text-muted`}>{p.teams ?? '—'}</td>
                    <td className={tdNum}>{p.approved}/{p.total}</td>
                    <td className={`${td} text-muted`}>{p.deadline ?? '—'}</td>
                    <td className={`${td} text-muted`}>{p.deliveredOn ?? '—'}</td>
                    <td className={tdNum}>
                      {p.comments > 0 ? (
                        <Link href={`/projects/${p.id}`} className="hover:underline">{p.comments}</Link>
                      ) : '—'}
                    </td>
                    {showPricing ? <td className={tdNum}>{money(p.value)}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* §33: every slot of the month's projects with every version and its
          QA history — the archive, not only what was approved. A file is
          linked only where the loader left a downloadUrl, which is where the
          download route would serve it. */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold">Deliverables</h2>
        {report.projects.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No deliverables in this month.</p>
        ) : (
          report.projects.map((p) => {
            const slots = slotsByProject.get(p.id) ?? [];
            return (
              <div key={p.id} className="mt-4">
                <h3 className="text-sm">
                  <Link href={`/projects/${p.id}`} className="font-medium hover:underline">{p.title}</Link>
                  <span className="ml-2 font-mono text-xs text-muted">{p.projectCode}</span>
                </h3>
                {slots.length === 0 ? (
                  <p className="mt-2 text-sm text-muted">No deliverable slots yet.</p>
                ) : (
                  <div className="mt-2 overflow-x-auto rounded-lg border border-border bg-surface">
                    <table className="w-full text-sm">
                      <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                        <tr>
                          <th className={th}>Deliverable</th>
                          <th className={th}>Team</th>
                          <th className={th}>Assignee</th>
                          <th className={th}>Status</th>
                          <th className={th}>Due</th>
                        </tr>
                      </thead>
                      <tbody>
                        {slots.map((d) => (
                          <Fragment key={d.id}>
                            <tr className="border-t border-border first:border-t-0">
                              <td className={`${td} font-medium`}>{d.name}</td>
                              <td className={`${td} text-muted`}>{d.department}</td>
                              <td className={`${td} text-muted`}>{d.assignee ?? 'unassigned'}</td>
                              <td className={`${td} capitalize`}>{statusLabel(d.status)}</td>
                              <td className={`${td} text-muted`}>{d.dueDate ?? '—'}</td>
                            </tr>
                            {d.versions.length === 0 ? (
                              <tr>
                                <td colSpan={5} className="pb-2.5 pl-10 pr-4 text-xs text-muted">nothing uploaded</td>
                              </tr>
                            ) : (
                              d.versions.map((v) => (
                                <tr key={v.id}>
                                  <td colSpan={5} className="pb-2.5 pl-10 pr-4 text-xs">
                                    <VersionLine version={v} canDownload={canDownload} />
                                  </td>
                                </tr>
                              ))
                            )}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })
        )}
      </section>

      <DepartmentTable rows={report.departments} />

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Final approved files</h2>
        {report.files.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Nothing approved yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className={th}>Deliverable</th>
                  <th className={th}>Team</th>
                  <th className={th}>File</th>
                  <th className={th}>Status</th>
                  <th className={th}>Delivered</th>
                </tr>
              </thead>
              <tbody>
                {report.files.map((f) => (
                  <tr key={f.deliverableId} className="border-b border-border last:border-0">
                    <td className={td}>
                      {f.deliverableName}
                      <div className="font-mono text-xs text-muted">{f.projectCode}</div>
                    </td>
                    <td className={`${td} text-muted`}>{f.department}</td>
                    <td className={td}>
                      <FileLink href={f.downloadUrl} filename={f.originalFilename} canDownload={canDownload} />
                      <div className="text-xs text-muted">v{f.versionNo} · {formatBytes(f.sizeBytes)}</div>
                    </td>
                    <td className={`${td} capitalize`}>{statusLabel(f.status)}</td>
                    <td className={`${td} text-muted`}>{f.deliveredOn ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Revisions</h2>
        {report.revisions.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No revisions on this month’s projects.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-surface text-sm">
            {report.revisions.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2.5">
                {/* An Executive reads a previous project's revisions here (§33) but
                    opens only those on their current work (§16): no dead link. */}
                {r.canOpen ? (
                  <Link href={`/revisions/${r.id}`} className="font-medium hover:underline">
                    #{String(r.revisionNo).padStart(2, '0')} {r.title}
                  </Link>
                ) : (
                  <span className="font-medium">
                    #{String(r.revisionNo).padStart(2, '0')} {r.title}
                  </span>
                )}
                <span className="font-mono text-xs text-muted">{r.projectCode}</span>
                <span className="capitalize text-muted">{statusLabel(r.status)}</span>
                <span className="ml-auto text-xs text-muted">
                  {r.deliverables} deliverable{r.deliverables === 1 ? '' : 's'} · opened {r.openedOn}
                  {r.closedOn ? ` · closed ${r.closedOn}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Team members involved</h2>
        {report.people.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Nobody assigned yet.</p>
        ) : (
          <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            {report.people.map((m) => (
              <li key={`${m.userId}-${m.department}`}
                className="flex items-baseline justify-between rounded-md border border-border bg-surface px-3 py-2">
                <span>
                  {m.fullName}
                  <span className="ml-2 text-xs text-muted">{m.department}{m.isLead ? ' · lead' : ''}</span>
                </span>
                {m.slots > 0 ? <span className="text-xs tabular-nums text-muted">{m.slots} slots</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>


      {/* §33: what was said on the month's projects, in order, with where it was said. */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold">Comments</h2>
        {report.comments.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No comments on this month’s projects.</p>
        ) : (
          <ol className="mt-3 rounded-lg border border-border bg-surface px-4 py-2 text-sm">
            {report.comments.map((c) => (
              <li key={c.id} className="border-b border-border py-2 last:border-0">
                <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
                  <span className="font-medium text-foreground">{c.author}</span>
                  <span>{formatDateTime(c.at)}</span>
                  <Link href={`/projects/${c.projectId}`} className="font-mono hover:underline">{c.projectCode}</Link>
                  <span>· {c.about}</span>
                </div>
                <p className="mt-0.5 whitespace-pre-wrap">{c.body}</p>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* §36: opening a month shows its complete activity, not only its numbers. */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold">Activity</h2>
        <p className="mt-1 text-xs text-muted">
          Everything that happened on this month’s projects, and to the month itself, in order.
        </p>
        {report.activity.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No activity recorded for this month.</p>
        ) : (
          <ol className="mt-3 rounded-lg border border-border bg-surface px-4 py-2 text-sm">
            {report.activity.map((line) => (
              <li key={line.id} className="flex gap-3 border-b border-border py-2 last:border-0">
                <span className="w-32 shrink-0 tabular-nums text-xs text-muted">{formatDateTime(line.at)}</span>
                <span>{line.text}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
      <Legend />
    </>
  );
}

const QA_LABEL: Record<ReportVersion['qaStatus'], string> = {
  pending: 'pending', approved: 'approved', changes_requested: 'changes requested', rejected: 'rejected',
};

/**
 * One version under its slot: the file (linked only when the loader allowed
 * it), who uploaded it and when, the revision it answered, its QA standing,
 * then the uploader's note and each verdict — the same lines the workspace
 * shows under a version (projects/[id]/workspace-section VersionHistory).
 */
function VersionLine({ version: v, canDownload }: { version: ReportVersion; canDownload: boolean }) {
  const qaTone = v.qaStatus === 'approved' ? '' : v.qaStatus === 'pending' ? 'text-muted' : 'text-red-600 dark:text-red-400';
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">v{v.versionNo}</span>
        {v.downloadUrl ? (
          <FileLink href={v.downloadUrl} filename={v.originalFilename} canDownload={canDownload} />
        ) : (
          <span className="text-muted"><span className="line-through">{v.originalFilename}</span> (deleted)</span>
        )}
        <span className="text-muted">{formatBytes(v.sizeBytes)}</span>
        <span className="text-muted">· {v.uploadedBy}, {formatDateTime(v.uploadedAt)}</span>
        {v.revisionNo !== null ? (
          <span className="text-muted">· for Revision #{String(v.revisionNo).padStart(2, '0')}</span>
        ) : null}
        <span className={qaTone}>· QA: {QA_LABEL[v.qaStatus]}</span>
      </div>
      {v.notes || v.reviews.length > 0 ? (
        <ul className="ml-3 mt-0.5 space-y-0.5 border-l border-border pl-2 text-muted">
          {v.notes ? (
            <li className="whitespace-pre-wrap">
              <span className="font-medium text-foreground">{v.uploadedBy}:</span> {v.notes}
            </li>
          ) : null}
          {v.reviews.map((r, i) => (
            <li key={i} className="whitespace-pre-wrap">
              <span className="font-medium text-foreground">{r.reviewer}</span>
              {' '}
              {r.decision === 'approved' ? 'approved' : r.decision === 'rejected' ? 'rejected' : 'requested changes'}
              {r.stage === 'project_manager' ? ' (PM QA)' : ''}, {formatDateTime(r.reviewedAt)}
              {r.comments ? <>: {r.comments}</> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

export function Legend() {
  return (
    <p className="mt-6 max-w-prose text-xs text-muted">
      Each deliverable is counted once: in revision if a client revision is being worked on it, otherwise
      completed once delivered, ready once approved, in QA while waiting for review, and pending before that.
      Cancelled projects and deliverables are left out.
    </p>
  );
}

export function Headline({ counts }: { counts: BucketCounts & { projects: number; value: OrderValue | null } }) {
  const tiles: { label: string; value: string | number }[] = [
    { label: 'Projects', value: counts.projects },
    { label: 'Deliverables', value: counts.deliverables },
    { label: 'Completed', value: counts.completed },
    { label: 'Ready to deliver', value: counts.ready },
    { label: 'In QA', value: counts.inQa },
    { label: 'In revision', value: counts.inRevision },
    { label: 'Pending', value: counts.pending },
  ];
  if (counts.value) tiles.push({ label: 'Order value', value: money(counts.value) });
  return (
    <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-lg border border-border bg-surface px-4 py-3">
          <div className="text-xs text-muted">{t.label}</div>
          <div className="mt-1 text-lg font-semibold tabular-nums">{t.value}</div>
        </div>
      ))}
    </div>
  );
}

export function BucketCells({ r }: { r: BucketCounts }) {
  return (
    <>
      <td className={tdNum}>{r.deliverables}</td>
      <td className={tdNum}>{r.completed}</td>
      <td className={tdNum}>{r.ready}</td>
      <td className={tdNum}>{r.inQa}</td>
      <td className={tdNum}>{r.inRevision}</td>
      <td className={tdNum}>{r.pending}</td>
    </>
  );
}

export function BucketHeads() {
  return (
    <>
      <th className={thNum}>Deliverables</th>
      <th className={thNum}>Completed</th>
      <th className={thNum}>Ready</th>
      <th className={thNum}>In QA</th>
      <th className={thNum}>In revision</th>
      <th className={thNum}>Pending</th>
    </>
  );
}

export function DepartmentTable({ rows }: { rows: DepartmentRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold">By team</h2>
      <div className="mt-3 overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className={th}>Team</th>
              <th className={thNum}>Projects</th>
              <BucketHeads />
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.departmentId} className="border-b border-border last:border-0">
                <td className={`${td} font-medium`}>{d.name}</td>
                <td className={tdNum}>{d.projects}</td>
                <BucketCells r={d} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

