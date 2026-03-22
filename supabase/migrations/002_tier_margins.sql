-- Replace single target_margin with per-tier margin columns
-- and remove unused worst_case_clients

ALTER TABLE config ADD COLUMN IF NOT EXISTS margin_new     decimal NOT NULL DEFAULT 0.18;
ALTER TABLE config ADD COLUMN IF NOT EXISTS margin_safe    decimal NOT NULL DEFAULT 0.15;
ALTER TABLE config ADD COLUMN IF NOT EXISTS margin_road    decimal NOT NULL DEFAULT 0.12;
ALTER TABLE config ADD COLUMN IF NOT EXISTS margin_legend  decimal NOT NULL DEFAULT 0.10;

-- Migrate existing target_margin value into margin_safe (closest match)
UPDATE config SET margin_safe = target_margin WHERE id = 1;

-- Drop old columns (safe to do — worst_case_clients is unused, target_margin replaced)
ALTER TABLE config DROP COLUMN IF EXISTS target_margin;
ALTER TABLE config DROP COLUMN IF EXISTS worst_case_clients;
