// Dedicated auto-login edge function.
//
// Extracted from the single gateway function so it can live as a small
// standalone file (matches the Tornder / Valigia pattern). The gateway's
// `handleAutoLogin` handler is retained for backwards-compat but is no
// longer called by the client.
//
// Behaviour: verifies the stored session token hash, decrypts the stored
// Torn API key, and re-validates it against Torn. Permanent Torn failures
// (key revoked, access-level too low) delete the encrypted row; every
// other failure (rate limit, Torn 5xx, paused / inactive key, network
// blip) returns 503 `torn_unavailable` and leaves the row intact so the
// client can keep its session and retry on the next page load.
//
// Schema: reads / writes the same `player_secrets` table as the gateway
// (matching `sha256Base64(session_token)` hash format, same
// `failed_attempts` throttle). Deploy with `--no-verify-jwt`.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

// ── Crypto helpers (AES-256-GCM decrypt) ────────────────────
function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
async function importAesKey(rawB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    base64ToBytes(rawB64),
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );
}
async function decryptApiKey(ciphertextB64: string, ivB64: string): Promise<string> {
  const raw = Deno.env.get('API_KEY_ENCRYPTION_KEY');
  if (!raw) throw new Error('Missing API_KEY_ENCRYPTION_KEY');
  const key = await importAesKey(raw);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(ivB64) },
    key,
    base64ToBytes(ciphertextB64),
  );
  return new TextDecoder().decode(plaintext);
}

// Must match the gateway's `sha256Base64` helper — the `session_token_hash`
// column holds base64-encoded SHA-256 digests, not hex.
async function sha256Base64(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return bytesToBase64(new Uint8Array(digest));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Canonical opaque 401 — no distinction between "unknown player", "wrong
// token", "no stored key". Prevents probing for registered player_ids.
function sessionInvalid() {
  return json({ error: 'session_invalid' }, 401);
}

// ── Handler ──────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { player_id, session_token } = await req.json();
    if (!player_id || !session_token) return sessionInvalid();

    const { data: row } = await supabase
      .from('player_secrets')
      .select('api_key_enc, api_key_iv, session_token_hash, failed_attempts')
      .eq('torn_player_id', Number(player_id))
      .maybeSingle();

    if (!row?.api_key_enc || !row?.session_token_hash) return sessionInvalid();

    // Verify session token hash first. On mismatch, increment a counter and
    // destroy the row after 5 bad attempts — matches the gateway's throttle.
    const providedHash = await sha256Base64(String(session_token));
    if (!constantTimeEqual(providedHash, row.session_token_hash)) {
      const attempts = (row.failed_attempts ?? 0) + 1;
      if (attempts >= 5) {
        await supabase.from('player_secrets').delete().eq('torn_player_id', Number(player_id));
      } else {
        await supabase
          .from('player_secrets')
          .update({ failed_attempts: attempts })
          .eq('torn_player_id', Number(player_id));
      }
      return sessionInvalid();
    }

    // Decrypt stored key and re-validate against Torn.
    const apiKey = await decryptApiKey(row.api_key_enc, row.api_key_iv);

    let identData: any;
    try {
      const identRes = await fetch(
        `${TORN_API}/user/?selections=basic,profile&key=${apiKey}`,
      );
      identData = await identRes.json();
    } catch (err) {
      // Network / DNS / Torn outage — transient. Keep the row so the next
      // page load can retry.
      return json(
        { error: 'torn_unavailable', detail: (err as Error).message },
        503,
      );
    }

    if (identData.error) {
      // Torn error codes that mean the key itself is permanently dead:
      //   2  = Incorrect Key (revoked / deleted)
      //   16 = Access level of this key is not high enough
      // Everything else (5 rate limit, 8 IP block, 9 API disabled,
      // 13 inactive, 14 daily cap, 17 backend error, 18 paused) is
      // temporary — the key works once the condition clears, so we must
      // NOT nuke the row.
      const PERMANENT_TORN_ERRORS = [2, 16];
      const code = identData.error?.code;
      if (PERMANENT_TORN_ERRORS.includes(code)) {
        await supabase.from('player_secrets').delete().eq('torn_player_id', Number(player_id));
        return sessionInvalid();
      }
      return json(
        { error: 'torn_unavailable', code, detail: identData.error?.error },
        503,
      );
    }

    // Defence-in-depth: stored player_id must still match Torn's view.
    if (String(identData.player_id) !== String(player_id)) {
      await supabase.from('player_secrets').delete().eq('torn_player_id', Number(player_id));
      return sessionInvalid();
    }

    await supabase
      .from('player_secrets')
      .update({ failed_attempts: 0, last_login_at: new Date().toISOString() })
      .eq('torn_player_id', Number(player_id));

    return json({
      success: true,
      torn_id: String(identData.player_id),
      torn_name: identData.name,
      torn_faction: identData.faction?.faction_name || null,
      torn_level: identData.level,
      status: identData.status?.description || 'Unknown',
    });
  } catch (err) {
    return json({ error: `auto-login error: ${(err as Error).message}` }, 500);
  }
});
