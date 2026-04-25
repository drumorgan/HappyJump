-- Faction Events: persistent per-player API key storage so participants don't
-- have to re-enter their Torn key on every visit. Completely independent from
-- player_secrets (the Happy Jump session table) — different table, different
-- session tokens. Signing out of one does NOT sign you out of the other.
--
-- The session token granted from this table is scoped *only* to faction-event
-- actions (count drug uses). It cannot authorize Happy Jump payouts, admin, etc.
--
-- Encryption / brute-force-protection model is identical to player_secrets:
--   - AES-256-GCM, master key in Edge Function env API_KEY_ENCRYPTION_KEY
--   - browser holds only { player_id, session_token }; the SHA-256 of the token lives here
--   - 5 consecutive bad token attempts self-destructs the row
-- See migration 010_player_secrets.sql for context.

CREATE TABLE IF NOT EXISTS faction_event_player_secrets (
  torn_player_id      integer PRIMARY KEY,
  api_key_enc         text        NOT NULL,   -- base64 ciphertext
  api_key_iv          text        NOT NULL,   -- base64 12-byte IV (fresh per encrypt)
  session_token_hash  text        NOT NULL,   -- base64 SHA-256 of opaque session token
  key_version         integer     NOT NULL DEFAULT 1,
  failed_attempts     integer     NOT NULL DEFAULT 0,
  last_login_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE faction_event_player_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON faction_event_player_secrets FROM anon, authenticated, public;
GRANT SELECT, INSERT, UPDATE, DELETE ON faction_event_player_secrets TO service_role;

-- Track who created each event so the gateway can authorize edits.
-- Nullable because pre-existing events from PR #164 won't have a creator —
-- those events stay read-only / un-editable, which is fine.
ALTER TABLE faction_events
  ADD COLUMN IF NOT EXISTS creator_torn_id text;

CREATE INDEX IF NOT EXISTS faction_events_creator_torn_id_idx
  ON faction_events(creator_torn_id);
