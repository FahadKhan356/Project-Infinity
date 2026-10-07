-- ============================================================================
-- 0019 — downloading is a right of its own (brief §43)
--
-- The portal decides who may keep a copy of a file separately from who may
-- see it. A `no_download` row in user_permissions withholds downloads from
-- one account; every staff role holds the right by default. On its own file
-- because PostgreSQL will not use a new enum value in the transaction that
-- adds it, and each migration runs in one transaction (see 0009).
-- ============================================================================

ALTER TYPE permission_key ADD VALUE IF NOT EXISTS 'no_download';
