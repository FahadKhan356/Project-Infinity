/**
 * Which files the browser may render in place (brief §12: the Team Lead
 * opens and reviews the file without downloading a multi-gigabyte master).
 *
 * The MIME type stored with a file is whatever the uploader's browser
 * declared, so it cannot decide what the portal's origin renders. Inline
 * viewing is limited to formats that cannot run script — images, audio,
 * video and PDF — and the response carries the Content-Type chosen here,
 * never the stored one. An HTML file renamed to .png is served as image/png
 * with nosniff, and the browser shows a broken image.
 *
 * Pure, so the rule is tested without a database.
 */
export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf';

const BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', aac: 'audio/aac',
  pdf: 'application/pdf',
};
const SAFE = new Set(Object.values(BY_EXTENSION));

/** The Content-Type to serve inline, or null when the file must be downloaded. */
export function previewContentType(mimeType: string | null | undefined, filename: string): string | null {
  const declared = mimeType?.split(';')[0].trim().toLowerCase();
  if (declared && SAFE.has(declared)) return declared;
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return null;
  return BY_EXTENSION[filename.slice(dot + 1).toLowerCase()] ?? null;
}

export function previewKind(mimeType: string | null | undefined, filename: string): PreviewKind | null {
  const type = previewContentType(mimeType, filename);
  if (type === null) return null;
  if (type === 'application/pdf') return 'pdf';
  return type.split('/')[0] as PreviewKind;
}
