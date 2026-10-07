'use client';

import { useRef } from 'react';
import { uploadResumable, type OpenUploadBody } from './resumable';

interface Props {
  files: File[];
  onChange: (files: File[]) => void;
  label?: string;
  hint?: string;
  disabled?: boolean;
  /** False for a single document, such as the PO: choosing again replaces it. */
  multiple?: boolean;
}

/**
 * Files chosen while a record is still being filled in (brief §3, §7, §15:
 * attachments on the intake, assignment and revision forms). A record has
 * to exist before anything can attach to it, so the form keeps the files
 * here, creates the record, and only then sends them — see `uploadPending`.
 */
export function PendingAttachments({
  files, onChange, label = 'Attachments', hint, disabled = false, multiple = true,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div>
      <span className="block text-sm font-medium">{label}</span>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
      <input
        ref={inputRef}
        type="file"
        multiple={multiple}
        className="hidden"
        disabled={disabled}
        onChange={(event) => {
          const chosen = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (chosen.length > 0) onChange(multiple ? [...files, ...chosen] : chosen.slice(0, 1));
        }}
      />
      {files.length > 0 ? (
        <ul className="mt-2 space-y-1 text-sm">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-2">
              <span className="truncate" title={f.name}>{f.name}</span>
              <span className="text-xs text-muted">{formatSize(f.size)}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(files.filter((_, j) => j !== i))}
                className="text-xs text-muted hover:underline disabled:opacity-60"
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="mt-2 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium disabled:opacity-60"
      >
        {multiple
          ? (files.length > 0 ? 'Add more files' : 'Choose files')
          : (files.length > 0 ? 'Replace file' : 'Choose file')}
      </button>
    </div>
  );
}

/**
 * Sends the files kept by `PendingAttachments` to the record the form has
 * just created, one after another. Resolves with what failed, if anything,
 * so the form can say "filed, but two files did not attach" and still lead
 * to the record rather than losing it.
 */
export async function uploadPending(
  files: File[],
  open: Extract<OpenUploadBody, { target: 'attachment' }>,
  onProgress?: (text: string) => void,
): Promise<{ done: number; failed: string | null }> {
  let done = 0;
  try {
    for (const file of files) {
      try {
        await uploadResumable(file, open, (percent, phase) => onProgress?.(
          `Attaching ${done + 1}/${files.length}: ${phase === 'finishing' ? 'checking…' : `${percent}%`}`,
        ));
        done++;
      } catch (caught) {
        return { done, failed: `${file.name}: ${caught instanceof Error ? caught.message : 'the upload failed.'}` };
      }
    }
    return { done, failed: null };
  } finally {
    // Done or failed, the progress text is over: from here the form shows
    // the outcome, never a stale "Attaching 2/3".
    onProgress?.('');
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
