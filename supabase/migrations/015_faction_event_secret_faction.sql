-- Auto-add faction members to new events.
--
-- When a user creates a Faction Event, the gateway looks up every other
-- player whose stored FE session is in the same Torn faction and seeds a
-- participant row for them — they don't need to log in or join manually.
-- For that lookup we need the player's faction (and a display name to put
-- on the seeded participant row, since faction_event_participants.torn_name
-- is NOT NULL — see migration 011).
--
-- Captured / refreshed on every fe-set-api-key and fe-auto-login. Pre-existing
-- rows have NULLs until their owner next signs in; that's fine — they just
-- won't get auto-added until they re-validate.

ALTER TABLE faction_event_player_secrets
  ADD COLUMN IF NOT EXISTS torn_name         text,
  ADD COLUMN IF NOT EXISTS torn_faction_id   integer,
  ADD COLUMN IF NOT EXISTS torn_faction_name text;

CREATE INDEX IF NOT EXISTS faction_event_player_secrets_faction_idx
  ON faction_event_player_secrets(torn_faction_id);
