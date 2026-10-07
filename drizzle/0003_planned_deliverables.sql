-- ============================================================================
-- 0003 — planned deliverable counts per department
--
-- Brief §3 has Sales state a number of deliverables at intake, and §10 has one
-- project span several departments ("10 videos, 20 designs"). The count
-- therefore belongs to the project/department pair, not the project: it is
-- what each team has been promised, and what M5 turns into that many slots.
-- ============================================================================

ALTER TABLE project_departments
  ADD COLUMN planned_deliverables integer NOT NULL DEFAULT 0
    CHECK (planned_deliverables >= 0);
