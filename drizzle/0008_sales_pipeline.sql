-- ============================================================================
-- 0008 — sales pipeline (brief §29)
--
-- Work Sales is chasing but has not confirmed. An opportunity belongs to a
-- client from the first conversation — a new name is simply a client with
-- status 'prospect' — so when it is won, the project it becomes is filed
-- against the same permanent record (§31, §47) and the history starts there
-- rather than being re-typed. Winning is filing: the project and the
-- opportunity's 'won' are written in one transaction, and won_project_id
-- links the two.
-- ============================================================================

CREATE TYPE opportunity_stage AS ENUM ('lead','qualified','proposal','negotiation','won','lost');

CREATE TABLE opportunities (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id       bigint NOT NULL REFERENCES clients(id),
  owner_user_id   bigint NOT NULL REFERENCES users(id),
  title           text NOT NULL,
  stage           opportunity_stage NOT NULL DEFAULT 'lead',
  estimated_value numeric(14,2) CHECK (estimated_value IS NULL OR estimated_value >= 0),
  currency        char(3) NOT NULL DEFAULT 'AED',
  expected_close  date,
  notes           text,
  lost_reason     text,
  won_project_id  bigint UNIQUE REFERENCES projects(id),
  closed_at       timestamptz,
  created_by      bigint NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((stage = 'won') = (won_project_id IS NOT NULL)),
  CHECK ((stage IN ('won','lost')) = (closed_at IS NOT NULL)),
  CHECK (stage <> 'lost' OR lost_reason IS NOT NULL)
);
CREATE INDEX opportunities_open_idx   ON opportunities (stage) WHERE stage NOT IN ('won','lost');
CREATE INDEX opportunities_client_idx ON opportunities (client_id);
CREATE INDEX opportunities_owner_idx  ON opportunities (owner_user_id);
CREATE TRIGGER opportunities_updated_at BEFORE UPDATE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
