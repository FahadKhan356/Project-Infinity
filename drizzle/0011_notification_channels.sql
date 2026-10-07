-- ============================================================================
-- 0011 — notifications beyond the portal (brief §29, §46)
--
-- Email, Slack and WhatsApp are optional integrations (§46): the portal's own
-- inbox is the record, and these only carry a copy of an inbox notification
-- outwards. Each person opts in per channel. A dispatcher (outside the web
-- process) sends what is due and records every attempt, so a mail server or
-- an internet outage delays a copy and never blocks the work that caused it.
-- ============================================================================

CREATE TABLE user_channel_prefs (
  user_id  bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel  text NOT NULL CHECK (channel IN ('email','slack','whatsapp')),
  enabled  boolean NOT NULL DEFAULT false,
  -- Where to send: blank for email (the login address), a Slack member ID,
  -- or a WhatsApp number in international format.
  address  text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel)
);

CREATE TABLE notification_dispatches (
  notification_id bigint NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('email','slack','whatsapp')),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, channel)
);
CREATE INDEX notification_dispatches_due_idx ON notification_dispatches (next_attempt_at) WHERE status = 'pending';
