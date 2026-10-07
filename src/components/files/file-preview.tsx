'use client';

import { useState } from 'react';
import { previewKind } from '@/lib/files/preview';

/**
 * "Preview" next to a file link: shows an image, plays a video or audio file,
 * or opens a PDF in place (brief §12). Nothing loads until it is opened, and
 * video fetches only what the player asks for, so a large master seeks
 * instead of downloading. Formats that could run script are never offered.
 */
export function FilePreview({ url, filename, mimeType = null }: {
  url: string;
  filename: string;
  mimeType?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const kind = previewKind(mimeType, filename);
  if (kind === null) return null;
  const src = `${url}?inline=1`;

  return (
    <>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="text-xs text-accent hover:underline">
        {open ? 'Hide preview' : 'Preview'}
      </button>
      {open ? (
        <div className="mt-2 basis-full overflow-hidden rounded-md border border-border bg-black/5">
          {kind === 'image' ? (
            // eslint-disable-next-line @next/next/no-img-element -- a permission-gated file, not a static asset
            <img src={src} alt={filename} className="mx-auto max-h-[70vh] w-auto" />
          ) : kind === 'video' ? (
            <video src={src} controls preload="metadata" className="max-h-[70vh] w-full bg-black" />
          ) : kind === 'audio' ? (
            <audio src={src} controls preload="metadata" className="w-full" />
          ) : (
            <iframe src={src} title={filename} className="h-[70vh] w-full bg-white" />
          )}
        </div>
      ) : null}
    </>
  );
}
