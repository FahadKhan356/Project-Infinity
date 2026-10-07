'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { uploadResumable } from './resumable';

interface Props {
  projectId: number;
  /** Pin the file to one assignment or revision of the project (§7, §15). */
  assignmentId?: number;
  revisionId?: number;
  /** The PO document (§3): one file, on the project itself, rather than references. */
  kind?: 'po' | 'reference';
  label?: string;
}

/**
 * Attaches reference files (brief §3, §7, §15). Several at once — a brief
 * often arrives as a PDF plus a handful of screenshots — each over the same
 * resumable protocol as a deliverable.
 */
export function AttachButton({ projectId, assignmentId, revisionId, kind, label = 'Attach files' }: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(files: File[]) {
    setBusy(true);
    setError(null);
    let done = 0;
    try {
      for (const file of files) {
        await uploadResumable(
          file,
          { target: 'attachment', projectId, assignmentId, revisionId, kind },
          (percent, phase) => setStatus(
            `${files.length > 1 ? `${done + 1}/${files.length} · ` : ''}${phase === 'finishing' ? 'Checking…' : `${percent}%`}`,
          ),
        );
        done++;
      }
      setStatus(null);
      router.refresh();
    } catch (caught) {
      setError(`${done > 0 ? `${done} attached; ` : ''}${caught instanceof Error ? caught.message : 'The upload failed.'}`);
      setStatus(null);
      if (done > 0) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <input
        ref={inputRef}
        type="file"
        multiple={kind !== 'po'}
        className="hidden"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          if (files.length > 0) void send(files);
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-background disabled:opacity-60"
      >
        {busy && status ? `Attaching ${status}` : label}
      </button>
      {error ? <span role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
    </span>
  );
}
