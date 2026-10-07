'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { uploadResumable } from '@/components/files/resumable';

type Phase = 'idle' | 'chosen' | 'uploading' | 'finishing' | 'done' | 'error';

interface Props {
  deliverableId: number;
  /** The version this upload will become — 1 for a fresh slot. */
  nextVersion: number;
}

/**
 * Adds the next version to a deliverable slot, resumably (README, "Files").
 * Choosing a file opens a one-line note — what changed in this version —
 * which is kept with the version for the history the brief asks for (§10,
 * §19). The note is optional; the file goes with or without it.
 */
export function UploadButton({ deliverableId, nextVersion }: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState('');
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!file) return;
    setPhase('uploading');
    setPercent(0);
    setError(null);
    try {
      const trimmed = notes.trim();
      await uploadResumable(
        file,
        { target: 'deliverable', deliverableId, ...(trimmed ? { notes: trimmed } : {}) },
        (p, next) => {
          setPercent(p);
          setPhase(next);
        },
      );
      setPhase('done');
      setFile(null);
      setNotes('');
      router.refresh();
    } catch (caught) {
      setPhase('error');
      setError(caught instanceof Error ? caught.message : 'The upload failed.');
    }
  }

  const busy = phase === 'uploading' || phase === 'finishing';

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          event.target.value = '';
          if (chosen) {
            setFile(chosen);
            setError(null);
            setPhase('chosen');
          }
        }}
      />
      {phase === 'chosen' && file ? (
        <form
          className="flex w-64 flex-col items-stretch gap-1 rounded-md border border-border bg-surface p-2 text-left"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <p className="truncate text-xs" title={file.name}>{file.name}</p>
          <input
            type="text"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={500}
            placeholder={`What changed in v${nextVersion} (optional)`}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => { setFile(null); setNotes(''); setPhase('idle'); }}
              className="rounded-md border border-border px-2 py-1 text-xs"
            >
              Cancel
            </button>
            <button type="submit" className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white">
              Upload v{nextVersion}
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-60"
        >
          {phase === 'uploading'
            ? `Uploading ${percent}%`
            : phase === 'finishing'
              ? 'Checking…'
              : phase === 'done'
                ? 'Uploaded'
                : `Upload v${nextVersion}`}
        </button>
      )}
      {phase === 'uploading' ? (
        <div className="h-1 w-24 overflow-hidden rounded bg-border" aria-hidden>
          <div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="max-w-[16rem] text-right text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
