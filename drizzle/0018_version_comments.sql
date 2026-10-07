-- ============================================================================
-- 0018 — Comments on a file version (brief §10, §19)
--
-- The shared workspace keeps comments per file: a comment can now hang off
-- one deliverable version, next to the uploader's note and the QA rounds,
-- so what was said about v2 stays with v2 once v3 is up. Like the other
-- parents it is exactly one of them.
-- ============================================================================

ALTER TABLE comments
  ADD COLUMN version_id bigint REFERENCES deliverable_versions(id) ON DELETE CASCADE;

ALTER TABLE comments
  DROP CONSTRAINT comments_exactly_one_parent,
  ADD CONSTRAINT comments_exactly_one_parent CHECK (
    (project_id IS NOT NULL)::int + (assignment_id IS NOT NULL)::int +
    (deliverable_id IS NOT NULL)::int + (revision_id IS NOT NULL)::int +
    (version_id IS NOT NULL)::int = 1
  );

CREATE INDEX comments_version_idx ON comments (version_id, created_at DESC);
