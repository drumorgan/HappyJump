-- Add clients table to normalize player data and track stats/notes/blocking

CREATE TABLE clients (
  torn_id          text PRIMARY KEY,
  torn_name        text NOT NULL,
  torn_faction     text,
  torn_level       integer,
  clean_count      integer  NOT NULL DEFAULT 0,
  tier             text     NOT NULL DEFAULT 'new',
  total_spent      bigint   NOT NULL DEFAULT 0,
  total_payouts    bigint   NOT NULL DEFAULT 0,
  transaction_count integer NOT NULL DEFAULT 0,
  admin_notes      text     NOT NULL DEFAULT '',
  is_blocked       boolean  NOT NULL DEFAULT false,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;

-- Admin (authenticated) can read and update clients
CREATE POLICY "Authenticated can read clients" ON clients
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can update clients" ON clients
  FOR UPDATE TO authenticated USING (true);

-- Index for fast lookups
CREATE INDEX idx_clients_tier ON clients (tier);
CREATE INDEX idx_clients_is_blocked ON clients (is_blocked) WHERE is_blocked = true;

-- Seed clients from existing transactions
INSERT INTO clients (torn_id, torn_name, torn_faction, torn_level, clean_count, tier,
                     total_spent, total_payouts, transaction_count, first_seen_at)
SELECT
  torn_id,
  (array_agg(torn_name ORDER BY created_at DESC))[1],
  (array_agg(torn_faction ORDER BY created_at DESC))[1],
  (array_agg(torn_level ORDER BY created_at DESC))[1],
  COUNT(*) FILTER (WHERE status = 'closed_clean'),
  CASE
    WHEN COUNT(*) FILTER (WHERE status = 'closed_clean') >= 5 THEN 'legend'
    WHEN COUNT(*) FILTER (WHERE status = 'closed_clean') >= 3 THEN 'road'
    WHEN COUNT(*) FILTER (WHERE status = 'closed_clean') >= 1 THEN 'safe'
    ELSE 'new'
  END,
  COALESCE(SUM(suggested_price) FILTER (WHERE status IN ('closed_clean', 'payout_sent')), 0),
  COALESCE(SUM(payout_amount) FILTER (WHERE status = 'payout_sent'), 0),
  COUNT(*),
  MIN(created_at)
FROM transactions
GROUP BY torn_id
ON CONFLICT (torn_id) DO NOTHING;
