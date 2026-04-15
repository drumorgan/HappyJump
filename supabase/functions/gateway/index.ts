// Gateway — single entry point for all Happy Jump edge function calls.
// Deployed with --no-verify-jwt. Routes requests by `action` field.
// Admin actions (update-config, admin-update-status, admin-update-client) verify auth internally.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';

const TORN_API = 'https://api.torn.com';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ── Helpers ──────────────────────────────────────────────────────────

function serviceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
}

// ── Encrypted session storage (player_secrets) ───────────────────────
// Raw Torn API keys are AES-256-GCM encrypted with a master key held in the
// Edge Function environment. Browsers hold only { player_id, session_token };
// the server stores SHA-256(session_token) so a DB leak can't be replayed
// directly. See supabase/migrations/010_player_secrets.sql.

let cachedEncKey: CryptoKey | null = null;

async function getEncryptionKey(): Promise<CryptoKey | null> {
  if (cachedEncKey) return cachedEncKey;
  const raw = Deno.env.get('API_KEY_ENCRYPTION_KEY');
  if (!raw) return null;
  let keyBytes: Uint8Array;
  try {
    keyBytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (keyBytes.length !== 32) return null;
  cachedEncKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return cachedEncKey;
}
