import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { can, projectScope, revisionScope } from '@/lib/authz';

/**
 * Reference files that are not deliverables (brief §3 "attachments", §7
 * "attachments/references", §15 "attachments/reference files"): the PO PDF,
 * a brand guide, the client's marked-up screenshot.
 *
 * Each hangs off exactly one parent — the project, one assignment, or one
 * revision — and is readable exactly when its project is (files/access.ts).
 * The PO document (§3) is kind 'po', always on the project itself, and the
 * project page shows it beside the PO reference; everything else is a
 * 'reference' and stays in the attachments list. `purpose` is the free
 * label the uploader gave; `kind` is the enforced classification.
 * Revision attachments are further limited by revisionScope, so the Design
 * lead does not see the references attached to the note about the video.
 * For an Executive they follow the project page's history rule (§8): a
 * revision the page lists has its references listed with it.
 */
export interface ProjectAttachment {
  id: number;
  fileId: number;
  originalFilename: string;
  sizeBytes: number;
  purpose: string | null;
  /** The PO document, or a plain reference — what the project page groups by. */
  kind: 'po' | 'reference';
  uploadedBy: string;
  uploadedAt: string;
  isDeleted: boolean;
  downloadUrl: string;
  parent:
    | { kind: 'project' }
    | { kind: 'assignment'; id: number; title: string; assignee: string }
    | { kind: 'revision'; id: number; revisionNo: number; title: string };
}

export async function listProjectAttachments(actor: Actor, projectId: number): Promise<ProjectAttachment[]> {
  // Soft-deleted files stay listed, struck through, for whoever may delete —
  // they can still be recovered until the sweep runs. Everyone else never
  // sees them.
  const showDeleted = can(actor, 'files.delete');
  const rows = await getDb().execute<{
    id: number; file_id: number; original_filename: string; size_bytes: string; purpose: string | null; kind: string;
    uploaded_by: string; uploaded_at: string; deleted: boolean; storage_key: string;
    assignment_id: number | null; assignment_title: string | null; assignee: string | null;
    revision_id: number | null; revision_no: number | null; revision_title: string | null;
  }>(sql`
    SELECT a.id, f.id AS file_id, f.original_filename, f.size_bytes::text AS size_bytes, a.purpose, a.kind,
           u.full_name AS uploaded_by,
           to_char(f.uploaded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS uploaded_at,
           (f.deleted_at IS NOT NULL) AS deleted, f.storage_key::text AS storage_key,
           asg.id AS assignment_id, asg.title AS assignment_title, au.full_name AS assignee,
           r.id AS revision_id, r.revision_no, r.title AS revision_title
    FROM attachments a
    JOIN files f            ON f.id = a.file_id
    JOIN users u            ON u.id = f.uploaded_by
    LEFT JOIN assignments asg ON asg.id = a.assignment_id
    LEFT JOIN users au        ON au.id = asg.assignee_id
    LEFT JOIN revisions r     ON r.id = a.revision_id
    JOIN projects p           ON p.id = COALESCE(a.project_id, asg.project_id, r.project_id)
    WHERE p.id = ${projectId} AND ${projectScope(actor, 'p', { shared: true })}
      AND (r.id IS NULL OR ${revisionScope(actor, 'r', { shared: true, history: true })})
      ${showDeleted ? sql`` : sql`AND f.deleted_at IS NULL`}
    ORDER BY a.created_at, a.id
  `);

  return rows.map((r) => ({
    id: Number(r.id),
    fileId: Number(r.file_id),
    originalFilename: r.original_filename,
    sizeBytes: Number(r.size_bytes),
    purpose: r.purpose,
    kind: r.kind === 'po' ? 'po' : 'reference',
    uploadedBy: r.uploaded_by,
    uploadedAt: r.uploaded_at,
    isDeleted: r.deleted === true,
    downloadUrl: `/api/files/${r.storage_key}`,
    parent: r.assignment_id !== null
      ? { kind: 'assignment', id: Number(r.assignment_id), title: r.assignment_title ?? '', assignee: r.assignee ?? '' }
      : r.revision_id !== null
        ? { kind: 'revision', id: Number(r.revision_id), revisionNo: Number(r.revision_no), title: r.revision_title ?? '' }
        : { kind: 'project' },
  }));
}
