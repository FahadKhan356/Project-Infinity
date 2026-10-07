-- ============================================================================
-- 0010 — the client portal (brief §29)
--
-- Client login, the automated client portal, client approval/rejection and
-- automated client delivery. A client user belongs to exactly one client
-- record and sees only what was delivered to that client — never an
-- internal note, comment, price or unfinished file. Staff have no client.
--
-- A client's decision on a delivered file is recorded on the delivery, with
-- who took it and when; "request changes" hands the feedback to Sales, who
-- open the revision (§15, §17) exactly as for feedback by phone.
-- ============================================================================

ALTER TABLE users
  ADD COLUMN client_id bigint REFERENCES clients(id),
  ADD CONSTRAINT users_client_iff_client_role CHECK ((role = 'client') = (client_id IS NOT NULL));
CREATE INDEX users_client_idx ON users (client_id) WHERE client_id IS NOT NULL;

ALTER TABLE clients
  -- Files that clear final QA go straight to the portal instead of waiting
  -- for Sales to mark them delivered.
  ADD COLUMN portal_auto_deliver boolean NOT NULL DEFAULT false;

ALTER TABLE deliveries
  ADD COLUMN client_decision    text CHECK (client_decision IN ('approved','changes_requested')),
  ADD COLUMN client_decided_by  bigint REFERENCES users(id),
  ADD COLUMN client_decided_at  timestamptz,
  ADD CONSTRAINT deliveries_client_decision_complete CHECK (
    (client_decision IS NULL) = (client_decided_at IS NULL)
  );
