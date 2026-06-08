-- Faction Events: third event type — `blood_bags`.
-- Counts blood-bag activity in a player's user log. Three metrics per
-- participant, all derived from log code:
--   * Fills          — log=2340 ("Item use empty blood bag")
--   * Uses (good)    — log=2100 ("Item use blood bag") — own type, life increased
--   * Uses (wrong)   — log=2101 ("Item use blood bag") — wrong type, hospital
--
-- Window model matches drug_use: 10:00 TCT anchor + per-participant
-- personal_start_at (15-min slots). Drug fields stay NULL on blood_bag
-- events; the gateway rejects drug edits the same way it does for attacks.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'faction_events_event_type_check'
  ) THEN
    ALTER TABLE faction_events DROP CONSTRAINT faction_events_event_type_check;
  END IF;
  ALTER TABLE faction_events
    ADD CONSTRAINT faction_events_event_type_check
    CHECK (event_type IN ('drug_use', 'attacks', 'blood_bags'));
END $$;

-- Per-participant blood-bag metrics. Null on drug_use / attacks events.
ALTER TABLE faction_event_participants
  ADD COLUMN IF NOT EXISTS last_blood_fills integer,
  ADD COLUMN IF NOT EXISTS last_blood_uses_good integer,
  ADD COLUMN IF NOT EXISTS last_blood_uses_wrong integer;
