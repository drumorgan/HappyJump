-- Revert migration 008. The cached drug-check columns are not used:
-- admin cannot run live detection without the client's API key (which we
-- deliberately do not store), so there is nothing to display admin-side.
-- Drug usage is tracked only on the client's own active policy view.
ALTER TABLE transactions DROP COLUMN IF EXISTS last_drug_check_at;
ALTER TABLE transactions DROP COLUMN IF EXISTS last_xanax_count;
ALTER TABLE transactions DROP COLUMN IF EXISTS last_ecstasy_used;
