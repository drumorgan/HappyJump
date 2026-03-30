-- Make Famiglia tier permanent once achieved.
-- Once a player reaches 5 clean jumps (Famiglia), they never drop below it.

ALTER TABLE clients ADD COLUMN famiglia_permanent boolean NOT NULL DEFAULT false;

-- Backfill: any client who has ever reached Famiglia (legend tier) should be marked permanent
UPDATE clients SET famiglia_permanent = true WHERE tier = 'legend';
