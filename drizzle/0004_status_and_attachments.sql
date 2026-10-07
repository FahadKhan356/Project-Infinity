-- ============================================================================
-- 0004 — held projects, and attachments below the project
--
-- Brief §18 lists On Hold and Cancelled beside the statuses that follow the
-- work. Holding is temporary, so the project must remember where it was:
-- resuming puts it back there rather than guessing.
--
-- Brief §3, §7 and §15 each ask for attachments — on the project, on an
-- assignment ("attachments/references") and on a revision ("reference
-- files"). The attachments table already allows all three parents; the upload
-- session now records which one a file is for. project_id stays mandatory on
-- an attachment session, because the project is what access is decided on.
-- ============================================================================

ALTER TABLE projects
  ADD COLUMN held_from_status project_status,
  ADD CONSTRAINT projects_held_from_status_only_on_hold CHECK (
    (status = 'on_hold') = (held_from_status IS NOT NULL)
  );

ALTER TABLE upload_sessions
  ADD COLUMN assignment_id bigint REFERENCES assignments(id) ON DELETE CASCADE,
  ADD COLUMN revision_id   bigint REFERENCES revisions(id)   ON DELETE CASCADE,
  ADD COLUMN purpose       text,
  ADD CONSTRAINT upload_sessions_attachment_parent CHECK (
    (assignment_id IS NULL AND revision_id IS NULL)
    OR (target = 'attachment' AND (assignment_id IS NULL OR revision_id IS NULL))
  );

-- 0001 indexes project_id and revision_id already.
CREATE INDEX attachments_assignment_idx ON attachments (assignment_id);
