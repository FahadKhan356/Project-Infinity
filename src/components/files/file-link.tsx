/**
 * A file's name: a download link when the reader may keep a copy
 * (`files.download`, brief §43), plain text when downloads are withheld
 * from their account. Preview and inline viewing sit beside it either way
 * (FilePreview): the restriction takes away the copy, not the view. No
 * hooks, so server components render it directly.
 */
export function FileLink({ href, filename, canDownload, className = 'hover:underline' }: {
  href: string;
  filename: string;
  canDownload: boolean;
  /** Classes for the link; the plain-text fallback keeps them minus hover:underline. */
  className?: string;
}) {
  if (canDownload) {
    return <a href={href} className={className}>{filename}</a>;
  }
  return (
    <span
      className={className.replace(/\bhover:underline\b/g, '').replace(/\s+/g, ' ').trim()}
      title="Downloads are not enabled for your account. Use Preview to view it."
    >
      {filename}
    </span>
  );
}
