-- Track cumulative amount paid by client (for underpayment handling)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS amount_paid bigint DEFAULT 0;
