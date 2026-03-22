-- Happy Jump Initial Schema
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor → New Query)

-- ============================================================
-- CONFIG TABLE (single-row, operator-managed pricing variables)
-- ============================================================
CREATE TABLE IF NOT EXISTS config (
  id              integer PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- enforce single row
  xanax_price     bigint    NOT NULL DEFAULT 850000,
  edvd_price      bigint    NOT NULL DEFAULT 4000000,
  ecstasy_price   bigint    NOT NULL DEFAULT 70000,
  xanax_od_pct    decimal   NOT NULL DEFAULT 0.03,
  ecstasy_od_pct  decimal   NOT NULL DEFAULT 0.05,
  rehab_bonus     bigint    NOT NULL DEFAULT 1000000,
  target_margin   decimal   NOT NULL DEFAULT 0.15,
  worst_case_clients integer NOT NULL DEFAULT 3,
  current_reserve bigint    NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Seed the single config row
INSERT INTO config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- RLS: anyone can read config, only service role can modify
ALTER TABLE config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read config"
  ON config FOR SELECT
  TO anon, authenticated
  USING (true);

-- No INSERT/UPDATE/DELETE policies for anon — only service role (bypasses RLS) can modify


-- ============================================================
-- TRANSACTIONS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  torn_id         text        NOT NULL,
  torn_name       text        NOT NULL,
  torn_faction    text,
  torn_level      integer,
  status          text        NOT NULL DEFAULT 'requested'
                  CHECK (status IN ('requested','purchased','closed_clean','od_xanax','od_ecstasy','payout_sent')),
  package_cost    bigint      NOT NULL,
  suggested_price bigint      NOT NULL,
  xanax_payout    bigint      NOT NULL,
  ecstasy_payout  bigint      NOT NULL,
  payout_amount   bigint,
  purchased_at    timestamptz,
  closes_at       timestamptz,
  closed_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- RLS: anon can only INSERT (request a package), never read others' data
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon can insert transactions"
  ON transactions FOR INSERT
  TO anon
  WITH CHECK (true);

-- Authenticated users (admin) can see all transactions
CREATE POLICY "Admin read all transactions"
  ON transactions FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admin update transactions"
  ON transactions FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions (status);
CREATE INDEX IF NOT EXISTS idx_transactions_torn_id ON transactions (torn_id);
CREATE INDEX IF NOT EXISTS idx_transactions_closes_at ON transactions (closes_at) WHERE status = 'purchased';
