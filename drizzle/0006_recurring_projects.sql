-- ============================================================================
-- 0006 — recurring projects (brief §29, building on §37–§38)
--
-- A retainer order that repeats — "10 social videos every month" — is marked
-- once. A nightly job then copies it into each new month exactly as "Copy
-- previous month" would: a new project and code, filed as new for the
-- Project Manager, with copied_from_project_id recording the chain. The flag
-- travels with the copy, so the chain continues until someone clears it.
-- ============================================================================

ALTER TABLE projects
  ADD COLUMN recurs_monthly boolean NOT NULL DEFAULT false;

-- The job looks for the tip of each chain: a recurring project nothing has
-- been copied from yet.
CREATE INDEX projects_recurring_idx ON projects (client_month_id) WHERE recurs_monthly;
CREATE INDEX projects_copied_from_idx ON projects (copied_from_project_id);
