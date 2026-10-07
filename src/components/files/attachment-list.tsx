import type { ProjectAttachment } from '@/lib/files/attachments';
import { FileLink } from './file-link';
import { FilePreview } from './file-preview';
import { formatBytes, formatDateTime } from '@/lib/workspace/format';
import { DeleteFileButton } from './delete-file-button';

/**
 * What a file was attached as, in the reader's words: the PO, or the PO or
 * brief, filed with the project (§3, §5 "Read PO"), the client's own
 * reference on a revision (§15). A plain reference says nothing — that is
 * the default.
 */
const PURPOSE_LABELS: Record<string, string> = {
  po: 'PO',
  brief: 'brief',
  client_reference: 'client reference',
  reference: '',
};

export function purposeLabel(purpose: string | null): string {
  return purpose === null ? '' : PURPOSE_LABELS[purpose] ?? '';
}

/** A compact list of reference files, shared by the project, workspace and revision pages. */
export function AttachmentList({ items, canDelete, canDownload, showParent = false }: {
  items: ProjectAttachment[];
  canDelete: boolean;
  /** Holds files.download (§43): the name links to the bytes; otherwise it is text beside Preview. */
  canDownload: boolean;
  showParent?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="space-y-1 text-xs">
      {items.map((a) => (
        <li key={a.id} className="flex flex-wrap items-baseline gap-x-2">
          {a.isDeleted ? (
            <span className="text-muted line-through">{a.originalFilename}</span>
          ) : (
            <FileLink href={a.downloadUrl} filename={a.originalFilename} canDownload={canDownload}
              className="font-medium hover:underline" />
          )}
          {purposeLabel(a.purpose) ? (
            <span className="rounded bg-accent/10 px-1.5 py-0.5 text-accent">{purposeLabel(a.purpose)}</span>
          ) : null}
          <span className="text-muted">
            {formatBytes(a.sizeBytes)} · {a.uploadedBy}, {formatDateTime(a.uploadedAt)}
            {showParent ? ` · ${parentLabel(a)}` : ''}
            {a.isDeleted ? ' · deleted' : ''}
          </span>
          {a.isDeleted ? null : <FilePreview url={a.downloadUrl} filename={a.originalFilename} />}
          {canDelete && !a.isDeleted ? <DeleteFileButton downloadUrl={a.downloadUrl} filename={a.originalFilename} /> : null}
        </li>
      ))}
    </ul>
  );
}

function parentLabel(a: ProjectAttachment): string {
  switch (a.parent.kind) {
    case 'assignment': return `assignment “${a.parent.title}” (${a.parent.assignee})`;
    case 'revision': return `revision #${String(a.parent.revisionNo).padStart(2, '0')}`;
    default: return 'project';
  }
}
