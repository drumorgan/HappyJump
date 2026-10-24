-- La Scorta (xanax_only): Xanax-only OD insurance covering the first 4 Xanax
-- after purchase. Optional hardening: product_type had no CHECK constraint
-- (it was added outside the migration history), so this just pins it to the
-- four products the gateway writes. The column is already NOT NULL.
-- Fails if any existing row holds another value — check first with:
--   SELECT product_type, count(*) FROM transactions GROUP BY 1;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_product_type_check
  CHECK (product_type IN ('package', 'insurance', 'ecstasy_only', 'xanax_only'));
