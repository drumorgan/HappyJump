-- Referral partners: anyone can sign up for a referral link; each client they
-- bring in is attributed to them permanently (first referrer wins), and every
-- PAID policy from that client earns the partner a share of Giro's profit margin
-- (suggested_price − expected cost). Commission is snapshotted per transaction
-- and counts as owed only once the transaction reaches a paid status, so
-- expired / rejected requests never owe anything.
--
-- All access goes through the gateway (service role). RLS on with no anon
-- policies; the admin dashboard reads the two transaction columns it needs via
-- the existing "Admin read all transactions" policy.

CREATE TABLE IF NOT EXISTS partners (
  torn_id       text PRIMARY KEY,
  torn_name     text        NOT NULL,
  margin_share  numeric     NOT NULL DEFAULT 0.25 CHECK (margin_share >= 0 AND margin_share <= 1),
  active        boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE partners ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON partners FROM anon, public;
GRANT SELECT, INSERT, UPDATE, DELETE ON partners TO service_role;

-- Sticky attribution: set the first time a referred new client requests a policy.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS referred_by text REFERENCES partners(torn_id);

-- Per-transaction commission snapshot.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS referrer_torn_id  text REFERENCES partners(torn_id);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS commission_share  numeric;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS commission_amount bigint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_transactions_referrer ON transactions (referrer_torn_id) WHERE referrer_torn_id IS NOT NULL;

-- Commission payments Giro sent in-game (Send Money). log_id is the Torn log
-- entry key, so a rescan never double-records the same send.
CREATE TABLE IF NOT EXISTS partner_payments (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_torn_id  text        NOT NULL REFERENCES partners(torn_id),
  amount           bigint      NOT NULL CHECK (amount > 0),
  sent_at          timestamptz NOT NULL,
  log_id           text        UNIQUE,
  matched_by       text        NOT NULL DEFAULT 'auto',  -- auto (message said "commission") | manual
  created_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE partner_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON partner_payments FROM anon, public;
GRANT SELECT, INSERT, UPDATE, DELETE ON partner_payments TO service_role;
CREATE INDEX IF NOT EXISTS idx_partner_payments_partner ON partner_payments (partner_torn_id);

-- Giro's own Torn key, used only to read his log for commission sends.
-- Kept apart from player_secrets so signing out of the storefront can't
-- delete it, and out of config because config is publicly readable.
CREATE TABLE IF NOT EXISTS operator_secrets (
  id           integer     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  torn_id      text        NOT NULL,
  torn_name    text        NOT NULL,
  api_key_enc  text        NOT NULL,
  api_key_iv   text        NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE operator_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON operator_secrets FROM anon, authenticated, public;
GRANT SELECT, INSERT, UPDATE, DELETE ON operator_secrets TO service_role;
