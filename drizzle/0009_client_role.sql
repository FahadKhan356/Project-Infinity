-- ============================================================================
-- 0009 — the client role (brief §29: client portal, client login)
--
-- On its own because PostgreSQL will not use a new enum value in the
-- transaction that adds it, and each migration runs in one transaction.
-- ============================================================================

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'client';
