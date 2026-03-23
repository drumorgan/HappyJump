-- Add od_event_timestamp column for OD replay prevention
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS od_event_timestamp bigint;

-- Index for replay-prevention lookups
CREATE INDEX IF NOT EXISTS idx_transactions_od_event_timestamp
  ON transactions (torn_id, od_event_timestamp)
  WHERE od_event_timestamp IS NOT NULL;
