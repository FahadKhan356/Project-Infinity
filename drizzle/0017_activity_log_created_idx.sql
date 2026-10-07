-- The management-wide activity log (brief §25) reads the whole table newest first.
CREATE INDEX activity_log_created_idx ON activity_log (created_at DESC, id DESC);
