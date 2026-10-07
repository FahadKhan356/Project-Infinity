-- ============================================================================
-- 0013 — AI project summaries (brief §29)
--
-- Optional (§46): only when an Anthropic API key is configured, and only on
-- request. A summary is written from what its readers may see, so there is
-- one per audience — with pricing for those allowed it, without for everyone
-- else — and it is kept, so reading one costs nothing until someone asks for
-- a fresh one.
-- ============================================================================

CREATE TABLE project_summaries (
  project_id   bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  audience     text NOT NULL CHECK (audience IN ('pricing','team')),
  summary      text NOT NULL,
  model        text NOT NULL,
  generated_by bigint NOT NULL REFERENCES users(id),
  generated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, audience)
);
