-- ============================================================================
-- 0016 — Sales intake: other information and the PO document (brief §3)
--
-- The intake form lists "PO / project requirements", "number of deliverables"
-- and "other relevant project information". The last had no column; the PO
-- was a reference number plus a file lost among the references. The purchase
-- order is now an attachment of its own kind, filed by Sales or the Project
-- Manager on the project itself and shown beside the PO reference. The
-- deliverable total is not stored: it is the sum of the teams' counts
-- (project_departments.planned_deliverables), read where it is shown, so it
-- can never disagree with them.
-- ============================================================================

ALTER TABLE projects
  ADD COLUMN other_info text;

ALTER TABLE attachments
  ADD COLUMN kind text NOT NULL DEFAULT 'reference',
  ADD CONSTRAINT attachments_kind_known CHECK (kind IN ('po', 'reference'));

-- Purchase orders filed on a project so far (the demo data, purpose 'po')
-- become PO documents; a 'po' pinned to an assignment or revision is a
-- reference to one, and stays a reference.
UPDATE attachments SET kind = 'po' WHERE purpose = 'po' AND project_id IS NOT NULL;

-- A PO belongs to the project, never to an assignment, a revision or a comment.
ALTER TABLE attachments
  ADD CONSTRAINT attachments_po_on_project CHECK (kind <> 'po' OR project_id IS NOT NULL);

-- The session is the pending attachment: it carries the kind to completion
-- as it carries the parent, where the rule is checked again.
ALTER TABLE upload_sessions
  ADD COLUMN kind text NOT NULL DEFAULT 'reference',
  ADD CONSTRAINT upload_sessions_kind_known CHECK (kind IN ('po', 'reference'));
