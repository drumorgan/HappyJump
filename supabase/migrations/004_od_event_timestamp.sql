-- Add od_event_timestamp column for OD replay prevention.
-- Stores Unix epoch SECONDS from Torn API event.timestamp field.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS od_event_timestamp bigint;

-- Unique partial index: hard-blocks the same OD event from being claimed twice by the same player.
-- The gateway also checks this in application code, but the DB constraint is the safety net.
CREATE UNIQUE INDEX IF NOT EXISTS ux_transactions_torn_id_od_ts
  ON transactions (torn_id, od_event_timestamp)
  WHERE od_event_timestamp IS NOT NULL;
