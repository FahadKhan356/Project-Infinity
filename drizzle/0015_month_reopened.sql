-- ============================================================================
-- 0015 — a reopened month is closed again by hand (brief §36)
--
-- Management reopens an archived month to change something in it: a late
-- PO, a delivery record, a note. The nightly archive cannot know when that
-- is done, and until now it took the month back the same night, before the
-- change was made. The reopen is now recorded on the month; the archive
-- skips a month with reopened_at set, and closing the month by hand clears
-- it. The client page shows the mark as "reopened".
-- ============================================================================

ALTER TABLE client_months
  ADD COLUMN reopened_at timestamptz;
