-- Encrypted per-player API key storage for frictionless auto-login.
-- The raw Torn API key is encrypted with AES-256-GCM using a master key held in the
-- Edge Function environment (`API_KEY_ENCRYPTION_KEY`). The browser only ever holds
-- `{ player_id, session_token }`; the session token's SHA-256 is what lives here, so
-- a DB leak alone cannot be used to impersonate a user.

CREATE TABLE IF NOT EXISTS player_secrets (
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

-- Service-role-only access. With RLS enabled and zero policies, the anon key
-- literally cannot read or write this table. All access flows through the
-- gateway Edge Function using SUPABASE_SERVICE_ROLE_KEY.
ALTER TABLE player_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON player_secrets FROM anon, authenticated, public;
GRANT SELECT, INSERT, UPDATE, DELETE ON player_secrets TO service_role;
