// api.js — Supabase-backed API module for Happy Jump
// All calls route through the single gateway Edge Function.

import { supabase } from './supabaseClient.js';

/**
 * Call the gateway Edge Function with a given action + payload.
 * All edge function calls go through this single entry point.
 */
async function gateway(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke('gateway', {
    body: { ...payload, action },
  });

  if (error) {
    // Extract real message from ReadableStream if present
    if (error.context?.body instanceof ReadableStream) {
      const text = await new Response(error.context.body).text();
      try {
        const parsed = JSON.parse(text);
        throw new Error(parsed.error || parsed.message || text);
      } catch (e) {
        if (e instanceof SyntaxError) throw new Error(text);
        throw e;
      }
    }
    throw new Error(error.message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

/**
 * Fetch the operator config row (pricing variables, reserve, etc.)
 * Public read via RLS.
 */
export async function getConfig() {
  const { data, error } = await supabase
    .from('config')
    .select('*')
    .single();

  if (error) throw new Error(`Failed to load config: ${error.message}`);
  return data;
}

/**
 * Validate a player's identity via their Torn API key.
 */
export async function validatePlayer(apiKey) {
  return gateway('validate-player', { key: apiKey });
}

/**
 * Store an encrypted copy of the user's API key server-side and receive an
 * opaque session token. The raw key is never stored client-side; only
 * { player_id, session_token } is kept in localStorage for later auto-login.
 */
export async function setApiKey(apiKey) {
  return gateway('set-api-key', { api_key: apiKey });
}

/**
 * Auto-login using a stored session. Hits the dedicated `auto-login` edge
 * function (extracted from the gateway) so transient Torn failures can
 * surface as a clean 503 `torn_unavailable` without going through the
 * generic gateway error layer. Re-validates the key against Torn; only
 * permanent key failures (codes 2, 16) delete the server-side row, so a
 * Torn rate-limit or 5xx no longer logs the user out.
 */
export async function autoLogin(playerId, sessionToken) {
  const { data, error } = await supabase.functions.invoke('auto-login', {
    body: { player_id: String(playerId), session_token: sessionToken },
  });

  if (error) {
    // Extract the structured error body — we want the server's `error`
    // string (e.g. 'torn_unavailable', 'session_invalid') to surface as
    // err.message so main.js can branch on it and preserve localStorage
    // on transient failures.
    if (error.context?.body instanceof ReadableStream) {
      const text = await new Response(error.context.body).text();
      try {
        const parsed = JSON.parse(text);
        throw new Error(parsed.error || parsed.message || text);
      } catch (e) {
        if (e instanceof SyntaxError) throw new Error(text);
        throw e;
      }
    }
    throw new Error(error.message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

/**
 * Revoke a session (Sign Out) — deletes the encrypted row server-side.
 */
export async function revokeSession(playerId, sessionToken) {
  return gateway('revoke-session', { player_id: String(playerId), session_token: sessionToken });
}

// Auth payload shape: either { key } (manual login path) or
// { player_id, session_token } (auto-login path). Accepts a string (treated
// as a raw key for backwards-compat) or an object with either shape.
function authPayload(auth) {
  if (!auth) return {};
  if (typeof auth === 'string') return { key: auth };
  if (auth.key || auth.api_key) return { key: auth.key || auth.api_key };
  if (auth.player_id && auth.session_token) {
    return { player_id: String(auth.player_id), session_token: auth.session_token };
  }
  return {};
}

/**
 * Proxy a Torn API call through the gateway. `auth` accepts either a raw key
 * string or a session object `{ player_id, session_token }`.
 */
export async function fetchTornProxy(auth, section, id, selections) {
  const data = await gateway('torn-proxy', { ...authPayload(auth), section, id, selections });
  // Torn API errors come in the response body, not as gateway errors
  if (data.error) {
    const err = data.error;
    throw new Error(typeof err === 'string' ? err : `Torn API error ${err.code}: ${err.error}`);
  }
  return data;
}

/**
 * Fetch market prices for Happy Jump items via the Torn API proxy.
 */
export async function fetchMarketPrices(auth) {
  const ITEM_IDS = { xanax: 206, ecstasy: 197, edvd: 366 };
  const data = await fetchTornProxy(auth, 'torn', '', 'items');

  const prices = {};
  for (const [name, id] of Object.entries(ITEM_IDS)) {
    const item = data.items?.[id];
    if (item) {
      prices[name] = {
        name: item.name,
        market_value: item.market_value,
        image: item.image,
      };
    }
  }
  return prices;
}

/**
 * Create a new transaction (request a Happy Jump package or insurance).
 * playerData should include product_type: 'package' | 'insurance'.
 * `auth` (session object or raw key) lets the gateway fetch live Torn market
 * prices so the locked-in snapshot matches what the user saw on screen.
 */
export async function createTransaction(playerData, auth) {
  return gateway('create-transaction', { ...playerData, ...authPayload(auth) });
}

/**
 * Fetch a player's transaction history by torn_id.
 */
export async function getPlayerTransactions(tornId) {
  return gateway('get-player-transactions', { torn_id: String(tornId) });
}

/**
 * Get current availability: how many packages can be sold right now.
 */
export async function getAvailability() {
  return gateway('get-availability');
}

/**
 * Get public stats: happy customers, total jumps insured, total paid out.
 */
export async function getPublicStats() {
  return gateway('get-public-stats');
}

/**
 * Update operator config (admin only). Passes auth header automatically.
 */
export async function updateConfig(updates) {
  return gateway('update-config', updates);
}

/**
 * Admin: update transaction status (handles reserve + client sync server-side).
 */
export async function adminUpdateStatus(txnId, tornId, newStatus) {
  return gateway('admin-update-status', { txn_id: txnId, torn_id: tornId, new_status: newStatus });
}

/**
 * Admin: update client record (notes, blocked status).
 */
export async function adminUpdateClient(tornId, updates) {
  return gateway('admin-update-client', { torn_id: tornId, ...updates });
}

/**
 * Admin: reject all pending transactions for a player and block them.
 */
export async function adminRejectAndBlock(tornId) {
  return gateway('admin-reject-and-block', { torn_id: tornId });
}

/**
 * Check drug usage progress (Xanax count + Ecstasy) — auto-closes if all used.
 * `auth` accepts a raw key string or a session object.
 */
export async function checkDrugUsage(auth, txnId) {
  return gateway('check-drug-usage', { ...authPayload(auth), txn_id: txnId });
}

/**
 * Report and verify an OD. `auth` accepts a raw key string or a session object.
 */
export async function reportOd(auth, txnId) {
  return gateway('report-od', { ...authPayload(auth), txn_id: txnId });
}

/**
 * Verify payment — gateway checks events for money sent to operator.
 * `auth` accepts a raw key string or a session object.
 */
export async function verifyPayment(auth, txnId) {
  return gateway('verify-payment', { ...authPayload(auth), txn_id: txnId });
}

export async function testApiAccess(apiKey) {
  return gateway('test-api-access', { api_key: apiKey });
}

export async function adminCheckEcstasy(apiKey) {
  return gateway('admin-check-ecstasy', { api_key: apiKey });
}

export async function adminCheckPayment(apiKey, recipient) {
  return gateway('admin-check-payment', { api_key: apiKey, recipient: recipient || null });
}

/**
 * Admin: test the Xanax/Ecstasy log-scan detection with an arbitrary API key
 * and `from_ts` (unix seconds). Mirrors check-drug-usage but doesn't need a
 * transaction row — operator can point it at their own account.
 */
export async function adminTestDrugCheck(apiKey, fromTs) {
  return gateway('admin-test-drug-check', { api_key: apiKey, from_ts: fromTs });
}

/**
 * Admin: resync all client stats from transactions (fixes stale data).
 */
export async function adminSyncAllClients() {
  return gateway('admin-sync-all-clients');
}

// ── Faction Events ───────────────────────────────────────────────────
// Self-contained leaderboard feature; does NOT touch the Happy Jump
// transactions / clients pipeline. See supabase/migrations/011_faction_events.sql.
//
// Faction Events have their OWN session table (faction_event_player_secrets,
// migration 012) and their own session token format. The fe* helpers below
// mint / refresh / revoke that session — completely independent from the
// Happy Jump session managed by setApiKey / autoLogin / revokeSession.
// Signing out of one does not affect the other.

/**
 * Mint a Faction Event session. Validates the Torn key (must have Log
 * permission), encrypts it server-side, and returns
 * { player_id, session_token, torn_id, torn_name, torn_faction }.
 * The raw key is never stored client-side.
 */
export async function feSetApiKey(apiKey) {
  return gateway('fe-set-api-key', { api_key: apiKey });
}

/**
 * Re-validate a stored Faction Event session against Torn. Returns the
 * caller's identity { torn_id, torn_name, torn_faction, ... } on success.
 * Permanent Torn errors (codes 2 / 16) cascade-delete the row server-side
 * and return `session_invalid`. Transient errors return a 503 with
 * `transient: true` — callers should keep the session and retry later.
 */
export async function feAutoLogin(playerId, sessionToken) {
  return gateway('fe-auto-login', {
    player_id: String(playerId),
    session_token: sessionToken,
  });
}

/**
 * Sign out — deletes the FE session row server-side. Idempotent: unknown
 * creds also return success so this can't be used as a membership oracle.
 * Does NOT delete the user's leaderboard rows; those stay until the next
 * sweep can no longer refresh them.
 */
export async function feRevokeSession(playerId, sessionToken) {
  return gateway('fe-revoke-session', {
    player_id: String(playerId),
    session_token: sessionToken,
  });
}

/**
 * Create a Faction Event. Now requires FE auth (a session minted via
 * feSetApiKey) — direct keys are no longer accepted because we need a
 * stable creator_torn_id for later edit authorization. Atomically inserts
 * the event AND the creator's participant row anchored at personalStartAt.
 * Response: { event, participant }.
 */
export async function createFactionEvent({
  title,
  drug_item_id,
  drug_name,
  starts_at,
  ends_at,
  personalStartAt,
  auth,
}) {
  return gateway('create-faction-event', {
    title,
    drug_item_id,
    drug_name,
    starts_at,
    ends_at,
    personal_start_at: personalStartAt,
    ...authPayload(auth),
  });
}

export async function getFactionEvent(eventId) {
  return gateway('get-faction-event', { event_id: eventId });
}

export async function listFactionEvents() {
  return gateway('list-faction-events');
}

/**
 * Creator-only patch of an event. Pass any subset of { title, drug_item_id,
 * drug_name, starts_at, ends_at } — fields you don't supply are not touched.
 * If drug or window changes, every participant row is invalidated server-
 * side so the next sweep recounts.
 */
export async function updateFactionEvent({
  eventId,
  auth,
  title,
  drug_item_id,
  drug_name,
  starts_at,
  ends_at,
}) {
  const payload = { event_id: eventId, ...authPayload(auth) };
  if (title !== undefined) payload.title = title;
  if (drug_item_id !== undefined) payload.drug_item_id = drug_item_id;
  if (drug_name !== undefined) payload.drug_name = drug_name;
  if (starts_at !== undefined) payload.starts_at = starts_at;
  if (ends_at !== undefined) payload.ends_at = ends_at;
  return gateway('update-faction-event', payload);
}

export async function joinFactionEvent({ eventId, auth, personalStartAt }) {
  return gateway('join-faction-event', {
    event_id: eventId,
    personal_start_at: personalStartAt,
    ...authPayload(auth),
  });
}

export async function refreshFactionEvent({ eventId, auth }) {
  return gateway('refresh-faction-event', {
    event_id: eventId,
    ...authPayload(auth),
  });
}

/**
 * Public sweep — refreshes up to 15 stale participant rows for the given
 * event using each participant's own server-stored key. No caller auth
 * needed; intended to be fired in the background after every event view
 * so the leaderboard self-heals without each viewer holding everyone
 * else's API key. Returns { refreshed, deleted, skipped, picked }.
 */
export async function refreshStaleParticipants(eventId) {
  return gateway('refresh-stale-participants', { event_id: eventId });
}

/**
 * Best-effort fetch of the user's in-game "Event start time" preference from
 * the Torn calendar API. Returns a guess + raw payload — frontend treats it
 * as a pre-fill hint, not a source of truth.
 */
export async function fetchTornEventStart(auth) {
  return gateway('fetch-torn-event-start', { ...authPayload(auth) });
}

