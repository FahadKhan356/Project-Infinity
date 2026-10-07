/**
 * The browser side of the resumable upload protocol (README, "Files"), shared
 * by every upload button — deliverable versions and attachments alike.
 *
 * A dropped chunk is not an error: the client asks the server where it stands
 * and resumes from that offset. Only a refusal — wrong slot, expired session,
 * checksum mismatch — surfaces as an error.
 */

/** How many consecutive failed chunks before giving up. */
const MAX_RETRIES = 5;

export type OpenUploadBody =
  | { target: 'deliverable'; deliverableId: number; notes?: string }
  | {
      target: 'attachment'; projectId: number; assignmentId?: number; revisionId?: number; purpose?: string;
      /** The PO document (§3) rather than a reference: on the project itself, Sales or the PM only. */
      kind?: 'po' | 'reference';
    };

export async function uploadResumable(
  file: File,
  open: OpenUploadBody,
  onProgress: (percent: number, phase: 'uploading' | 'finishing') => void,
): Promise<void> {
  const opened = await fetch('/api/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...open, filename: file.name, size: file.size, mimeType: file.type || null }),
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
    onProgress(file.size === 0 ? 100 : Math.round((offset / file.size) * 100), 'uploading');
  }

  onProgress(100, 'finishing');
  const finished = await fetch(`/api/uploads/${uploadId}/complete`, { method: 'POST' });
  if (!finished.ok) throw new Error(await messageOf(finished));
}

export async function messageOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // not JSON
  }
  return `Upload failed (${response.status}).`;
}
