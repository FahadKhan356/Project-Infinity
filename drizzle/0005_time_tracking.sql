-- ============================================================================
-- 0005 — time tracking (brief §29)
--
-- Brief §29 lists time tracking, employee productivity reports, team
-- performance analytics and profitability reports as the next features, and
-- asks that the architecture allow them. They share one fact: how long a
-- person spent on a piece of work. That is recorded against the assignment,
-- the unit a Team Lead hands out (§7), so every hour already knows its
-- project, team, client and month.
--
-- An assignment may also carry an estimate, which turns workload (§6) from a
-- count of open slots into planned hours when a lead chooses to give one.
-- ============================================================================

ALTER TABLE assignments
  ADD COLUMN estimated_minutes int CHECK (estimated_minutes IS NULL OR estimated_minutes > 0),
  -- lets a time entry prove its project is the assignment's project
  ADD CONSTRAINT assignments_id_project_key UNIQUE (id, project_id);

CREATE TABLE time_entries (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  assignment_id bigint NOT NULL,
  project_id    bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id       bigint NOT NULL REFERENCES users(id),
  work_date     date NOT NULL,
  -- a day at most; the per-day total is checked by the application
  minutes       int NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (assignment_id, project_id) REFERENCES assignments (id, project_id) ON DELETE CASCADE
);
CREATE INDEX time_entries_user_date_idx ON time_entries (user_id, work_date DESC);
CREATE INDEX time_entries_project_idx   ON time_entries (project_id);
CREATE INDEX time_entries_assignment_idx ON time_entries (assignment_id);
CREATE INDEX time_entries_date_idx      ON time_entries (work_date);
