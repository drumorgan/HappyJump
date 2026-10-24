-- La Scorta (xanax_only): Xanax-only OD insurance covering the first 4 Xanax
-- after purchase. product_type was added outside the migration history, so
-- drop any CHECK constraint on it (whatever its name) and recreate one that
-- allows all four products. NULL still passes (legacy rows read as 'package').

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.transactions'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%product_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.transactions DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_product_type_check
  CHECK (product_type IN ('package', 'insurance', 'ecstasy_only', 'xanax_only'));
