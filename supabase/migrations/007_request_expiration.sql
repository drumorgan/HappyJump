-- Add expires_at column for 48-hour request expiration
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- Index for auto-expire queries
CREATE INDEX IF NOT EXISTS idx_transactions_expires_at ON transactions (expires_at) WHERE status = 'requested';
