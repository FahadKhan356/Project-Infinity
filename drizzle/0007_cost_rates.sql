-- ============================================================================
-- 0007 — cost rates (brief §29, profitability reports)
--
-- Profitability needs what an hour costs, not only what the project earns.
-- A person's hourly cost is kept apart from the users table, so no ordinary
-- user query can carry it by accident, and it is dated: a raise in June does
-- not change what March cost. An hour is costed at the rate in force on the
-- day it was worked.
-- ============================================================================

CREATE TABLE user_cost_rates (
  user_id        bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  effective_from date NOT NULL,
  hourly_cost    numeric(10,2) NOT NULL CHECK (hourly_cost >= 0),
  currency       char(3) NOT NULL DEFAULT 'AED',
  set_by         bigint NOT NULL REFERENCES users(id),
  set_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, effective_from)
);
