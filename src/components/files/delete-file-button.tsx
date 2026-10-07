'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Soft-deletes a file (brief §43). Offered only to holders of `files.delete`;
 * the API checks again. The bytes stay until the retention sweep, so an
 * administrator can still recover a mistake.
 */
export function DeleteFileButton({ downloadUrl, filename }: { downloadUrl: string; filename: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (!window.confirm(`Delete ${filename}? It can be recovered by an administrator until the retention sweep runs.`)) return;
    setBusy(true);
    setError(null);
    const response = await fetch(downloadUrl, { method: 'DELETE' }).catch(() => null);
    setBusy(false);
    if (response?.status === 204) {
      router.refresh();
      return;
    }
    let message = 'The file could not be deleted.';
    try {
      const body = (await response?.json()) as { error?: string } | undefined;
      if (body?.error) message = body.error;
    } catch {
      // not JSON
    }
    setError(message);
  }

  return (
    <>
      <button type="button" onClick={remove} disabled={busy}
        className="text-xs text-muted hover:text-red-600 hover:underline disabled:opacity-60 dark:hover:text-red-400">
        {busy ? 'Deleting…' : 'Delete'}
      </button>
      {error ? <span role="alert" className="ml-1 text-xs text-red-600 dark:text-red-400">{error}</span> : null}
    </>
  );
}
