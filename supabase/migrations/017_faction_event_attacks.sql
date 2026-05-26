-- Faction Events: second event type — `attacks`.
-- Original event_type `drug_use` counts item-use log entries. The new
-- `attacks` type hits Torn's user/attacks selection and surfaces three
-- numbers per participant (count of offensive attacks, total respect
-- gained, single best-respect attack) so the leaderboard can show three
-- sortable columns from one API call per refresh.
--
-- drug_item_id / drug_name lose their NOT NULL so attack events don't
-- carry meaningless drug references. event_type is constrained so we
-- can keep branching simple in the gateway.

ALTER TABLE faction_events
  ADD COLUMN IF NOT EXISTS event_type text NOT NULL DEFAULT 'drug_use';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'faction_events_event_type_check'
  ) THEN
    ALTER TABLE faction_events
      ADD CONSTRAINT faction_events_event_type_check
      CHECK (event_type IN ('drug_use', 'attacks'));
  END IF;
END $$;

ALTER TABLE faction_events
  ALTER COLUMN drug_item_id DROP NOT NULL,
  ALTER COLUMN drug_name DROP NOT NULL;

-- Per-participant attack metrics. Null on drug_use events. Stored as
-- numeric so Torn's two-decimal respect values survive round-trips.
ALTER TABLE faction_event_participants
  ADD COLUMN IF NOT EXISTS last_respect_total numeric,
  ADD COLUMN IF NOT EXISTS last_best_single_respect numeric;
