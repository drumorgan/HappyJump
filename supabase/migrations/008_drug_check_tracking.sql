-- Persist the most recent drug-usage check result on each transaction so the
-- admin dashboard can display what the client sees without needing their API key.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS last_drug_check_at timestamptz;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS last_xanax_count integer DEFAULT 0;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS last_ecstasy_used boolean DEFAULT false;
