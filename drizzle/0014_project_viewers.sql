-- ============================================================================
-- 0014 — Sharing a project with a Sales rep (brief §23)
--
-- "Sales: projects they create/are authorized to view." A rep sees their own
-- clients' projects by ownership. Management or a Project Manager can also
-- let a rep view one project without moving its client to them: a share
-- widens what the rep reads, never who owns the work or the client.
-- ============================================================================

CREATE TABLE project_viewers (
  project_id bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by bigint NOT NULL REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

-- A rep's shares, found by user; the primary key leads with the project.
CREATE INDEX project_viewers_user_idx ON project_viewers (user_id, project_id);
