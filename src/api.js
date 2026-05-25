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
 * Admin: run the full report-od logic dry against a client's API key.
 * Pass either a txn_id (uses that transaction's purchased_at) or a from_ts.
 * Returns events scan, log OD scan, drug-use counts, and the final
 * classification the live endpoint would have produced.
 */
export async function adminTestOdVerify({ apiKey, txnId, fromTs }) {
  return gateway('admin-test-od-verify', {
    api_key: apiKey,
    txn_id: txnId || undefined,
    from_ts: fromTs || undefined,
  });
}

/**
 * Admin: scan an API key's log for happiness-boosting item uses (EDVD, candy,
 * etc.) in a window and value them live. Used to verify the Choco-Jump
 * detection against a real account before wiring it into payouts. Pass a
 * from_ts (unix seconds); omit it to default to the last 24h.
 */
export async function adminDetectHappyItems({ apiKey, fromTs, untilTs }) {
  return gateway('admin-detect-happy-items', {
    api_key: apiKey,
    from_ts: fromTs || undefined,
    until_ts: untilTs || undefined,
  });
}

/**
 * Admin: for one active (purchased) transaction, scan the client's log for the
 * happiness items they've consumed since purchase and value them live — the
 * running Ecstasy-OD liability. Uses the client's server-stored key. Returns
 * { has_key, consumed, projected_ecstasy_payout, ... } or { has_key: false,
 * reason } when no scannable key is on file.
 */
export async function adminActiveConsumed(txnId) {
  return gateway('admin-active-consumed', { txn_id: txnId });
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

/**
 * List faction events visible to the caller. Backend filters server-side:
 *   - HJ admin (Supabase Auth header, auto-attached) — sees all events.
 *   - FE session — sees events they created OR have a participant row in.
 *   - No auth — empty list.
 */
export async function listFactionEvents(auth) {
  return gateway('list-faction-events', authPayload(auth));
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

/**
 * Delete a faction event. Authorized server-side either by:
 *   - the FE session whose torn_id matches event.creator_torn_id, or
 *   - a Happy Jump admin Supabase Auth session (operator backdoor).
 * `auth` may be omitted entirely when the caller is HJ-admin-signed-in
 * — supabase-js will include the Authorization header automatically.
 * Cascades to faction_event_participants via the FK ON DELETE CASCADE.
 */
export async function deleteFactionEvent({ eventId, auth }) {
  return gateway('delete-faction-event', {
    event_id: eventId,
    ...authPayload(auth),
  });
}

/**
 * Remove a single participant from a faction event leaderboard. Authorized
 * server-side either by:
 *   - the FE session whose torn_id matches event.creator_torn_id, or
 *   - a Happy Jump admin Supabase Auth session (operator backdoor).
 * Does not touch the participant's stored FE session — they can re-join
 * the event manually and will still get auto-added to future events the
 * creator makes.
 */
export async function removeFactionEventParticipant({ eventId, tornId, auth }) {
  return gateway('remove-faction-event-participant', {
    event_id: eventId,
    torn_id: String(tornId),
    ...authPayload(auth),
  });
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

/**
 * Read the most recent persisted scrape diagnostic for a single participant.
 * Authorized to HJ admin (via Supabase Auth — `auth` may be omitted) OR the
 * event's creator (FE session). Returns { participant, event, authorized_by }.
 */
export async function getParticipantScrapeLog({ eventId, tornId, auth }) {
  return gateway('get-participant-scrape-log', {
    event_id: eventId,
    torn_id: String(tornId),
    ...authPayload(auth),
  });
}

/**
 * Force a fresh scrape against another participant's stored API key and
 * persist the result. Same authorization model as get-participant-scrape-log.
 * Returns { participant, count, event, diag, authorized_by }. Errors with a
 * 409 if the participant has no stored key (signed out / never set one).
 */
export async function adminRescrapeParticipant({ eventId, tornId, auth }) {
  return gateway('admin-rescrape-participant', {
    event_id: eventId,
    torn_id: String(tornId),
    ...authPayload(auth),
  });
}

/**
 * Bulk re-scrape ALL participants in an event (capped at 100 per call).
 * Authorized to HJ admin OR event creator. Unlike refresh-stale-participants
 * (15 stale rows, no auth, public sweep), this ignores last_checked_at and
 * touches every row. Per-row outcomes:
 *   - refreshed: count + diag updated
 *   - transient: paused/rate-limited key — count NOT overwritten
 *   - deleted: permanent key error — secret + all participant rows removed
 *   - skipped: no stored key on file
 * Returns { refreshed, deleted, skipped, transient, total, transient_names,
 * deleted_names, skipped_names }.
 */
export async function forceRefreshAllParticipants({ eventId, auth }) {
  return gateway('force-refresh-all-participants', {
    event_id: eventId,
    ...authPayload(auth),
  });
}

/**
 * Mark every participant in an event as scrape_status='pending' so the
 * frontend can drive a timed one-at-a-time refresh loop. Idempotent.
 * Authorized to HJ admin OR event creator. Returns { marked, participants }.
 */
export async function startBulkRefresh({ eventId, auth }) {
  return gateway('start-bulk-refresh', {
    event_id: eventId,
    ...authPayload(auth),
  });
}

/**
 * Process the next pending participant in the queue: probe key, scrape,
 * persist count + diag, clear scrape_status. Frontend calls this in a
 * loop with a delay between calls until `done: true`. Returns one of:
 *   { done: true, remaining: 0 }                            — queue empty
 *   { done: false, remaining: N, status: 'refreshed', participant, count, diag }
 *   { done: false, remaining: N, status: 'transient_error' | 'permanent_error'
 *                                          | 'no_key' | 'decrypt_failed',
 *     participant, message, torn_error_code? }
 */
export async function scrapeNextPending({ eventId, auth }) {
  return gateway('scrape-next-pending', {
    event_id: eventId,
    ...authPayload(auth),
  });
}

