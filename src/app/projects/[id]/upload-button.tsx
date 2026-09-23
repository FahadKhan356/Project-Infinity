'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type Phase = 'idle' | 'uploading' | 'finishing' | 'done' | 'error';

interface Props {
  deliverableId: number;
  /** The version this upload will become — 1 for a fresh slot. */
  nextVersion: number;
}

/** How many consecutive failed chunks before giving up. */
const MAX_RETRIES = 5;

/**
 * Drives the resumable upload protocol from the browser (README, "Files").
 *
 * A dropped chunk is not an error: the client asks the server where it stands
 * and resumes from that offset. Only a refusal — wrong slot, expired session,
 * checksum mismatch — surfaces as an error.
 */
export function UploadButton({ deliverableId, nextVersion }: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function send(file: File) {
    setPhase('uploading');
    setPercent(0);
    setError(null);

    try {
      const opened = await fetch('/api/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'deliverable',
          deliverableId,
          filename: file.name,
          size: file.size,
          mimeType: file.type || null,
        }),
      });
      if (!opened.ok) throw new Error(await messageOf(opened));
      const { uploadId, chunkSize } = (await opened.json()) as { uploadId: string; chunkSize: number };

      let offset = 0;
      let failures = 0;
      while (offset < file.size) {
        const end = Math.min(offset + chunkSize, file.size);
        const response = await fetch(`/api/uploads/${uploadId}`, {
          method: 'PATCH',
          headers: { 'Upload-Offset': String(offset), 'Content-Type': 'application/octet-stream' },
          body: file.slice(offset, end),
        }).catch(() => null);

        if (response?.status === 204) {
          offset = Number(response.headers.get('Upload-Offset'));
          failures = 0;
        } else if (response && response.status !== 409 && response.status < 500) {
          // A definite refusal, not a transport problem.
          throw new Error(await messageOf(response));
        } else {
          if (++failures > MAX_RETRIES) {
            throw new Error('The connection kept dropping. Your progress is kept — try again.');
          }
          // Resync with the server's recorded offset, then back off.
          const head = await fetch(`/api/uploads/${uploadId}`, { method: 'HEAD' }).catch(() => null);
          if (head?.ok) offset = Number(head.headers.get('Upload-Offset'));
          await new Promise((resolve) => setTimeout(resolve, 1000 * failures));
        }
        setPercent(file.size === 0 ? 100 : Math.round((offset / file.size) * 100));
      }

      setPhase('finishing');
      const finished = await fetch(`/api/uploads/${uploadId}/complete`, { method: 'POST' });
      if (!finished.ok) throw new Error(await messageOf(finished));

      setPhase('done');
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
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void send(file);
        }}
      />
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

async function messageOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // not JSON
  }
  return `Upload failed (${response.status}).`;
}
