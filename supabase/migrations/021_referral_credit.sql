-- Apply referral balance to a new policy.
--
-- When a referral partner requests a policy, their full available commission
-- balance (capped at the price) is applied as credit. The buyer only owes
-- suggested_price − credit_applied in cash.
--
-- Nothing else is stored: a partner's balance is DERIVED as
--   earned − cash commission payments − credit_applied on their own
--   requested + paid-status policies
-- so a rejected / expired request stops counting and its credit returns to the
-- balance automatically, with no release step.
--
-- amount_paid stays CASH ONLY (that's what gets folded into current_reserve).
-- Revenue stats keep using suggested_price, so credit-funded policies still
-- count at full price.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS credit_applied bigint NOT NULL DEFAULT 0
  CHECK (credit_applied >= 0);

CREATE INDEX IF NOT EXISTS idx_transactions_credit
  ON transactions (torn_id) WHERE credit_applied > 0;

-- One open deal per player, enforced by the database. create-transaction already
-- checks this, but as a read-then-insert two fast taps could both pass and spend
-- the same credit twice. Skipped (with a NOTICE) if existing rows already
-- violate it, so the migration never fails on old data.
DO $$
BEGIN
  IF EXISTS (
    SELECT torn_id FROM transactions
    WHERE status IN ('requested', 'purchased')
    GROUP BY torn_id HAVING count(*) > 1
  ) THEN
    RAISE NOTICE 'Skipped uniq_transactions_one_open_deal: some players already have more than one requested/purchased row. Resolve those, then re-run this migration.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_transactions_one_open_deal
      ON transactions (torn_id) WHERE status IN ('requested', 'purchased');
  END IF;
END $$;
