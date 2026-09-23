-- ============================================================================
-- 0002 — resumable upload sessions
--
-- A chunked upload spans several HTTP requests, so its progress must survive
-- between them. This is what makes a 4 GB master survive a dropped Wi-Fi
-- connection instead of starting over (docs/phase-1a-plan.md, M2).
-- ============================================================================

CREATE TYPE upload_target AS ENUM ('deliverable', 'attachment');

CREATE TABLE upload_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by        bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target            upload_target NOT NULL,

  -- Exactly one of these is set, according to `target`.
  deliverable_id    bigint REFERENCES deliverables(id) ON DELETE CASCADE,
  project_id        bigint REFERENCES projects(id) ON DELETE CASCADE,

  original_filename text   NOT NULL,
  mime_type         text,
  declared_size     bigint NOT NULL CHECK (declared_size >= 0),
  bytes_received    bigint NOT NULL DEFAULT 0,
  -- Relative to STORAGE_ROOT, never built from anything the client sent.
  temp_path         text   NOT NULL,
  -- Optional client-declared digest, verified on completion.
  expected_checksum text,
  notes             text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  completed_at      timestamptz,
  file_id           bigint REFERENCES files(id),

  CONSTRAINT upload_sessions_target_present CHECK (
    (target = 'deliverable' AND deliverable_id IS NOT NULL AND project_id IS NULL)
    OR
    (target = 'attachment'  AND project_id IS NOT NULL AND deliverable_id IS NULL)
  ),
  CONSTRAINT upload_sessions_offset_sane CHECK (
    bytes_received >= 0 AND bytes_received <= declared_size
  )
);

CREATE INDEX upload_sessions_owner_idx   ON upload_sessions (created_by, created_at DESC);
CREATE INDEX upload_sessions_pending_idx ON upload_sessions (expires_at) WHERE completed_at IS NULL;

CREATE TRIGGER upload_sessions_updated_at BEFORE UPDATE ON upload_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
