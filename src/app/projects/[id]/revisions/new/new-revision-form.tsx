'use client';

import { useActionState, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { openRevision, type RevisionFormState } from '@/app/revisions/actions';
import { PendingAttachments, uploadPending } from '@/components/files/pending-attachments';

const initial: RevisionFormState = {};
const field =
  'mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent';

interface Props {
  projectId: number;
  nextNumber: number;
  deliverables: { id: number; label: string; status: string; preselected: boolean }[];
}

/** The §15 form: title, the client's words, details, which files, priority, deadline. */
export function NewRevisionForm({ projectId, nextNumber, deliverables }: Props) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(openRevision, initial);
  const [files, setFiles] = useState<File[]>([]);
  const [attaching, setAttaching] = useState('');
  const [attachError, setAttachError] = useState<string | null>(null);

  // The client's screenshots go on the revision once it exists (§15). If one
  // fails, the form stays done and the error line leads to the revision:
  // opening again from here would make a second one.
  const created = state.createdRevision;
  useEffect(() => {
    if (!created) return;
    let cancelled = false;
    void uploadPending(
      files,
      { target: 'attachment', projectId: created.projectId, revisionId: created.revisionId, purpose: 'client_reference' },
      setAttaching,
    ).then((outcome) => {
      if (cancelled) return;
      if (outcome.failed) setAttachError(`Revision opened, but ${outcome.failed}`);
      else router.push(`/revisions/${created.revisionId}`);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per revision opened
  }, [created]);
  const opened = created !== undefined;
  const busy = pending || opened;

  return (
    <form action={formAction} className="rounded-lg border border-border bg-surface p-6">
      <input type="hidden" name="projectId" value={projectId} />

      <label className="block text-sm font-medium" htmlFor="title">Revision #{String(nextNumber).padStart(2, '0')} — title</label>
      <input id="title" name="title" required className={field} placeholder="Opening scene and logo placement" />

      <label className="mt-4 block text-sm font-medium" htmlFor="clientFeedback">Client feedback</label>
      <textarea id="clientFeedback" name="clientFeedback" required rows={4} className={field}
        placeholder="In the client’s own words." />

      <label className="mt-4 block text-sm font-medium" htmlFor="details">Revision details</label>
      <textarea id="details" name="details" rows={3} className={field}
        placeholder="What the team should actually change." />

      <fieldset className="mt-4">
        <legend className="text-sm font-medium">Deliverables this is about</legend>
        <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
          {deliverables.map((d) => (
            <label key={d.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
              <input type="checkbox" name="deliverableId" value={d.id} defaultChecked={d.preselected} />
              <span>{d.label}</span>
              <span className="ml-auto text-xs text-muted">{d.status.replace(/_/g, ' ')}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="block text-sm font-medium" htmlFor="priority">Priority</label>
          <select id="priority" name="priority" defaultValue="normal" className={field}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium" htmlFor="deadline">Deadline</label>
          <input id="deadline" name="deadline" type="date" className={field} />
        </div>
      </div>

      <div className="mt-4">
        <PendingAttachments
          files={files}
          onChange={setFiles}
          disabled={busy}
          label="Reference files from the client"
          hint="Screenshots, marked-up exports, anything the client sent with the feedback."
        />
        {files.length > 0 ? <input type="hidden" name="stayAfterCreate" value="1" /> : null}
      </div>

      <label className="mt-4 block text-sm font-medium" htmlFor="comment">Comment</label>
      <textarea id="comment" name="comment" rows={2} maxLength={4000} className={field}
        placeholder="An internal note for the team — posted as the first comment on the revision." />

      {state.error ? (
        <p role="alert" className="mt-4 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      {attachError ? (
        <p role="alert" className="mt-4 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {attachError}{' '}
          <Link href={`/revisions/${created?.revisionId}`} className="underline">Open the revision</Link> to attach the rest.
        </p>
      ) : null}

      <button type="submit" disabled={busy}
        className="mt-4 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
        {pending ? 'Opening…' : attaching || (attachError ? 'Opened' : opened ? 'Opened, attaching…' : 'Open revision')}
      </button>
    </form>
  );
}
