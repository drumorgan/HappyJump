-- Faction Events: lightweight leaderboards that count item-use log entries
-- (e.g. "who drank the most beer" / "who used the most Cannabis") inside a
-- bounded time window. Completely independent of the Happy Jump transaction
-- pipeline — these tables share the gateway and the Torn-log scanner, nothing
-- else.
--
-- An "event" defines what to count (drug_item_id) and the global window
-- (starts_at .. ends_at). Each participant supplies their own personal
-- start time (so a player can join late or count from when they got to the
-- bar) — counts span [personal_start_at, ends_at]. All writes flow through
-- the gateway Edge Function (service-role); the anon key only reads.

CREATE TABLE IF NOT EXISTS faction_events (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text        NOT NULL,
  drug_item_id  integer     NOT NULL,
  drug_name     text        NOT NULL,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS faction_event_participants (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           uuid        NOT NULL REFERENCES faction_events(id) ON DELETE CASCADE,
  torn_id            text        NOT NULL,
  torn_name          text        NOT NULL,
  torn_faction       text,
  personal_start_at  timestamptz NOT NULL,
  last_count         integer     NOT NULL DEFAULT 0,
  last_checked_at    timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, torn_id)
);

CREATE INDEX IF NOT EXISTS faction_event_participants_event_idx
  ON faction_event_participants(event_id);

CREATE INDEX IF NOT EXISTS faction_events_created_at_idx
  ON faction_events(created_at DESC);

-- All writes go through the gateway with the service role. Anyone with the
-- event id (UUID v4 = ~122 bits of entropy) can read the leaderboard.
ALTER TABLE faction_events              ENABLE ROW LEVEL SECURITY;
ALTER TABLE faction_event_participants  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon read faction_events"
  ON faction_events
  FOR SELECT
  USING (true);

CREATE POLICY "anon read faction_event_participants"
  ON faction_event_participants
  FOR SELECT
  USING (true);

REVOKE INSERT, UPDATE, DELETE ON faction_events             FROM anon, authenticated, public;
REVOKE INSERT, UPDATE, DELETE ON faction_event_participants FROM anon, authenticated, public;
GRANT  SELECT, INSERT, UPDATE, DELETE ON faction_events             TO service_role;
GRANT  SELECT, INSERT, UPDATE, DELETE ON faction_event_participants TO service_role;
