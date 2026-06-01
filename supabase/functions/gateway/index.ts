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

function b64Encode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64Decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function encryptApiKey(plain: string): Promise<{ ciphertext: string; iv: string } | null> {
  const key = await getEncryptionKey();
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plain);
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return { ciphertext: b64Encode(new Uint8Array(cipherBuf)), iv: b64Encode(iv) };
}

async function decryptApiKey(ciphertext: string, iv: string): Promise<string | null> {
  const key = await getEncryptionKey();
  if (!key) return null;
  try {
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64Decode(iv) },
      key,
      b64Decode(ciphertext),
    );
    return new TextDecoder().decode(plainBuf);
  } catch {
    return null;
  }
}

async function sha256Base64(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuf = await crypto.subtle.digest('SHA-256', data);
  return b64Encode(new Uint8Array(hashBuf));
}

function randomTokenBase64(bytes = 32): string {
  return b64Encode(crypto.getRandomValues(new Uint8Array(bytes)));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Returns the canonical "auth failed" response. Intentionally opaque: no
// `code` field, no distinction between "player not registered" and "wrong
// token" and "rate-limited-out". Callers that reach this path can't probe
// the table for registered player_ids.
function sessionInvalid(): Response {
  return json({ error: 'session_invalid' }, 401);
}

// Generic session resolver — shared by Happy Jump (player_secrets) and
// Faction Events (faction_event_player_secrets). Each context has its own
// table so signing out of one does not affect the other; the schema is
// identical across both tables (see migrations 010 and 012). Handles the
// constant-time-compare + 5-strike self-destruct + opaque-401 logic in one
// place.
async function resolveSessionFromTable(
  body: any,
  table: 'player_secrets' | 'faction_event_player_secrets',
): Promise<{ key: string; torn_id: string } | Response> {
  const { player_id, session_token } = body;
  if (!player_id || !session_token) {
    return json({ error: 'Missing api_key or session credentials' }, 400);
  }

  const enc = await getEncryptionKey();
  if (!enc) {
    return json({ error: 'Encryption not configured (missing API_KEY_ENCRYPTION_KEY)' }, 500);
  }

  const supabase = serviceClient();
  const { data: row } = await supabase
    .from(table)
    .select('torn_player_id, api_key_enc, api_key_iv, session_token_hash, failed_attempts')
    .eq('torn_player_id', Number(player_id))
    .maybeSingle();

  // Compute the provided token hash whether or not the row exists — keeps
  // response timing indistinguishable between "registered" and "unregistered"
  // player_ids so this endpoint can't be used as a membership oracle.
  const providedHash = await sha256Base64(String(session_token));

  if (!row) return sessionInvalid();

  if (!constantTimeEqual(providedHash, row.session_token_hash)) {
    const next = (row.failed_attempts || 0) + 1;
    if (next >= 5) {
      // Self-destruct after 5 bad attempts. Response is the same opaque 401
      // so an attacker can't tell they just burned the last strike.
      await supabase.from(table).delete().eq('torn_player_id', row.torn_player_id);
    } else {
      await supabase
        .from(table)
        .update({ failed_attempts: next })
        .eq('torn_player_id', row.torn_player_id);
    }
    return sessionInvalid();
  }

  const key = await decryptApiKey(row.api_key_enc, row.api_key_iv);
  if (!key) return sessionInvalid();
  return { key, torn_id: String(row.torn_player_id) };
}

// Resolve a Torn API key from either a direct body field (`key` / `api_key`)
// or from Happy Jump session credentials (`player_id` + `session_token`).
// Returns either `{ key, torn_id }` or a Response with a clear 4xx/5xx error.
async function resolveApiKey(body: any): Promise<{ key: string; torn_id: string } | Response> {
  const direct = body.key || body.api_key;
  if (direct) return { key: direct, torn_id: '' };
  return resolveSessionFromTable(body, 'player_secrets');
}

// Same shape as resolveApiKey, but backed by the Faction Events secrets
// table. A session minted via fe-set-api-key cannot authorize Happy Jump
// actions and vice versa.
async function resolveFactionEventApiKey(body: any): Promise<{ key: string; torn_id: string } | Response> {
  const direct = body.key || body.api_key;
  if (direct) return { key: direct, torn_id: '' };
  return resolveSessionFromTable(body, 'faction_event_player_secrets');
}

// Torn API error codes that mean "this key will never work again":
//   2  = Incorrect key (revoked / never valid)
//   16 = Access level too low (key downgraded below required permissions)
// Codes 5/8/9 (limit reached / IP banned / API offline) are transient and
// must NOT trigger destructive cleanup — the key is fine, the network isn't.
function isPermanentTornKeyError(code: number | null | undefined): boolean {
  return code === 2 || code === 16;
}

// When a Faction Event participant's key is permanently revoked, drop the
// secret row AND every participant row anchored on that torn_id across all
// events. The participant rows can no longer be refreshed (no key), so
// leaving them creates a misleading frozen leaderboard. Re-joining after a
// fresh sign-in recreates the rows from scratch.
async function cascadeDeleteFactionEventSecret(
  supabase: any,
  tornId: number | string,
): Promise<void> {
  const idNum = Number(tornId);
  if (!Number.isFinite(idNum)) return;
  await supabase.from('faction_event_player_secrets').delete().eq('torn_player_id', idNum);
  await supabase.from('faction_event_participants').delete().eq('torn_id', String(idNum));
}

async function requireAuth(req: Request) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;

  const anonClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: { user }, error } = await anonClient.auth.getUser();
  if (error || !user) return null;
  return user;
}

function computeTier(cleanCount: number): string {
  if (cleanCount >= 5) return 'legend';
  if (cleanCount >= 3) return 'road';
  if (cleanCount >= 1) return 'safe';
  return 'new';
}

// Count total clean closes — ODs do not reset progress toward next tier.
function computeCleanCount(txns: any[]): number {
  return txns.filter((t: any) => t.status === 'closed_clean').length;
}

// Recompute and upsert client stats from transactions.
// Optional `extraFields` allows setting torn_name etc. when available.
async function syncClientStats(supabase: any, tornId: string, extraFields?: Record<string, unknown>) {
  const [{ data: allTxns }, { data: existingClient }] = await Promise.all([
    supabase
      .from('transactions')
      .select('status, suggested_price, payout_amount, created_at, torn_name')
      .eq('torn_id', tornId),
    supabase
      .from('clients')
      .select('famiglia_permanent')
      .eq('torn_id', tornId)
      .maybeSingle(),
  ]);

  const txns = allTxns || [];
  const cleanCount = computeCleanCount(txns);
  const txnCount = txns.length;
  const totalSpent = txns
    .filter((t: any) => ['closed_clean', 'payout_sent'].includes(t.status))
    .reduce((s: number, t: any) => s + Number(t.suggested_price || 0), 0);
  const totalPayouts = txns
    .filter((t: any) => t.status === 'payout_sent')
    .reduce((s: number, t: any) => s + Number(t.payout_amount || 0), 0);

  // Famiglia is permanent: once reached, never drops below legend
  const alreadyFamiglia = existingClient?.famiglia_permanent === true;
  const computedTier = computeTier(cleanCount);
  const isFamigliaNow = alreadyFamiglia || computedTier === 'legend';
  const effectiveTier = isFamigliaNow ? 'legend' : computedTier;

  // If torn_name not provided in extraFields, pull from most recent transaction
  const upsertFields: Record<string, unknown> = {
    torn_id: tornId,
    clean_count: cleanCount,
    tier: effectiveTier,
    famiglia_permanent: isFamigliaNow,
    transaction_count: txnCount,
    total_spent: totalSpent,
    total_payouts: totalPayouts,
    updated_at: new Date().toISOString(),
    ...extraFields,
  };
  if (!upsertFields.torn_name && txns.length > 0) {
    const name = txns[txns.length - 1]?.torn_name;
    if (name) upsertFields.torn_name = name;
  }

  const { error } = await supabase.from('clients').upsert(upsertFields, { onConflict: 'torn_id' });

  if (error) console.error(`[syncClientStats] Failed for ${tornId}:`, error.message);
  return { error: error?.message || null, cleanCount, tier: effectiveTier };
}

// ── Email notifications ─────────────────────────────────────────────

async function sendNotificationEmail(subject: string, body: string) {
  const host = Deno.env.get('SMTP_HOST');
  const user = Deno.env.get('SMTP_USER');
  const pass = Deno.env.get('SMTP_PASS');
  const notify = Deno.env.get('NOTIFY_EMAIL');

  console.log(`[EMAIL] Attempting to send: "${subject}" to ${notify || '(not set)'}`);

  if (!host || !user || !pass || !notify) {
    console.error('[EMAIL] Missing SMTP env vars — host:', !!host, 'user:', !!user, 'pass:', !!pass, 'notify:', !!notify);
    return;
  }

  // Convert newline-separated body to HTML paragraphs
  const htmlBody = body
    .split('\n')
    .map(line => line.trim() === '' ? '<br>' : `<p style="margin:0 0 4px 0;">${line}</p>`)
    .join('\n');

  const html = `
<div style="font-family: -apple-system, sans-serif; font-size: 14px; color: #222; max-width: 500px;">
  ${htmlBody}
  <hr style="border:none; border-top:1px solid #ddd; margin:16px 0 8px;">
  <p style="margin:0; font-size:12px; color:#999;">Happy Jump Insurance — Giro Vagabondo</p>
</div>`.trim();

  try {
    const client = new SMTPClient({
      connection: {
        hostname: host,
        port: Number(Deno.env.get('SMTP_PORT') || 465),
        tls: true,
        auth: { username: user, password: pass },
      },
    });

    await client.send({
      from: user,
      to: notify,
      subject,
      html,
    });

    await client.close();
    console.log('[EMAIL] Sent successfully');
  } catch (e) {
    console.error('[EMAIL] Send failed:', e?.message || e);
  }
}

function formatMoney(amount: number): string {
  return '$' + amount.toLocaleString('en-US');
}

function formatStatus(status: string): string {
  const labels: Record<string, string> = {
    requested: 'Requested',
    purchased: 'Purchased',
    closed_clean: 'Clean Close',
    od_xanax: 'OD — Xanax',
    od_ecstasy: 'OD — Ecstasy',
    payout_sent: 'Payout Sent',
    rejected: 'Rejected',
  };
  return labels[status] || status;
}

// ── Atomic reserve adjustment ───────────────────────────────────────
// Avoids read-then-write race conditions by using a Postgres function
// that does: UPDATE config SET current_reserve = current_reserve + amount WHERE id = 1

async function adjustReserve(supabase: any, amount: number) {
  const { data, error } = await supabase.rpc('adjust_reserve', { amount });
  if (error) {
    console.error('[adjustReserve] RPC failed:', error.message);
    throw error;
  }
  return data; // returns new current_reserve
}

// ── Drug usage detection (shared helpers) ────────────────────────────
// Paginates through Torn API log entries to find drug usage.
// Uses structured data (item IDs) as primary check, text matching as fallback.

const ECSTASY_ITEM_ID = 197;
const XANAX_ITEM_ID = 206;
const EDVD_ITEM_ID = 366;

// A Happy Jump package only ever ships 5x Erotic DVDs, so the Ecstasy-OD
// payout replaces at most 5 EDVDs even if the client consumed more before
// they jumped (some players can take 9+ before an OD). We make them whole on
// the covered 5; any extra EDVDs they chose to use on top of the package are
// on them.
const EDVD_PAYOUT_CAP = 5;

// Match a first-person OD narrative against Torn's events feed text and
// classify by drug. Two narrative shapes are observed in the wild:
//
//   1. "You overdosed on some Xanax going to the hospital for 83h 20m..."
//      — drug name immediately follows "on" (with up to 3 optional filler
//      words like "some" / "the").
//
//   2. "You took some Xanax and downed a glass of water. A headache was
//      followed by nausea and vomiting. You overdosed."
//      — drug name in the FIRST sentence ("you took some <drug>"), with
//      "you overdosed" appearing later as its own sentence. This is the
//      observed format for Xanax ODs in 2026 events feeds, and was the
//      cause of the long-running false-negative on Xanax claims (regex
//      assumed shape 1 only).
//
// Both anchored on "you" + "overdosed" so third-party narratives like
// "someone in your faction overdosed on Xanax" or "you attacked X who
// had overdosed on Xanax" don't match. Caller passes the lowercased,
// HTML-stripped event text. Returns the matched drug or null.
function classifyOdNarrative(evtTextLower: string): 'xanax' | 'ecstasy' | null {
  const patterns = [
    // Shape 1: "you overdosed on <drug>"
    /\byou\s+overdosed?\s+on\s+(?:\w+\s+){0,3}(xanax|ecstasy)\b/,
    // Shape 2: "you took ... <drug> ... you overdosed" (single event narrative,
    // bounded at 500 chars to keep matches within one event)
    /\byou\s+took\s+(?:\w+\s+){0,5}(xanax|ecstasy)\b[\s\S]{0,500}\byou\s+overdosed?\b/,
  ];
  for (const re of patterns) {
    const m = evtTextLower.match(re);
    if (m && (m[1] === 'xanax' || m[1] === 'ecstasy')) return m[1];
  }
  return null;
}

// Verified Torn narrative samples (provided by operator) — all 4 matched:
//   "You used some Xanax gaining 250 energy and 75 happiness"
// The drug name lives in the narrative, NOT in entry.title (which is a
// category label like "Item use"). Detection matches on narrative text.

// Returns { match: boolean, reason?: string } — the reason explains WHY a
// non-match was rejected so callers (e.g. the FE diagnostic UI) can surface
// false-negative shapes without dumping every entry.
function entryMatchesDrugUseWithReason(
  entry: any,
  drugName: string,
  itemId: number,
): { match: boolean; reason?: string } {
  const drugLower = drugName.toLowerCase();

  // Build a haystack from every stringy field Torn might put the narrative in
  const parts: string[] = [];
  if (entry.title) parts.push(String(entry.title));
  if (entry.log) parts.push(String(entry.log));
  if (entry.category) parts.push(String(entry.category));
  if (entry.data) parts.push(JSON.stringify(entry.data));
  if (entry.params) parts.push(JSON.stringify(entry.params));
  const hay = parts.join(' ').toLowerCase();

  if (hay.includes('overdos')) return { match: false, reason: 'overdose' };
  const exclusionMatch = /\b(buy|bought|buying|purchase|purchased|sold|sell|sent|received|dumped|bazaar|market|trade|traded|gift|abroad)\b/.exec(hay);
  if (exclusionMatch) return { match: false, reason: `excluded keyword: "${exclusionMatch[1]}"` };

  const itemField = entry.data?.item;
  const structuredMatch =
    itemField === itemId ||
    itemField === String(itemId) ||
    (typeof itemField === 'string' && itemField.toLowerCase() === drugLower);

  // Narrative signal: drug name plus a "use" verb or stat phrase. Torn's
  // user-log titles use the present tense ("Item use cannabis"), not the
  // past tense ("You used some cannabis") — so we match BOTH forms.
  // The "gaining"/"energy"/"happiness" branches catch the long-form
  // narratives the operator originally verified for Xanax.
  const narrativeMatch =
    hay.includes(drugLower) &&
    (hay.includes('used some ' + drugLower) ||
      hay.includes('used ' + drugLower) ||
      hay.includes('use ' + drugLower) ||         // "item use cannabis"
      hay.includes('item use ' + drugLower) ||    // explicit Torn title
      hay.includes('gaining') ||
      hay.includes('energy') ||
      hay.includes('happiness'));

  if (structuredMatch || narrativeMatch) return { match: true };
  return {
    match: false,
    reason: `no match (data.item=${JSON.stringify(itemField)}, hay-has-drug=${hay.includes(drugLower)})`,
  };
}

function entryMatchesDrugUse(entry: any, drugName: string, itemId: number): boolean {
  return entryMatchesDrugUseWithReason(entry, drugName, itemId).match;
}

// Item IDs whose use is NOT counted as a "happy item" because they're already
// covered by the fixed recipe quantities in the payout: 4× Xanax (energy/happy
// stack) and 1× Ecstasy (the OD trigger itself). Every OTHER happiness-gaining
// item-use (Erotic DVD, candy/Choco-Jump items, etc.) is what we replace.
const HAPPY_EXCLUDED_ITEM_IDS = new Set<number>([XANAX_ITEM_ID, ECSTASY_ITEM_ID]);

// Decide whether a single Torn user-log entry is a "client consumed a
// happiness-boosting item" event. Dynamic by design (per operator decision):
// instead of an allow-list of candy IDs, we match ANY item-use entry that
// shows a happiness GAIN, then identify the item by its structured
// `data.item` ID (authoritative — needed to value it later). Reuses the same
// buy/trade/overdose exclusions as the drug-use matcher so purchases, bazaar
// pulls, and ODs never count as a use.
//
// Returns the resolved itemId (null if no numeric item ID present, in which
// case we can't value it so it can't be a happy-item match) plus a reason for
// non-matches so the admin diagnostic can surface false negatives.
function entryHappyGainWithReason(
  entry: any,
): { match: boolean; itemId: number | null; reason?: string } {
  const parts: string[] = [];
  if (entry.title) parts.push(String(entry.title));
  if (entry.log) parts.push(String(entry.log));
  if (entry.category) parts.push(String(entry.category));
  if (entry.data) parts.push(JSON.stringify(entry.data));
  if (entry.params) parts.push(JSON.stringify(entry.params));
  const hay = parts.join(' ').toLowerCase();

  // Structured item ID is required — it's how we identify and later value the
  // item. Narrative-only happiness gains we can't price, so skip them.
  const itemField = entry.data?.item;
  let itemId: number | null = null;
  if (typeof itemField === 'number') itemId = itemField;
  else if (typeof itemField === 'string' && /^\d+$/.test(itemField)) itemId = Number(itemField);
  if (itemId === null) return { match: false, itemId: null, reason: 'no numeric data.item' };

  if (hay.includes('overdos')) return { match: false, itemId, reason: 'overdose' };
  const exclusionMatch = /\b(buy|bought|buying|purchase|purchased|sold|sell|sent|received|dumped|bazaar|market|trade|traded|gift|abroad)\b/.exec(hay);
  if (exclusionMatch) return { match: false, itemId, reason: `excluded keyword: "${exclusionMatch[1]}"` };

  if (HAPPY_EXCLUDED_ITEM_IDS.has(itemId)) {
    return { match: false, itemId, reason: 'xanax/ecstasy (handled by fixed recipe)' };
  }

  if (!hay.includes('happ')) return { match: false, itemId, reason: 'no happiness mention' };
  // Reject happiness LOSS narratives (some items reduce happy).
  if (/\b(lost|losing|lose|reduc|decreas)\b/.test(hay)) {
    return { match: false, itemId, reason: 'happiness loss, not gain' };
  }
  const gainSignal = hay.includes('gain') || hay.includes('used') || hay.includes('use ') || hay.includes('item use');
  if (!gainSignal) return { match: false, itemId, reason: 'no gain/use verb' };

  return { match: true, itemId };
}

async function findEcstasyUsageInLog(
  apiKey: string,
  sinceTimestamp?: number, // only find usage after this time (e.g. purchased_at)
  maxPages = 30,
): Promise<{ timestamp: number; detail: string } | null> {
  let toParam = '';
  let earliestUsage: { timestamp: number; detail: string } | null = null;
  const cutoff = sinceTimestamp || 0;
  const fromParam = sinceTimestamp ? `&from=${sinceTimestamp}` : '';
  let lastOldestTs = Infinity;
  let pagesFetched = 0;
  let totalEntries = 0;

  for (let page = 0; page < maxPages; page++) {
    const url = `${TORN_API}/user/?selections=log${fromParam}${toParam}&key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error || !data.log) {
      console.log(`[findEcstasyUsageInLog] page=${page} error=${JSON.stringify(data.error || 'no log')}`);
      break;
    }

    const entriesKv = Object.entries(data.log) as [string, any][];
    if (entriesKv.length === 0) {
      console.log(`[findEcstasyUsageInLog] page=${page} empty page, stopping`);
      break;
    }
    pagesFetched++;
    totalEntries += entriesKv.length;
    console.log(`[findEcstasyUsageInLog] page=${page} entries=${entriesKv.length}`);

    let pageMatches = 0;
    for (const [, entry] of entriesKv) {
      const ts = entry.timestamp || 0;
      if (ts < cutoff) continue; // before our window
      if (!entryMatchesDrugUse(entry, 'Ecstasy', ECSTASY_ITEM_ID)) continue;

      const narrative = String(entry.log || entry.title || '').slice(0, 200);
      if (!earliestUsage || ts < earliestUsage.timestamp) {
        earliestUsage = {
          timestamp: ts,
          detail: `Ecstasy @ ${new Date(ts * 1000).toISOString()} — "${narrative}"`,
        };
      }
      pageMatches++;
    }
    console.log(`[findEcstasyUsageInLog] page=${page} matchesThisPage=${pageMatches} earliestSoFar=${earliestUsage?.timestamp || 'none'}`);

    const oldestTs = Math.min(...entriesKv.map(([, e]) => e.timestamp || Infinity));
    // Do NOT use `entries.length < 100` as a terminator — Torn returns partial
    // pages even when more history exists. Rely on cutoff + forward-progress guard.
    if (oldestTs <= cutoff) {
      console.log(`[findEcstasyUsageInLog] page=${page} reached cutoff (oldestTs=${oldestTs} <= cutoff=${cutoff})`);
      break;
    }
    if (oldestTs === Infinity || oldestTs >= lastOldestTs) {
      console.log(`[findEcstasyUsageInLog] page=${page} no forward progress, stopping`);
      break;
    }
    lastOldestTs = oldestTs;
    toParam = `&to=${oldestTs - 1}`;
  }

  console.log(`[findEcstasyUsageInLog] FINAL earliest=${earliestUsage ? earliestUsage.timestamp : 'none'} pagesFetched=${pagesFetched} totalEntries=${totalEntries}`);
  return earliestUsage;
}

// Counts successful Xanax uses in the Torn API log since a given timestamp.
// Returns count (max meaningful = 4) and details of each use found.
async function countXanaxUsageInLog(
  apiKey: string,
  sinceTimestamp?: number,
  maxPages = 30,
): Promise<{ count: number; details: string[]; pages: number; totalEntries: number }> {
  let toParam = '';
  const uses: { timestamp: number; detail: string; key: string }[] = [];
  const cutoff = sinceTimestamp || 0;
  const fromParam = sinceTimestamp ? `&from=${sinceTimestamp}` : '';
  const seenKeys = new Set<string>();
  let pagesFetched = 0;
  let totalEntries = 0;
  let lastOldestTs = Infinity;

  for (let page = 0; page < maxPages; page++) {
    const url = `${TORN_API}/user/?selections=log${fromParam}${toParam}&key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error || !data.log) {
      console.log(`[countXanaxUsageInLog] page=${page} error=${JSON.stringify(data.error || 'no log')}`);
      break;
    }

    // Preserve keys — Torn log is keyed by unique entry IDs, dedupe on those.
    const entriesKv = Object.entries(data.log) as [string, any][];
    if (entriesKv.length === 0) {
      console.log(`[countXanaxUsageInLog] page=${page} empty page, stopping`);
      break;
    }
    pagesFetched++;
    totalEntries += entriesKv.length;

    if (page === 0) {
      const sample = entriesKv[0][1];
      console.log(`[countXanaxUsageInLog] page=0 entries=${entriesKv.length} sampleEntry=${JSON.stringify(sample).slice(0, 400)}`);
    } else {
      console.log(`[countXanaxUsageInLog] page=${page} entries=${entriesKv.length}`);
    }

    let pageMatches = 0;
    for (const [key, entry] of entriesKv) {
      const ts = entry.timestamp || 0;
      if (ts < cutoff) continue;
      if (!entryMatchesDrugUse(entry, 'Xanax', XANAX_ITEM_ID)) continue;

      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const narrative = String(entry.log || entry.title || '').slice(0, 200);
      uses.push({
        timestamp: ts,
        detail: `Xanax @ ${new Date(ts * 1000).toISOString()} — "${narrative}" data=${JSON.stringify(entry.data || {}).slice(0, 120)}`,
        key,
      });
      pageMatches++;
    }
    console.log(`[countXanaxUsageInLog] page=${page} matchesThisPage=${pageMatches} runningTotal=${uses.length}`);

    const oldestTs = Math.min(...entriesKv.map(([, e]) => e.timestamp || Infinity));
    // Stop when we've crossed the since-cutoff or pagination isn't making progress.
    // Do NOT use `entries.length < 100` as a terminator: Torn's log endpoint
    // frequently returns partial pages (25-ish) even when more entries exist,
    // so that check was causing us to stop after a single page and miss older
    // uses — which was the actual cause of the "2/4" undercount.
    if (oldestTs <= cutoff) {
      console.log(`[countXanaxUsageInLog] page=${page} reached cutoff (oldestTs=${oldestTs} <= cutoff=${cutoff})`);
      break;
    }
    if (oldestTs === Infinity || oldestTs >= lastOldestTs) {
      console.log(`[countXanaxUsageInLog] page=${page} no forward progress, stopping`);
      break;
    }
    lastOldestTs = oldestTs;
    toParam = `&to=${oldestTs - 1}`;
  }

  // Sort uses oldest → newest so the debug list reads naturally
  uses.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`[countXanaxUsageInLog] FINAL count=${uses.length} pagesFetched=${pagesFetched} totalEntries=${totalEntries} details=${JSON.stringify(uses.map((u) => u.detail))}`);
  return {
    count: uses.length,
    details: uses.map((u) => u.detail),
    pages: pagesFetched,
    totalEntries,
  };
}

// Scan the user log for an OD entry on a covered drug. The Torn events
// feed sometimes lags 2-5 minutes behind the actual OD, but the user log
// usually has the OD entry within seconds — it's just filtered out by
// the drug-use matchers (which explicitly exclude `overdos` to avoid
// counting ODs as successful uses). This function INCLUDES those entries
// and classifies them by drug, so report-od can fall back to the log
// when the events scan returns nothing.
//
// Classification: data.item === 206 (or text mentions xanax) → xanax;
// data.item === 197 (or text mentions ecstasy) → ecstasy. Returns the
// EARLIEST matching OD in the window so replay-prevention via
// od_event_timestamp is deterministic across retries.
async function findOdInLog(
  apiKey: string,
  sinceTimestamp?: number,
  maxPages = 30,
): Promise<{ drug: 'xanax' | 'ecstasy'; timestamp: number; detail: string } | null> {
  let toParam = '';
  const cutoff = sinceTimestamp || 0;
  const fromParam = sinceTimestamp ? `&from=${sinceTimestamp}` : '';
  let lastOldestTs = Infinity;
  let pagesFetched = 0;
  let totalEntries = 0;
  let earliest: { drug: 'xanax' | 'ecstasy'; timestamp: number; detail: string } | null = null;

  for (let page = 0; page < maxPages; page++) {
    const url = `${TORN_API}/user/?selections=log${fromParam}${toParam}&key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error || !data.log) {
      console.log(`[findOdInLog] page=${page} error=${JSON.stringify(data.error || 'no log')}`);
      break;
    }

    const entriesKv = Object.entries(data.log) as [string, any][];
    if (entriesKv.length === 0) break;
    pagesFetched++;
    totalEntries += entriesKv.length;

    for (const [, entry] of entriesKv) {
      const ts = entry.timestamp || 0;
      if (ts < cutoff) continue;

      const parts: string[] = [];
      if (entry.title) parts.push(String(entry.title));
      if (entry.log) parts.push(String(entry.log));
      if (entry.category) parts.push(String(entry.category));
      if (entry.data) parts.push(JSON.stringify(entry.data));
      if (entry.params) parts.push(JSON.stringify(entry.params));
      const hay = parts.join(' ').toLowerCase();

      if (!hay.includes('overdos')) continue;

      const itemField = entry.data?.item;
      let drug: 'xanax' | 'ecstasy' | null = null;
      if (itemField === XANAX_ITEM_ID || itemField === String(XANAX_ITEM_ID) || hay.includes('xanax')) {
        drug = 'xanax';
      } else if (itemField === ECSTASY_ITEM_ID || itemField === String(ECSTASY_ITEM_ID) || hay.includes('ecstasy')) {
        drug = 'ecstasy';
      }
      if (!drug) continue;

      const narrative = String(entry.log || entry.title || '').slice(0, 200);
      const detail = `${drug} OD @ ${new Date(ts * 1000).toISOString()} — "${narrative}" data=${JSON.stringify(entry.data || {}).slice(0, 120)}`;
      if (!earliest || ts < earliest.timestamp) {
        earliest = { drug, timestamp: ts, detail };
      }
    }

    const oldestTs = Math.min(...entriesKv.map(([, e]) => e.timestamp || Infinity));
    if (oldestTs <= cutoff) break;
    if (oldestTs === Infinity || oldestTs >= lastOldestTs) break;
    lastOldestTs = oldestTs;
    toParam = `&to=${oldestTs - 1}`;
  }

  console.log(`[findOdInLog] FINAL match=${earliest ? `${earliest.drug}@${earliest.timestamp}` : 'none'} pagesFetched=${pagesFetched} totalEntries=${totalEntries}`);
  return earliest;
}

// Generic Torn-log item-use counter used by Faction Events. Deliberately a
// LITERAL parameterised copy of countXanaxUsageInLog — the production-proven
// drug-verification scanner Happy Jump has used reliably for months. Same
// URL shape (`from=` only — never `to=` on the initial request, only as a
// pagination cursor), same dedupe-by-log-key, same termination logic.
//
// The only addition for Faction Events: an optional `untilTimestamp` upper
// bound. We do NOT pass it to Torn — passing both `from` and `to` to Torn's
// log endpoint silently returns an empty response for windows that don't
// touch the most recent entries (was producing 0 counts). Instead we filter
// `ts > upper` client-side per entry, exactly the same way `ts < cutoff`
// is filtered in the Xanax scanner. Pagination still terminates on
// `oldestTs <= cutoff`, which guarantees we walk the log all the way back
// to the start of the event window even for past events.
async function countItemUseInLog(
  apiKey: string,
  itemId: number,
  drugName: string,
  sinceTimestamp?: number,
  untilTimestamp?: number,
  maxPages = 200,
): Promise<{
  count: number;
  details: string[];
  matchedItems: Array<{ ts: number; drug: string }>;
  pages: number;
  totalEntries: number;
  reachedCutoff: boolean;
  debug: string[];
  rejectedSamples: string[];
  inWindowTotal: number;
  logTypeHistogram: Array<{ key: string; count: number }>;
  dataItemHistogram: Array<{ key: string; count: number }>;
  interestingRejections: string[];
}> {
  let toParam = '';
  const uses: { timestamp: number; detail: string; key: string }[] = [];
  const cutoff = sinceTimestamp || 0;
  const upper = untilTimestamp || Number.POSITIVE_INFINITY;
  const fromParam = sinceTimestamp ? `&from=${sinceTimestamp}` : '';
  const seenKeys = new Set<string>();
  let pagesFetched = 0;
  let totalEntries = 0;
  let lastOldestTs = Infinity;
  let reachedCutoff = false;
  let inWindowTotal = 0;

  // Diagnostic log mirrored to console AND collected so it can be surfaced
  // in the HTTP response (debug=true on refresh-faction-event). Lets the
  // operator inspect a refresh from the iPad without digging through
  // Supabase's log explorer.
  const debug: string[] = [];
  const rejectedSamples: string[] = [];
  // Categorize the whole in-window population so we can answer "does the
  // user actually have any drug-use-shaped entries in this window?" without
  // dumping every entry. logTypeKey = `<entry.log>/<entry.title>` since both
  // disambiguate Torn's log categories. dataItemKey = entry.data.item value
  // (any item, not just the target — surfaces "you have lots of item-use
  // entries but none for this drug").
  const logTypeCounts = new Map<string, number>();
  const dataItemCounts = new Map<string, number>();
  // "Interesting" rejections = ones where the matcher said no but the entry
  // either has data.item set OR mentions the drug name anywhere. These are
  // the rejections worth investigating; the dumb crime-success rejections
  // captured in rejectedSamples are not.
  const interestingRejections: string[] = [];
  function dbg(line: string) { debug.push(line); console.log(line); }

  dbg(`[countItemUseInLog ${drugName}] START itemId=${itemId} cutoff=${cutoff} upper=${upper}`);

  for (let page = 0; page < maxPages; page++) {
    const url = `${TORN_API}/user/?selections=log${fromParam}${toParam}&key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error || !data.log) {
      dbg(`[countItemUseInLog ${drugName}] page=${page} error=${JSON.stringify(data.error || 'no log')}`);
      break;
    }

    const entriesKv = Object.entries(data.log) as [string, any][];
    if (entriesKv.length === 0) {
      dbg(`[countItemUseInLog ${drugName}] page=${page} empty page, stopping`);
      break;
    }
    pagesFetched++;
    totalEntries += entriesKv.length;

    if (page === 0) {
      const sample = entriesKv[0][1];
      dbg(`[countItemUseInLog ${drugName}] page=0 entries=${entriesKv.length} sampleEntry=${JSON.stringify(sample).slice(0, 600)}`);
    } else {
      dbg(`[countItemUseInLog ${drugName}] page=${page} entries=${entriesKv.length}`);
    }

    let pageMatches = 0;
    let pageInWindow = 0;
    for (const [key, entry] of entriesKv) {
      const ts = entry.timestamp || 0;
      if (ts < cutoff) continue;
      if (ts > upper) continue;
      pageInWindow++;
      inWindowTotal++;

      // Histograms over the whole in-window population.
      const logKey = `${entry.log ?? '?'}/${entry.title ?? '?'}`;
      logTypeCounts.set(logKey, (logTypeCounts.get(logKey) || 0) + 1);
      const itemFieldVal = entry.data?.item;
      if (itemFieldVal !== undefined && itemFieldVal !== null) {
        const itemKey = String(itemFieldVal);
        dataItemCounts.set(itemKey, (dataItemCounts.get(itemKey) || 0) + 1);
      }

      const verdict = entryMatchesDrugUseWithReason(entry, drugName, itemId);
      if (!verdict.match) {
        // Capture up to 5 in-window-but-rejected entries with the reason —
        // bias toward the *first* rejections so the sample shows the most
        // common shape (typically post-event noise).
        if (rejectedSamples.length < 5) {
          rejectedSamples.push(
            `${verdict.reason} :: title=${JSON.stringify(entry.title).slice(0, 60)} log=${JSON.stringify(entry.log).slice(0, 80)} data=${JSON.stringify(entry.data || {}).slice(0, 120)}`,
          );
        }
        // ALSO capture rejections that look plausibly drug-related — those
        // are the ones that would indicate a matcher false-negative. An
        // entry is "interesting" if it has data.item set OR if the drug
        // name appears anywhere in its serialized form.
        const hasDataItem = itemFieldVal !== undefined && itemFieldVal !== null;
        const serialized = JSON.stringify(entry).toLowerCase();
        const mentionsDrug = serialized.includes(drugName.toLowerCase());
        if ((hasDataItem || mentionsDrug) && interestingRejections.length < 15) {
          interestingRejections.push(
            `${verdict.reason} :: title=${JSON.stringify(entry.title).slice(0, 80)} log=${entry.log} data=${JSON.stringify(entry.data || {}).slice(0, 200)}`,
          );
        }
        continue;
      }
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const narrative = String(entry.log || entry.title || '').slice(0, 200);
      uses.push({
        timestamp: ts,
        detail: `${drugName} @ ${new Date(ts * 1000).toISOString()} — "${narrative}" data=${JSON.stringify(entry.data || {}).slice(0, 120)}`,
        key,
      });
      pageMatches++;
    }
    dbg(`[countItemUseInLog ${drugName}] page=${page} inWindow=${pageInWindow} matches=${pageMatches} runningTotal=${uses.length}`);

    const oldestTs = Math.min(...entriesKv.map(([, e]) => e.timestamp || Infinity));
    if (oldestTs <= cutoff) {
      dbg(`[countItemUseInLog ${drugName}] page=${page} reached cutoff (oldestTs=${oldestTs} <= cutoff=${cutoff})`);
      reachedCutoff = true;
      break;
    }
    if (oldestTs === Infinity || oldestTs >= lastOldestTs) {
      dbg(`[countItemUseInLog ${drugName}] page=${page} no forward progress, stopping`);
      break;
    }
    lastOldestTs = oldestTs;
    toParam = `&to=${oldestTs - 1}`;
  }

  if (!reachedCutoff && pagesFetched === maxPages) {
    dbg(`[countItemUseInLog ${drugName}] WARNING hit maxPages=${maxPages} without reaching cutoff=${cutoff} — count may be incomplete`);
  }

  uses.sort((a, b) => a.timestamp - b.timestamp);

  // Build the histograms (top 20 by count). logTypeHistogram tells us
  // "what kinds of entries are actually in this window" — a drug-use
  // type will surface here if any exist. dataItemHistogram surfaces the
  // distribution of structured item references (any item, not just the
  // target) — proves whether ANY item-use entries are in the window.
  const sortedLogTypes = [...logTypeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([key, count]) => ({ key, count }));
  const sortedDataItems = [...dataItemCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([key, count]) => ({ key, count }));

  dbg(`[countItemUseInLog ${drugName}] FINAL count=${uses.length} pagesFetched=${pagesFetched} totalEntries=${totalEntries} inWindowTotal=${inWindowTotal} reachedCutoff=${reachedCutoff} distinctLogTypes=${logTypeCounts.size} distinctDataItems=${dataItemCounts.size}`);
  // Inline histograms in the per-page log too — they're the most useful
  // diagnostic and the new dedicated render section may not be live yet
  // on the FE if the FTP deploy is still propagating.
  if (sortedDataItems.length > 0) {
    dbg(`[countItemUseInLog ${drugName}] data.item HISTOGRAM (top ${sortedDataItems.length}): ${sortedDataItems.map((e) => `${e.key}:${e.count}`).join(', ')}`);
  } else {
    dbg(`[countItemUseInLog ${drugName}] data.item HISTOGRAM: (empty — no item-use-shaped entries in window)`);
  }
  dbg(`[countItemUseInLog ${drugName}] log-type HISTOGRAM (top ${sortedLogTypes.length}): ${sortedLogTypes.map((e) => `${e.key}=${e.count}`).join(' | ')}`);
  if (interestingRejections.length > 0) {
    dbg(`[countItemUseInLog ${drugName}] INTERESTING REJECTIONS (${interestingRejections.length}):`);
    for (const r of interestingRejections) dbg(`  -> ${r}`);
  } else {
    dbg(`[countItemUseInLog ${drugName}] INTERESTING REJECTIONS: (none — no rejections had data.item set OR mentioned "${drugName}")`);
  }
  return {
    count: uses.length,
    details: uses.map((u) => u.detail),
    // Structured per-match list for the simplified modal. Plain {ts,drug}
    // pairs so the frontend can render "YYYY-MM-DD HH:MM:SS — Cannabis"
    // lines without parsing the human-readable `details` strings.
    matchedItems: uses.map((u) => ({ ts: u.timestamp, drug: drugName })),
    pages: pagesFetched,
    totalEntries,
    reachedCutoff,
    debug,
    rejectedSamples,
    inWindowTotal,
    logTypeHistogram: sortedLogTypes,
    dataItemHistogram: sortedDataItems,
    interestingRejections,
  };
}

// Faction-events scanner for the `attacks` event type. Hits Torn v1
// user/?selections=attacks, paginates older by clamping `to` to the oldest
// timestamp seen, and aggregates the three metrics the leaderboard shows:
// total offensive attacks, total respect gained, single best-respect hit.
//
// Only attacks where attacker_id == myId count — defended-against records
// share the same payload but belong to the OTHER player's stats. Records
// outside [fromSec, untilSec] are skipped (defensive double-check; the
// from/to query params should already filter them).
//
// v1 attacks returns at most ~100 records per call. With pagination we
// cap at maxPages * 100 = 3000 attacks, which is far more than any sane
// FE participant in a 30-day window.
async function countAttacksInWindow(
  apiKey: string,
  myId: number,
  fromSec: number,
  untilSec: number,
  maxPages = 30,
): Promise<{
  count: number;
  respect_total: number;
  best_single: number;
  pages: number;
  totalRecords: number;
  reachedCutoff: boolean;
  scopeError: boolean;
  tornError: { code: number; message: string } | null;
  debug: string[];
}> {
  const debug: string[] = [];
  let pages = 0;
  let totalRecords = 0;
  let count = 0;
  let respect_total = 0;
  let best_single = 0;
  let toCursor = untilSec;
  let reachedCutoff = false;
  let scopeError = false;
  let tornError: { code: number; message: string } | null = null;
  const seenCodes = new Set<string>();

  for (let page = 0; page < maxPages; page++) {
    const url = `${TORN_API}/user/?selections=attacks&from=${fromSec}&to=${toCursor}&key=${apiKey}`;
    const r = await fetch(url);
    const data = await r.json();
    pages++;
    if (data.error) {
      const code = Number(data.error.code);
      tornError = { code, message: String(data.error.error || '') };
      // Code 16 = "Access level of this key is not high enough" — the
      // participant needs to widen their Custom Key scope to include
      // `attacks`. Surface it explicitly so the caller can leave their
      // last_count untouched rather than clobbering it with 0.
      if (code === 16) scopeError = true;
      debug.push(`page=${page} torn-error code=${code} msg="${data.error.error}"`);
      break;
    }
    const recs: any[] = data.attacks ? Object.values(data.attacks) : [];
    totalRecords += recs.length;
    debug.push(`page=${page} to=${toCursor} records=${recs.length}`);
    if (recs.length === 0) break;
    let oldestTs = Infinity;
    let newOnThisPage = 0;
    for (const a of recs) {
      const ts = Number(a.timestamp_ended ?? a.timestamp_started ?? 0);
      if (Number.isFinite(ts) && ts < oldestTs) oldestTs = ts;
      const code = String(a.code || `${a.attacker_id}-${ts}`);
      if (seenCodes.has(code)) continue;
      seenCodes.add(code);
      newOnThisPage++;
      const attackerId = Number(a.attacker_id);
      if (attackerId !== myId) continue;
      if (ts < fromSec || ts > untilSec) continue;
      count++;
      // Strip the chain-bonus portion of respect so milestone hits
      // (100/250/500/1000/2500/5000/10000/25000/50000/100000 chain
      // bonuses) don't dominate the leaderboard. `modifiers.chain_bonus`
      // is a multiplier baked into respect_gain — divide it out to
      // recover the base respect the hit would have earned without
      // the bonus. Normal hits have chain_bonus=1 → no change.
      const respectRaw = Number(a.respect_gain ?? a.respect ?? 0) || 0;
      const chainBonus = Number(a?.modifiers?.chain_bonus ?? 1) || 1;
      const respect = chainBonus > 1 ? respectRaw / chainBonus : respectRaw;
      respect_total += respect;
      if (respect > best_single) best_single = respect;
    }
    if (recs.length < 100) { reachedCutoff = true; break; }
    if (newOnThisPage === 0) break;
    if (Number.isFinite(oldestTs) && oldestTs <= fromSec) { reachedCutoff = true; break; }
    toCursor = oldestTs - 1;
  }

  debug.push(`FINAL count=${count} respect_total=${respect_total.toFixed(2)} best_single=${best_single.toFixed(2)} pages=${pages} records=${totalRecords}`);
  return {
    count, respect_total, best_single, pages, totalRecords, reachedCutoff,
    scopeError, tornError, debug,
  };
}

// Scan the Torn user log for every happiness-boosting item the client
// consumed in a window, grouped by item ID with quantities. This is the
// foundation for the Choco-Jump fix: instead of paying a fixed 5× EDVD on an
// Ecstasy OD, we replace exactly the happy items they actually used (EDVDs,
// candy, or any mix). Pagination / dedupe / termination are identical to
// countItemUseInLog — the production-proven scanner. The difference is the
// per-entry predicate (entryHappyGainWithReason) and that we group by
// data.item rather than counting one target item.
async function countHappyItemsUsed(
  apiKey: string,
  sinceTimestamp?: number,
  untilTimestamp?: number,
  maxPages = 200,
): Promise<{
  items: Record<string, { qty: number; sampleNarrative: string; firstTs: number; lastTs: number }>;
  totalQty: number;
  pages: number;
  totalEntries: number;
  inWindowTotal: number;
  reachedCutoff: boolean;
  itemUseSamples: Array<{
    itemId: number;
    ts: number;
    matched: boolean;
    reason: string;
    title: string;
    category: string;
    log_type: string;
    data_json: string;
  }>;
  debug: string[];
}> {
  let toParam = '';
  const cutoff = sinceTimestamp || 0;
  const upper = untilTimestamp || Number.POSITIVE_INFINITY;
  const fromParam = sinceTimestamp ? `&from=${sinceTimestamp}` : '';
  const seenKeys = new Set<string>();
  const items: Record<string, { qty: number; sampleNarrative: string; firstTs: number; lastTs: number }> = {};
  const itemUseSamples: Array<{
    itemId: number;
    ts: number;
    matched: boolean;
    reason: string;
    title: string;
    category: string;
    log_type: string;
    data_json: string;
  }> = [];
  const debug: string[] = [];
  let pagesFetched = 0;
  let totalEntries = 0;
  let inWindowTotal = 0;
  let lastOldestTs = Infinity;
  let reachedCutoff = false;
  let totalQty = 0;
  function dbg(line: string) { debug.push(line); console.log(line); }

  dbg(`[countHappyItemsUsed] START cutoff=${cutoff} upper=${upper}`);

  for (let page = 0; page < maxPages; page++) {
    const url = `${TORN_API}/user/?selections=log${fromParam}${toParam}&key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error || !data.log) {
      dbg(`[countHappyItemsUsed] page=${page} error=${JSON.stringify(data.error || 'no log')}`);
      break;
    }

    const entriesKv = Object.entries(data.log) as [string, any][];
    if (entriesKv.length === 0) {
      dbg(`[countHappyItemsUsed] page=${page} empty page, stopping`);
      break;
    }
    pagesFetched++;
    totalEntries += entriesKv.length;

    for (const [key, entry] of entriesKv) {
      const ts = entry.timestamp || 0;
      if (ts < cutoff) continue;
      if (ts > upper) continue;
      inWindowTotal++;

      const verdict = entryHappyGainWithReason(entry);
      // `entry.log` is Torn's NUMERIC log-type code (e.g. 2020), not text —
      // the human-readable string lives in `entry.title`. Prefer it.
      const narrative = String(entry.title || entry.log || '').slice(0, 200);

      // Surface every item-use-shaped entry (numeric data.item) — matched or
      // not — with its raw fields so the admin diagnostic can show exactly
      // what Torn returned (where the happy signal lives, why beer/etc. skip)
      // and we can tune the matcher against real Choco-Jump logs.
      if (verdict.itemId !== null && itemUseSamples.length < 60) {
        itemUseSamples.push({
          itemId: verdict.itemId,
          ts,
          matched: verdict.match,
          reason: verdict.reason || 'matched',
          title: String(entry.title ?? '').slice(0, 160),
          category: String(entry.category ?? '').slice(0, 80),
          log_type: String(entry.log ?? ''),
          data_json: JSON.stringify(entry.data ?? {}).slice(0, 240),
        });
      }

      if (!verdict.match || verdict.itemId === null) continue;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const id = String(verdict.itemId);
      const qty = Number(entry.data?.qty) > 0 ? Number(entry.data.qty) : 1;
      if (!items[id]) {
        items[id] = { qty: 0, sampleNarrative: narrative, firstTs: ts, lastTs: ts };
      }
      items[id].qty += qty;
      items[id].firstTs = Math.min(items[id].firstTs, ts);
      items[id].lastTs = Math.max(items[id].lastTs, ts);
      totalQty += qty;
    }

    const oldestTs = Math.min(...entriesKv.map(([, e]) => e.timestamp || Infinity));
    if (oldestTs <= cutoff) {
      reachedCutoff = true;
      break;
    }
    if (oldestTs === Infinity || oldestTs >= lastOldestTs) break;
    lastOldestTs = oldestTs;
    toParam = `&to=${oldestTs - 1}`;
  }

  dbg(`[countHappyItemsUsed] FINAL distinctItems=${Object.keys(items).length} totalQty=${totalQty} pages=${pagesFetched} inWindow=${inWindowTotal} reachedCutoff=${reachedCutoff}`);
  return { items, totalQty, pages: pagesFetched, totalEntries, inWindowTotal, reachedCutoff, itemUseSamples, debug };
}

// ── Auto-close expired transactions ──────────────────────────────────

let lastAutoCloseRun = 0;
const AUTO_CLOSE_INTERVAL_MS = 60_000; // run at most once per minute

async function autoCloseExpired(supabase: any) {
  const now = Date.now();
  if (now - lastAutoCloseRun < AUTO_CLOSE_INTERVAL_MS) return;
  lastAutoCloseRun = now;

  const nowIso = new Date().toISOString();

  // Auto-expire requested transactions after 48 hours
  const { data: expiredRequests } = await supabase
    .from('transactions')
    .select('id, torn_id, torn_name, ecstasy_payout')
    .eq('status', 'requested')
    .not('expires_at', 'is', null)
    .lt('expires_at', nowIso);

  if (expiredRequests && expiredRequests.length > 0) {
    for (const txn of expiredRequests) {
      await supabase
        .from('transactions')
        .update({ status: 'rejected', closed_at: nowIso })
        .eq('id', txn.id);

      // Release locked reserve (atomic)
      await adjustReserve(supabase, Number(txn.ecstasy_payout || 0));

      if (txn.torn_id) {
        await syncClientStats(supabase, txn.torn_id);
      }

      const expiredLabel = txn.torn_name ? `${txn.torn_name} [${txn.torn_id}]` : txn.torn_id;
      await sendNotificationEmail(
        `Happy Jump — Request Expired — ${expiredLabel}`,
        [
          `A purchase request has expired after 48 hours with no payment.`,
          ``,
          `Player: ${expiredLabel}`,
          `Transaction ID: ${txn.id}`,
          `Reserve released: ${formatMoney(Number(txn.ecstasy_payout || 0))}`,
        ].join('\n'),
      );
    }
  }

  // Auto-close purchased transactions after 3 days
  const { data: expired } = await supabase
    .from('transactions')
    .select('id, torn_id, torn_name, ecstasy_payout, suggested_price, amount_paid')
    .eq('status', 'purchased')
    .lt('closes_at', nowIso);

  if (!expired || expired.length === 0) return;

  for (const txn of expired) {
    const closeUpdate: Record<string, unknown> = { status: 'closed_clean', closed_at: nowIso };
    // Defensive backstop for legacy purchased rows where amount_paid never got filled.
    if (Number(txn.amount_paid || 0) === 0 && txn.suggested_price) {
      closeUpdate.amount_paid = txn.suggested_price;
    }
    await supabase
      .from('transactions')
      .update(closeUpdate)
      .eq('id', txn.id);

    // Release locked reserve (atomic)
    await adjustReserve(supabase, Number(txn.ecstasy_payout || 0));

    // If we just backfilled amount_paid on a legacy row, fold that revenue
    // into the reserve too (forward-only — under the new rule, purchased rows
    // already had their revenue folded in at purchase time, so this only
    // catches rows that pre-date that logic).
    if (closeUpdate.amount_paid && Number(txn.amount_paid || 0) === 0) {
      await adjustReserve(supabase, Number(closeUpdate.amount_paid));
    }

    if (txn.torn_id) {
      await syncClientStats(supabase, txn.torn_id);
    }

    const expiredLabel = txn.torn_name ? `${txn.torn_name} [${txn.torn_id}]` : txn.torn_id;
    await sendNotificationEmail(
      `Happy Jump — Clean Close — ${expiredLabel}`,
      [
        `A 3-day insurance window has expired with no OD claim.`,
        ``,
        `Player: ${expiredLabel}`,
        `Transaction ID: ${txn.id}`,
        `Reserve released: ${formatMoney(Number(txn.ecstasy_payout || 0))}`,
      ].join('\n'),
    );
  }
}

// ── Route handlers ───────────────────────────────────────────────────

async function handleValidatePlayer(body: any) {
  const { key } = body;
  if (!key) return json({ error: 'Missing API key' }, 400);

  // Fetch basic info and verify events+log permissions in parallel
  const [basicRes, eventsRes] = await Promise.all([
    fetch(`${TORN_API}/user/?selections=basic,profile&key=${key}`),
    fetch(`${TORN_API}/user/?selections=events,log&limit=1&key=${key}`),
  ]);
  const [data, eventsData] = await Promise.all([basicRes.json(), eventsRes.json()]);

  if (data.error) {
    return json({ error: `Torn API: ${data.error.error}` }, 400);
  }

  // If events/log check fails, the key doesn't have sufficient permissions
  if (eventsData.error) {
    return json({
      error: 'Your API key is missing required permissions. Please create a new key with "Events" and "Log" access enabled. Click the "Create a Custom Key" link on the site for a pre-filled setup.',
    }, 400);
  }

  return json({
    torn_id: String(data.player_id),
    torn_name: data.name,
    torn_faction: data.faction?.faction_name || null,
    torn_level: data.level,
    status: data.status?.description || 'Unknown',
  });
}

async function handleTornProxy(body: any) {
  const { section, id, selections } = body;
  if (!section) return json({ error: 'Missing required field: section' }, 400);

  const resolved = await resolveApiKey(body);
  if (resolved instanceof Response) return resolved;

  const idPart = id ? `/${id}` : '';
  const selPart = selections ? `?selections=${selections}&` : '?';
  const url = `${TORN_API}/${section}${idPart}${selPart}key=${resolved.key}`;

  const res = await fetch(url);
  const data = await res.json();
  return json(data);
}

/**
 * Fetch live Torn item market prices for the three Happy Jump items.
 * Returns { xanax, edvd, ecstasy } as numbers, or null if the call fails or
 * any item is missing. Caller should treat null as "use stored config prices".
 */
async function fetchLiveItemPrices(apiKey: string): Promise<{ xanax: number; edvd: number; ecstasy: number } | null> {
  try {
    const url = `${TORN_API}/torn/?selections=items&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.error || !data?.items) return null;
    // Xanax 206, EDVD 366, Ecstasy 197
    const xanax = Number(data.items?.[206]?.market_value);
    const edvd = Number(data.items?.[366]?.market_value);
    const ecstasy = Number(data.items?.[197]?.market_value);
    if (!xanax || !edvd || !ecstasy) return null;
    return { xanax, edvd, ecstasy };
  } catch (_err) {
    return null;
  }
}

// Fetch the full Torn item catalog as a map of id → { name, market_value,
// tradeable }. Used to resolve and price arbitrary consumed items (any happy
// item a client used) for payout valuation, and to decide whether an item can
// actually be traded back to the client on a payout. Returns null on failure
// so callers can fall back to config prices. Cached briefly to avoid hammering
// the items endpoint.
type ItemMeta = { name: string; market_value: number; tradeable: boolean | null };
let _itemsMapCache: { at: number; map: Record<string, ItemMeta> } | null = null;
const ITEMS_MAP_TTL_MS = 15 * 60 * 1000; // 15 min, per CLAUDE.md market-cache policy

// Torn's item payload field for tradeability has varied across API versions
// (tradeable / tradable / is_tradable). Read all of them defensively and only
// commit to true/false when one is actually present; null = "unknown", which
// the exclusion logic treats as "do not auto-exclude" (safe default).
function parseTradeable(info: any): boolean | null {
  const v = info?.tradeable ?? info?.tradable ?? info?.is_tradable ?? info?.is_tradeable;
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1' || v === 'true') return true;
  if (v === 0 || v === '0' || v === 'false') return false;
  return null;
}

async function fetchTornItemsMap(
  apiKey: string,
): Promise<Record<string, ItemMeta> | null> {
  if (_itemsMapCache && Date.now() - _itemsMapCache.at < ITEMS_MAP_TTL_MS) {
    return _itemsMapCache.map;
  }
  try {
    const url = `${TORN_API}/torn/?selections=items&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.error || !data?.items) return null;
    const map: Record<string, ItemMeta> = {};
    for (const [id, info] of Object.entries(data.items as Record<string, any>)) {
      map[id] = {
        name: String(info?.name ?? `item ${id}`),
        market_value: Number(info?.market_value ?? 0),
        tradeable: parseTradeable(info),
      };
    }
    _itemsMapCache = { at: Date.now(), map };
    return map;
  } catch (_err) {
    return null;
  }
}

// Happiness items the operator cannot trade back to the client, so they are
// NEVER counted toward an Ecstasy-OD payout (we can't replace what we can't
// send). Two sources:
//   1. Torn flags the item non-tradeable (meta.tradeable === false), and
//   2. an explicit list for items that are technically tradeable but the
//      operator still won't replace (eggs, stock-benefit items, event items).
// Item IDs are added to the list once confirmed via the Detect Happy Items
// diagnostic (which now surfaces each item's id + tradeable flag).
const HAPPY_NON_TRANSFERABLE_ITEM_IDS = new Set<number>([
  // Eggs — confirmed non-tradeable by the operator. IDs added after we read
  // them off the diagnostic.
]);

function isNonTransferableHappyItem(
  itemId: number,
  meta: { tradeable: boolean | null } | undefined,
): boolean {
  if (HAPPY_NON_TRANSFERABLE_ITEM_IDS.has(itemId)) return true;
  if (meta && meta.tradeable === false) return true;
  return false;
}

// ── Encrypted auto-login actions ────────────────────────────────────
// set-api-key: called once per key (after a successful manual validation) to
// encrypt+store the key and issue an opaque session token. The browser stores
// { player_id, session_token } and never holds the raw key again.

async function handleSetApiKey(body: any) {
  const { api_key } = body;
  if (!api_key) return json({ error: 'Missing api_key' }, 400);

  const enc = await getEncryptionKey();
  if (!enc) {
    return json({ error: 'Encryption not configured on server (missing API_KEY_ENCRYPTION_KEY)' }, 500);
  }

  // Validate against Torn — same permission check as validate-player so we
  // don't store a key that won't work. Derive player_id from Torn's response
  // (authoritative — never trust a claimed player_id from the client).
  const [basicRes, eventsRes] = await Promise.all([
    fetch(`${TORN_API}/user/?selections=basic,profile&key=${api_key}`),
    fetch(`${TORN_API}/user/?selections=events,log&limit=1&key=${api_key}`),
  ]);
  const [basic, events] = await Promise.all([basicRes.json(), eventsRes.json()]);
  if (basic.error) return json({ error: `Torn API: ${basic.error.error}` }, 400);
  if (events.error) {
    return json({
      error: 'Your API key is missing required permissions. Please create a new key with "Events" and "Log" access enabled.',
    }, 400);
  }

  const tornPlayerId = Number(basic.player_id);
  const session_token = randomTokenBase64(32);
  const session_token_hash = await sha256Base64(session_token);
  const encrypted = await encryptApiKey(api_key);
  if (!encrypted) return json({ error: 'Encryption failed' }, 500);

  const nowIso = new Date().toISOString();
  const supabase = serviceClient();
  const { error: upErr } = await supabase
    .from('player_secrets')
    .upsert(
      {
        torn_player_id: tornPlayerId,
        api_key_enc: encrypted.ciphertext,
        api_key_iv: encrypted.iv,
        session_token_hash,
        failed_attempts: 0,
        updated_at: nowIso,
        last_login_at: nowIso,
      },
      { onConflict: 'torn_player_id' },
    );

  if (upErr) return json({ error: `Failed to store session: ${upErr.message}` }, 500);

  return json({
    success: true,
    player_id: String(tornPlayerId),
    session_token,
    torn_id: String(tornPlayerId),
    torn_name: basic.name,
    torn_faction: basic.faction?.faction_name || null,
    torn_level: basic.level,
    status: basic.status?.description || 'Unknown',
  });
}

// auto-login: verifies the session, re-validates the stored key against Torn,
// and returns player info (NOT the raw key). On any failure the row is deleted
// so a revoked key or bad token self-cleans.
async function handleAutoLogin(body: any) {
  const { player_id, session_token } = body;
  if (!player_id || !session_token) {
    return json({ error: 'Missing player_id or session_token' }, 400);
  }

  const resolved = await resolveApiKey(body);
  if (resolved instanceof Response) return resolved;

  // Re-validate the stored key against Torn. Revoked keys self-clean.
  const identRes = await fetch(`${TORN_API}/user/?selections=basic,profile&key=${resolved.key}`);
  const identData = await identRes.json();

  const supabase = serviceClient();

  if (identData.error) {
    // Key was revoked / invalid on Torn's side — row is useless, drop it.
    // Opaque 401 so external callers can't distinguish this from a bad token.
    await supabase.from('player_secrets').delete().eq('torn_player_id', Number(player_id));
    return sessionInvalid();
  }

  // Defence-in-depth: stored player_id must still match what Torn reports.
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
}

// revoke-session: explicit Sign Out deletes the encrypted row so the server
// no longer holds the key. Idempotent — unknown/invalid creds still respond ok
// so callers can't use the endpoint as an oracle for valid player_ids.
async function handleRevokeSession(body: any) {
  const { player_id, session_token } = body;
  if (!player_id || !session_token) {
    return json({ error: 'Missing player_id or session_token' }, 400);
  }

  const supabase = serviceClient();
  const { data: row } = await supabase
    .from('player_secrets')
    .select('session_token_hash')
    .eq('torn_player_id', Number(player_id))
    .maybeSingle();

  if (!row) return json({ success: true });

  const providedHash = await sha256Base64(String(session_token));
  if (!constantTimeEqual(providedHash, row.session_token_hash)) {
    return json({ success: true });
  }

  await supabase.from('player_secrets').delete().eq('torn_player_id', Number(player_id));
  return json({ success: true });
}

// ── Faction Event session actions (fe-*) ─────────────────────────────
// Scope-isolated session for the Faction Events page. Tokens minted here
// only authorize fe-* actions (count drug uses, edit your own events).
// They cannot authorize Happy Jump payouts, transactions, or admin work.
// Storage table: faction_event_player_secrets (migration 012).

// Validate the supplied Torn key, ensure it has Log access (needed to count
// drug-use entries), encrypt it, and mint an opaque session token.
async function handleFeSetApiKey(body: any) {
  const { api_key } = body;
  if (!api_key) return json({ error: 'Missing api_key' }, 400);

  const enc = await getEncryptionKey();
  if (!enc) {
    return json({ error: 'Encryption not configured on server (missing API_KEY_ENCRYPTION_KEY)' }, 500);
  }

  // FE only needs Log access for counting. (Calendar is best-effort, used
  // by fetch-torn-event-start; we don't gate sign-in on it.) We deliberately
  // do NOT require Events access — FE is narrower in scope than Happy Jump.
  const [basicRes, logRes] = await Promise.all([
    fetch(`${TORN_API}/user/?selections=basic,profile&key=${api_key}`),
    fetch(`${TORN_API}/user/?selections=log&limit=1&key=${api_key}`),
  ]);
  const [basic, logCheck] = await Promise.all([basicRes.json(), logRes.json()]);
  if (basic.error) return json({ error: `Torn API: ${basic.error.error}` }, 400);
  if (logCheck.error) {
    return json({
      error: 'Your API key is missing required permissions. Please create or update a key with "Log" access enabled.',
    }, 400);
  }

  const tornPlayerId = Number(basic.player_id);
  const session_token = randomTokenBase64(32);
  const session_token_hash = await sha256Base64(session_token);
  const encrypted = await encryptApiKey(api_key);
  if (!encrypted) return json({ error: 'Encryption failed' }, 500);

  // Faction id = 0 in Torn means "no faction" — store NULL so the
  // auto-add-faction-members lookup doesn't match all factionless players
  // to each other.
  const factionIdRaw = Number(basic.faction?.faction_id);
  const factionId = Number.isFinite(factionIdRaw) && factionIdRaw > 0 ? factionIdRaw : null;
  const factionName = basic.faction?.faction_name ? String(basic.faction.faction_name) : null;
  const tornName = basic.name ? String(basic.name) : null;

  const nowIso = new Date().toISOString();
  const supabase = serviceClient();
  const { error: upErr } = await supabase
    .from('faction_event_player_secrets')
    .upsert(
      {
        torn_player_id: tornPlayerId,
        api_key_enc: encrypted.ciphertext,
        api_key_iv: encrypted.iv,
        session_token_hash,
        failed_attempts: 0,
        updated_at: nowIso,
        last_login_at: nowIso,
        torn_name: tornName,
        torn_faction_id: factionId,
        torn_faction_name: factionName,
      },
      { onConflict: 'torn_player_id' },
    );

  if (upErr) return json({ error: `Failed to store session: ${upErr.message}` }, 500);

  return json({
    success: true,
    player_id: String(tornPlayerId),
    session_token,
    torn_id: String(tornPlayerId),
    torn_name: basic.name,
    torn_faction: basic.faction?.faction_name || null,
    torn_level: basic.level,
  });
}

// Re-validates the stored key against Torn. On permanent Torn errors
// (codes 2/16) the session row is cascade-deleted along with every
// participant row anchored on this torn_id. Transient errors (5/8/9 etc.)
// leave the row alone — the key is fine, the network isn't.
async function handleFeAutoLogin(body: any) {
  const { player_id, session_token } = body;
  if (!player_id || !session_token) {
    return json({ error: 'Missing player_id or session_token' }, 400);
  }

  const resolved = await resolveFactionEventApiKey(body);
  if (resolved instanceof Response) return resolved;

  const identRes = await fetch(`${TORN_API}/user/?selections=basic,profile&key=${resolved.key}`);
  const identData = await identRes.json();

  const supabase = serviceClient();

  if (identData.error) {
    if (isPermanentTornKeyError(identData.error.code)) {
      await cascadeDeleteFactionEventSecret(supabase, player_id);
      return sessionInvalid();
    }
    // Transient — keep the row, surface the error so the client can retry.
    return json({ error: `Torn API: ${identData.error.error}`, transient: true }, 503);
  }

  // Defence-in-depth: stored player_id must still match what Torn reports.
  if (String(identData.player_id) !== String(player_id)) {
    await cascadeDeleteFactionEventSecret(supabase, player_id);
    return sessionInvalid();
  }

  // Refresh the cached identity fields — name / faction can change between
  // logins, and we want auto-add-faction-members to match against the
  // user's *current* faction, not whatever it was on first sign-in.
  const factionIdRaw = Number(identData.faction?.faction_id);
  const factionId = Number.isFinite(factionIdRaw) && factionIdRaw > 0 ? factionIdRaw : null;
  const factionName = identData.faction?.faction_name ? String(identData.faction.faction_name) : null;
  const tornName = identData.name ? String(identData.name) : null;

  await supabase
    .from('faction_event_player_secrets')
    .update({
      failed_attempts: 0,
      last_login_at: new Date().toISOString(),
      torn_name: tornName,
      torn_faction_id: factionId,
      torn_faction_name: factionName,
    })
    .eq('torn_player_id', Number(player_id));

  return json({
    success: true,
    torn_id: String(identData.player_id),
    torn_name: identData.name,
    torn_faction: identData.faction?.faction_name || null,
    torn_level: identData.level,
  });
}

// Sign Out — verifies the token and deletes the FE secret row. Idempotent:
// unknown / invalid creds still return success so this endpoint can't be
// used as an oracle for valid player_ids. Does NOT cascade-delete the
// participant rows — your existing leaderboard entries stay; you just lose
// the ability to refresh them until you sign in again.
async function handleFeRevokeSession(body: any) {
  const { player_id, session_token } = body;
  if (!player_id || !session_token) {
    return json({ error: 'Missing player_id or session_token' }, 400);
  }

  const supabase = serviceClient();
  const { data: row } = await supabase
    .from('faction_event_player_secrets')
    .select('session_token_hash')
    .eq('torn_player_id', Number(player_id))
    .maybeSingle();

  if (!row) return json({ success: true });

  const providedHash = await sha256Base64(String(session_token));
  if (!constantTimeEqual(providedHash, row.session_token_hash)) {
    return json({ success: true });
  }

  await supabase.from('faction_event_player_secrets').delete().eq('torn_player_id', Number(player_id));
  return json({ success: true });
}

async function handleCreateTransaction(body: any) {
  console.log('[create-transaction] Handler called for', body.torn_name, body.torn_id);
  const { torn_id, torn_name, torn_faction, torn_level } = body;
  const validProducts = ['package', 'insurance', 'ecstasy_only'];
  const productType = validProducts.includes(body.product_type) ? body.product_type : 'package';
  if (!torn_id || !torn_name) {
    return json({ error: 'Missing required player fields' }, 400);
  }

  const supabase = serviceClient();

  // Check if player is blocked
  const { data: client } = await supabase
    .from('clients')
    .select('is_blocked')
    .eq('torn_id', String(torn_id))
    .maybeSingle();

  if (client?.is_blocked) {
    return json({ error: 'Your account has been blocked. Contact Giro for details.' }, 403);
  }

  // Fetch config
  const { data: config, error: configErr } = await supabase
    .from('config')
    .select('*')
    .single();

  if (configErr || !config) {
    return json({ error: 'Failed to load config' }, 500);
  }

  // Check for existing active deal
  const { count: playerActiveCount } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('torn_id', String(torn_id))
    .in('status', ['requested', 'purchased']);

  if ((playerActiveCount || 0) > 0) {
    return json({ error: 'You already have an active deal. Wait for it to close before purchasing again.' }, 400);
  }

  // Snapshot prices should match what the client was shown on screen, which
  // uses live Torn market values — not the stored config, which only updates
  // when the operator hits "Refresh prices" in admin. Pull live prices here
  // via the user's own key/session; fall back to config if the lookup fails
  // so a Torn API blip can't block a purchase.
  let livePrices: { xanax: number; edvd: number; ecstasy: number } | null = null;
  if (body.key || body.api_key || (body.player_id && body.session_token)) {
    const resolved = await resolveApiKey(body);
    // If auth was supplied but invalid (e.g. expired session), resolveApiKey
    // returns a Response — don't fail the purchase over it, just fall back.
    if (!(resolved instanceof Response)) {
      livePrices = await fetchLiveItemPrices(resolved.key);
    }
  }

  // Calculate costs (bigint columns come back as strings from Supabase)
  const xanaxPrice = livePrices ? livePrices.xanax : Number(config.xanax_price);
  const edvdPrice = livePrices ? livePrices.edvd : Number(config.edvd_price);
  const ecstasyPrice = livePrices ? livePrices.ecstasy : Number(config.ecstasy_price);
  const rehabBonus = Number(config.rehab_bonus);
  const reserve = Number(config.current_reserve);

  const packageCost = 4 * xanaxPrice + 5 * edvdPrice + ecstasyPrice;
  const xanaxPayout = 4 * xanaxPrice + rehabBonus;
  const ecstasyPayout = packageCost + rehabBonus;

  // Check availability — reserve already reflects locked liabilities for active sales
  const available = Math.floor(reserve / ecstasyPayout);
  if (available <= 0) {
    return json({ error: 'No packages available right now. Check back later.' }, 400);
  }

  // Determine tier based on consecutive clean streak (Famiglia is permanent)
  const [{ data: playerHistory }, { data: clientRecord }] = await Promise.all([
    supabase
      .from('transactions')
      .select('status, created_at')
      .eq('torn_id', String(torn_id))
      .in('status', ['closed_clean', 'od_xanax', 'od_ecstasy', 'payout_sent']),
    supabase
      .from('clients')
      .select('famiglia_permanent')
      .eq('torn_id', String(torn_id))
      .maybeSingle(),
  ]);

  const cleanCount = computeCleanCount(playerHistory || []);
  const isFamigliaPermanent = clientRecord?.famiglia_permanent === true;

  let tierMargin;
  if (isFamigliaPermanent || cleanCount >= 5) tierMargin = Number(config.margin_legend);
  else if (cleanCount >= 3) tierMargin = Number(config.margin_road);
  else if (cleanCount >= 1) tierMargin = Number(config.margin_safe);
  else tierMargin = Number(config.margin_new);

  // Calculate final price
  let expectedLiability: number;
  let snapshotXanaxPayout = xanaxPayout;

  if (productType === 'ecstasy_only') {
    // Ecstasy-only: covers only the Ecstasy step (flat OD rate, no Xanax coverage)
    expectedLiability = Number(config.ecstasy_od_pct) * ecstasyPayout;
    snapshotXanaxPayout = 0; // Xanax ODs not covered
  } else {
    const pXanOd = 1 - Math.pow(1 - Number(config.xanax_od_pct), 4);
    const pEcsOd = Math.pow(1 - Number(config.xanax_od_pct), 4) * Number(config.ecstasy_od_pct);
    expectedLiability = pXanOd * xanaxPayout + pEcsOd * ecstasyPayout;
  }

  // Insurance-only and ecstasy-only: no drug cost, just expected liability + margin
  const isInsuranceType = productType === 'insurance' || productType === 'ecstasy_only';
  const trueCost = isInsuranceType ? expectedLiability : packageCost + expectedLiability;
  const snapshotPackageCost = isInsuranceType ? 0 : packageCost;
  const suggestedPrice = Math.round(trueCost / (1 - tierMargin));

  // Insert transaction
  const { data: txn, error: txnErr } = await supabase
    .from('transactions')
    .insert({
      torn_id, torn_name, torn_faction, torn_level,
      product_type: productType,
      status: 'requested',
      package_cost: snapshotPackageCost,
      suggested_price: suggestedPrice,
      xanax_payout: snapshotXanaxPayout,
      ecstasy_payout: ecstasyPayout,
      expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    })
    .select('id, status, suggested_price, product_type')
    .single();

  if (txnErr) return json({ error: txnErr.message }, 500);

  // Lock worst-case liability from reserve for this new active sale (atomic)
  await adjustReserve(supabase, -ecstasyPayout);

  // Await email so it completes before the isolate shuts down
  const tier = computeTier(cleanCount);
  const productLabels: Record<string, string> = {
    package: 'La Bella Vita (Package)',
    insurance: 'Protezione Totale (Full Shield)',
    ecstasy_only: "L'Ultimo Miglio (Ecstasy Only)",
  };
  const productLabel = productLabels[productType] || 'Package';
  console.log('[create-transaction] About to send notification email...');
  await sendNotificationEmail(
    `Happy Jump — New ${productLabel} Request — ${torn_name} [${torn_id}]`,
    [
      `New Happy Jump ${productLabel.toLowerCase()} request!`,
      ``,
      `Player: ${torn_name} [${torn_id}]`,
      `Faction: ${torn_faction || 'None'}`,
      `Level: ${torn_level || 'Unknown'}`,
      `Tier: ${tier} (${cleanCount} clean closes)`,
      `Product: ${productLabel}`,
      ``,
      `Price: ${formatMoney(suggestedPrice)}`,
      ...(productType === 'package' ? [`Drug Cost: ${formatMoney(packageCost)}`] : [`Insurance Only — no drug cost`]),
      ``,
      `Transaction ID: ${txn.id}`,
      ``,
      `Log in to the admin dashboard to mark as purchased.`,
    ].join('\n'),
  );
  console.log('[create-transaction] Email send completed');

  // Upsert client record
  await syncClientStats(supabase, String(torn_id), {
    torn_name,
    torn_faction: torn_faction || null,
    torn_level: torn_level || null,
  });

  return json(txn, 201);
}

async function handleGetPlayerTransactions(body: any) {
  const { torn_id } = body;
  if (!torn_id) return json({ error: 'Missing torn_id' }, 400);

  const supabase = serviceClient();

  const [txnResult, clientResult] = await Promise.all([
    supabase
      .from('transactions')
      .select('id, status, product_type, package_cost, suggested_price, xanax_payout, ecstasy_payout, payout_amount, amount_paid, purchased_at, closes_at, closed_at, created_at')
      .eq('torn_id', String(torn_id))
      .order('created_at', { ascending: false }),
    supabase
      .from('clients')
      .select('torn_id, torn_name, torn_faction, torn_level, clean_count, tier, total_spent, total_payouts, transaction_count, is_blocked, famiglia_permanent, first_seen_at, updated_at')
      .eq('torn_id', String(torn_id))
      .maybeSingle(),
  ]);

  if (txnResult.error) return json({ error: txnResult.error.message }, 500);

  const transactions = txnResult.data || [];
  const cleanCount = computeCleanCount(transactions);
  const hasActiveDeal = transactions.some(
    (t: any) => ['requested', 'purchased', 'od_xanax', 'od_ecstasy'].includes(t.status),
  );

  // Famiglia is permanent — if flagged, effective tier is always legend
  const isFamigliaPermanent = clientResult.data?.famiglia_permanent === true;
  const effectiveCleanCount = isFamigliaPermanent ? Math.max(cleanCount, 5) : cleanCount;

  // Self-healing: if computed tier doesn't match stored tier, resync now
  const computedTierNow = computeTier(effectiveCleanCount);
  const storedTier = clientResult.data?.tier;
  const storedCleanCount = clientResult.data?.clean_count;
  if (storedTier !== computedTierNow || storedCleanCount !== effectiveCleanCount) {
    console.log(`[get-player-transactions] Tier mismatch for ${torn_id}: stored=${storedTier}/${storedCleanCount}, computed=${computedTierNow}/${effectiveCleanCount} — resyncing`);
    await syncClientStats(supabase, String(torn_id));
  }

  // Re-read client after potential sync so response reflects current state
  const freshClient = (storedTier !== computedTierNow || storedCleanCount !== effectiveCleanCount)
    ? (await supabase.from('clients').select('*').eq('torn_id', String(torn_id)).maybeSingle()).data
    : clientResult.data;

  return json({
    torn_id: String(torn_id),
    transactions,
    clean_count: effectiveCleanCount,
    has_active_deal: hasActiveDeal,
    is_blocked: freshClient?.is_blocked ?? false,
    famiglia_permanent: freshClient?.famiglia_permanent ?? isFamigliaPermanent,
    client: freshClient || clientResult.data || null,
  });
}

async function handleGetAvailability() {
  const supabase = serviceClient();

  // Auto-close any expired transactions first (releases reserve)
  await autoCloseExpired(supabase);

  const { data: config, error: configErr } = await supabase
    .from('config')
    .select('*')
    .single();

  if (configErr || !config) return json({ error: 'Failed to load config' }, 500);

  const packageCost = 4 * Number(config.xanax_price) + 5 * Number(config.edvd_price) + Number(config.ecstasy_price);
  const ecstasyPayout = packageCost + Number(config.rehab_bonus);
  // Reserve already reflects locked liabilities for active sales,
  // so available = floor(reserve / worst_case_payout) with no active subtraction
  const available = Math.max(0, Math.floor(Number(config.current_reserve) / ecstasyPayout));

  let nextCloseAt: string | null = null;
  if (available <= 0) {
    const { data: nextClose } = await supabase
      .from('transactions')
      .select('closes_at')
      .eq('status', 'purchased')
      .not('closes_at', 'is', null)
      .order('closes_at', { ascending: true })
      .limit(1)
      .single();

    nextCloseAt = nextClose?.closes_at || null;
  }

  return json({ available, nextCloseAt });
}

async function handleAdminUpdateStatus(req: Request, body: any) {
  const user = await requireAuth(req);
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const { txn_id, new_status } = body;
  if (!txn_id || !new_status) return json({ error: 'Missing txn_id or new_status' }, 400);

  const validStatuses = ['purchased', 'closed_clean', 'od_xanax', 'od_ecstasy', 'payout_sent', 'rejected'];
  if (!validStatuses.includes(new_status)) return json({ error: 'Invalid status' }, 400);

  const supabase = serviceClient();

  // Always fetch torn_id from the transaction itself (don't rely on request body)
  const { data: txnRecord, error: fetchErr } = await supabase
    .from('transactions')
    .select('torn_id, torn_name, status, suggested_price, amount_paid, xanax_payout, ecstasy_payout, payout_amount')
    .eq('id', txn_id)
    .single();

  if (fetchErr || !txnRecord) {
    console.error('[admin-update-status] Failed to fetch transaction:', fetchErr?.message);
    return json({ error: 'Transaction not found' }, 404);
  }

  const tornId = txnRecord.torn_id;

  // Build update payload
  const updates: Record<string, unknown> = { status: new_status };

  if (new_status === 'purchased') {
    const now = new Date().toISOString();
    updates.purchased_at = now;
    updates.closes_at = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    updates.expires_at = null; // Clear request expiry once purchased
    // Treat operator's "Mark Purchased" click as confirmation that payment was received.
    // verify-payment only catches Torn-trade money sends; out-of-band payments (faction
    // bank, friend pays, in-person trade) leave amount_paid at 0. Operator wouldn't mark
    // Purchased without payment received, so backfill amount_paid to suggested_price.
    if (Number(txnRecord.amount_paid || 0) === 0 && txnRecord.suggested_price) {
      updates.amount_paid = txnRecord.suggested_price;
    }
  }

  // Defensive backstop: if a legacy purchased row (from before the autofill above existed)
  // is now being closed, fill amount_paid on the way out so closed rows always have it set.
  // rejected stays at 0 — that's the truthful no-payment-received state.
  if ((new_status === 'closed_clean' || new_status === 'payout_sent')
      && Number(txnRecord.amount_paid || 0) === 0
      && txnRecord.suggested_price) {
    updates.amount_paid = txnRecord.suggested_price;
  }

  // Determine reserve transition direction
  const oldStatus = txnRecord.status;
  const reserveReleasedStates = ['closed_clean', 'payout_sent', 'rejected'];
  const reserveLockedStates = ['requested', 'purchased', 'od_xanax', 'od_ecstasy'];
  const wasReleased = reserveReleasedStates.includes(oldStatus);
  const willBeLocked = reserveLockedStates.includes(new_status);
  const wasLocked = reserveLockedStates.includes(oldStatus);
  const willBeReleased = reserveReleasedStates.includes(new_status);

  // Revenue tracking: states where client has paid and money belongs to the
  // operator (folded into reserve). 'requested' and 'rejected' are pre-payment.
  const paidStates = ['purchased', 'od_xanax', 'od_ecstasy', 'closed_clean', 'payout_sent'];
  const wasPaid = paidStates.includes(oldStatus);
  const willBePaid = paidStates.includes(new_status);

  if (new_status === 'closed_clean' || new_status === 'payout_sent' || new_status === 'rejected') {
    updates.closed_at = new Date().toISOString();
  }

  // Clear closed_at when transitioning back to an active/OD state
  if (new_status === 'purchased' || new_status === 'od_xanax' || new_status === 'od_ecstasy') {
    updates.closed_at = null;
  }

  // For OD statuses, calculate payout from snapshots
  if (new_status === 'od_xanax' || new_status === 'od_ecstasy') {
    updates.payout_amount = new_status === 'od_xanax'
      ? Number(txnRecord.xanax_payout)
      : Number(txnRecord.ecstasy_payout);
  }

  // When rolling BACK out of an OD state to anything other than payout_sent
  // (i.e. operator retracts the OD: false alarm, customer didn't actually OD),
  // clear the stale payout_amount that was stamped on the OD transition.
  // payout_sent retains the value because that's the real payout record.
  if ((oldStatus === 'od_xanax' || oldStatus === 'od_ecstasy')
      && new_status !== 'payout_sent'
      && new_status !== oldStatus) {
    updates.payout_amount = null;
  }

  // Apply the status update
  const { error: updateErr } = await supabase
    .from('transactions')
    .update(updates)
    .eq('id', txn_id);

  if (updateErr) return json({ error: updateErr.message }, 500);

  // Reserve management: transition-aware lock/release
  // Re-lock reserve when moving FROM a closed state TO an active state
  if (wasReleased && willBeLocked) {
    try {
      const ecsP = Number(txnRecord.ecstasy_payout || 0);
      await adjustReserve(supabase, -ecsP);
      console.log(`[admin-update-status] Reserve re-locked: -${ecsP} for txn ${txn_id} (${oldStatus} → ${new_status})`);
    } catch (e) {
      console.error(`[admin-update-status] Reserve re-lock failed for txn ${txn_id}:`, e?.message || e);
    }
  }
  // Release reserve when moving FROM an active state TO a closed state
  if (wasLocked && willBeReleased) {
    try {
      const ecsP = Number(txnRecord.ecstasy_payout || 0);
      let releaseAmount: number;
      if (new_status === 'payout_sent') {
        const payAmt = Number(updates.payout_amount || txnRecord.payout_amount || 0);
        releaseAmount = ecsP - payAmt;
      } else {
        releaseAmount = ecsP;
      }
      await adjustReserve(supabase, releaseAmount);
      console.log(`[admin-update-status] Reserve released: +${releaseAmount} for txn ${txn_id} (${oldStatus} → ${new_status})`);
    } catch (e) {
      console.error(`[admin-update-status] Reserve release failed for txn ${txn_id}:`, e?.message || e);
    }
  }

  // Revenue tracking: fold amount_paid into reserve on first transition into a
  // paid state; reverse it on rollback to a pre-payment state. Uses the new
  // amount_paid value if the update is setting it (e.g. backfill on purchase).
  const oldAmtPaid = wasPaid ? Number(txnRecord.amount_paid || 0) : 0;
  const newAmtPaid = willBePaid
    ? Number((updates.amount_paid as number | undefined) ?? txnRecord.amount_paid ?? 0)
    : 0;
  const revenueDelta = newAmtPaid - oldAmtPaid;
  if (revenueDelta !== 0) {
    try {
      await adjustReserve(supabase, revenueDelta);
      const verb = revenueDelta > 0 ? 'folded into' : 'removed from';
      console.log(`[admin-update-status] Revenue ${verb} reserve: ${revenueDelta} for txn ${txn_id} (${oldStatus} → ${new_status})`);
    } catch (e) {
      console.error(`[admin-update-status] Revenue adjustment failed for txn ${txn_id}:`, e?.message || e);
    }
  }

  // Sync client stats — always use torn_id from the transaction record
  try {
    await syncClientStats(supabase, String(tornId));
    console.log(`[admin-update-status] Client stats synced for ${tornId}`);
  } catch (e) {
    console.error(`[admin-update-status] syncClientStats failed for ${tornId}:`, e?.message || e);
  }

  // Email notification for key status changes
  const emailStatuses = ['purchased', 'payout_sent', 'rejected', 'od_xanax', 'od_ecstasy'];
  if (emailStatuses.includes(new_status)) {
    const payoutInfo = ['payout_sent', 'od_xanax', 'od_ecstasy'].includes(new_status)
      ? `\nPayout Amount: ${formatMoney(Number(updates.payout_amount || txnRecord.payout_amount || 0))}`
      : '';
    const playerLabel = txnRecord.torn_name ? `${txnRecord.torn_name} [${tornId}]` : tornId;
    await sendNotificationEmail(
      `Happy Jump — ${formatStatus(new_status)} — ${playerLabel}`,
      [
        `Transaction status updated by admin.`,
        ``,
        `Player: ${playerLabel}`,
        `New Status: ${formatStatus(new_status)}`,
        `Transaction ID: ${txn_id}`,
        payoutInfo,
      ].filter(Boolean).join('\n'),
    );
  }

  return json({ success: true, status: new_status });
}

async function handleAdminUpdateClient(req: Request, body: any) {
  const user = await requireAuth(req);
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const { torn_id } = body;
  if (!torn_id) return json({ error: 'Missing torn_id' }, 400);

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.admin_notes !== undefined) updates.admin_notes = String(body.admin_notes);
  if (body.is_blocked !== undefined) updates.is_blocked = Boolean(body.is_blocked);

  const supabase = serviceClient();
  const { error } = await supabase
    .from('clients')
    .update(updates)
    .eq('torn_id', String(torn_id));

  if (error) return json({ error: error.message }, 500);
  return json({ success: true });
}

async function handleAdminRejectAndBlock(req: Request, body: any) {
  const user = await requireAuth(req);
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const { torn_id } = body;
  if (!torn_id) return json({ error: 'Missing torn_id' }, 400);

  const supabase = serviceClient();

  // Find all pending (requested/purchased) transactions for this player
  const { data: pending } = await supabase
    .from('transactions')
    .select('id, status, ecstasy_payout, amount_paid')
    .eq('torn_id', String(torn_id))
    .in('status', ['requested', 'purchased']);

  const now = new Date().toISOString();
  let rejectedCount = 0;

  // Reject each pending transaction, release reserve, and refund any revenue
  // that was already folded in (for 'purchased' rows — operator is presumed
  // to be refunding the client out-of-band).
  for (const txn of (pending || [])) {
    await supabase
      .from('transactions')
      .update({ status: 'rejected', closed_at: now })
      .eq('id', txn.id);

    await adjustReserve(supabase, Number(txn.ecstasy_payout || 0));

    if (txn.status === 'purchased' && Number(txn.amount_paid || 0) > 0) {
      await adjustReserve(supabase, -Number(txn.amount_paid));
    }
    rejectedCount++;
  }

  // Block the client
  await supabase
    .from('clients')
    .update({ is_blocked: true, updated_at: now })
    .eq('torn_id', String(torn_id));

  // Sync client stats
  await syncClientStats(supabase, String(torn_id));

  return json({ success: true, rejected_count: rejectedCount });
}

async function handleUpdateConfig(req: Request, body: any) {
  const user = await requireAuth(req);
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const allowed = [
    'xanax_price', 'edvd_price', 'ecstasy_price',
    'xanax_od_pct', 'ecstasy_od_pct', 'rehab_bonus',
    'margin_new', 'margin_safe', 'margin_road', 'margin_legend',
    'current_reserve',
  ];

  const sanitized: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const key of allowed) {
    if (body[key] !== undefined) {
      sanitized[key] = body[key];
    }
  }

  const supabase = serviceClient();
  const { data, error } = await supabase
    .from('config')
    .update(sanitized)
    .eq('id', 1)
    .select()
    .single();

  if (error) return json({ error: error.message }, 500);
  return json(data);
}

// Compute the real Ecstasy-OD payout: instead of a fixed 5x EDVD, replace
// exactly the happiness-boosting items the client actually consumed in the
// policy window, valued live, plus the fixed 4x Xanax + 1x Ecstasy + rehab
// bonus. This is the core of the Choco-Jump fix. Returns null if the log scan
// or price lookup fails so the caller can fall back to the stored
// ecstasy_payout snapshot — a Torn API blip must never block a payout.
async function computeEcstasyConsumedPayout(
  apiKey: string,
  config: any,
  fromTs: number,
  untilTs: number,
): Promise<{ payout: number; consumedItems: Record<string, unknown> } | null> {
  let scan: Awaited<ReturnType<typeof countHappyItemsUsed>>;
  let itemsMap: Awaited<ReturnType<typeof fetchTornItemsMap>>;
  try {
    [scan, itemsMap] = await Promise.all([
      countHappyItemsUsed(apiKey, fromTs, untilTs),
      fetchTornItemsMap(apiKey),
    ]);
  } catch (e) {
    console.error(`[computeEcstasyConsumedPayout] scan/price failed: ${e?.message || e}`);
    return null;
  }
  // Without a price map we can't value the happy items — fall back to snapshot.
  if (!itemsMap) {
    console.warn('[computeEcstasyConsumedPayout] itemsMap unavailable, falling back to snapshot');
    return null;
  }

  const allItems = Object.entries(scan.items).map(([id, info]) => {
    const meta = itemsMap![id];
    const unitValue = meta ? Number(meta.market_value) : 0;
    const itemId = Number(id);
    // A package only ships 5x EDVD, so cap the EDVD line at 5 even if the
    // client used more before jumping — we only ever replace the covered 5.
    const usedQty = info.qty;
    const payQty = itemId === EDVD_ITEM_ID ? Math.min(usedQty, EDVD_PAYOUT_CAP) : usedQty;
    return {
      item_id: itemId,
      name: meta?.name || `item ${id}`,
      qty: payQty,
      used_qty: usedQty,
      capped: payQty !== usedQty,
      unit_value: unitValue,
      line_value: unitValue * payQty,
      transferable: !isNonTransferableHappyItem(itemId, meta),
    };
  });

  // Only transferable items count toward the payout — we can't replace eggs /
  // stock-benefit / other non-tradeable items, so they're tracked separately
  // for transparency but contribute $0.
  const happyItems = allItems.filter((it) => it.transferable).sort((a, b) => b.line_value - a.line_value);
  const excludedItems = allItems.filter((it) => !it.transferable).sort((a, b) => b.line_value - a.line_value);

  const happyValue = happyItems.reduce((s, it) => s + it.line_value, 0);
  const xanaxUnit = Number(itemsMap['206']?.market_value) || Number(config.xanax_price) || 0;
  const ecstasyUnit = Number(itemsMap['197']?.market_value) || Number(config.ecstasy_price) || 0;
  const rehab = Number(config.rehab_bonus) || 0;
  const xanaxLine = 4 * xanaxUnit;
  const ecstasyLine = 1 * ecstasyUnit;
  const total = Math.round(xanaxLine + happyValue + ecstasyLine + rehab);

  return {
    payout: total,
    consumedItems: {
      happy_items: happyItems,
      excluded_items: excludedItems,
      happy_value: happyValue,
      xanax: { qty: 4, unit_value: xanaxUnit, line_value: xanaxLine },
      ecstasy: { qty: 1, unit_value: ecstasyUnit, line_value: ecstasyLine },
      rehab_bonus: rehab,
      total,
      prices_live: true,
      window: { from_ts: fromTs, until_ts: untilTs },
      priced_at: new Date().toISOString(),
    },
  };
}

async function handleReportOd(body: any) {
  const { txn_id } = body;
  if (!txn_id) return json({ error: 'Missing txn_id' }, 400);

  const resolved = await resolveApiKey(body);
  if (resolved instanceof Response) return resolved;
  const api_key = resolved.key;

  // Validate the API key and get player identity
  const identRes = await fetch(`${TORN_API}/user/?selections=basic,profile&key=${api_key}`);
  const identData = await identRes.json();
  if (identData.error) {
    return json({ error: `Torn API: ${identData.error.error}` }, 400);
  }

  const tornId = String(identData.player_id);
  const supabase = serviceClient();

  // Get the transaction and verify ownership
  const { data: txn, error: txnErr } = await supabase
    .from('transactions')
    .select('id, torn_id, purchased_at, closes_at, status, product_type, suggested_price, amount_paid, xanax_payout, ecstasy_payout')
    .eq('id', txn_id)
    .single();

  if (txnErr || !txn) return json({ error: 'Transaction not found' }, 404);
  if (txn.torn_id !== tornId) return json({ error: 'This transaction does not belong to you' }, 403);
  if (txn.status !== 'purchased') return json({ error: 'Transaction is not in active insurance window' }, 400);

  // Strip HTML tags helper
  const stripHtml = (s: any) => String(s || '').replace(/<[^>]*>/g, '');

  // Verify OD via events log — works for both Xanax (hospitalizes) and Ecstasy (does NOT hospitalize).
  // We always use the events log so we can capture the event timestamp for replay prevention.
  const purchasedAt = txn.purchased_at ? new Date(txn.purchased_at) : null;
  // 1. Check events for OD (ODs appear in events endpoint)
  const fromTs = purchasedAt ? Math.floor(purchasedAt.getTime() / 1000) : undefined;
  const eventsUrl = fromTs
    ? `${TORN_API}/user/?selections=events&from=${fromTs}&key=${api_key}`
    : `${TORN_API}/user/?selections=events&key=${api_key}`;
  const eventsRes = await fetch(eventsUrl);
  const eventsData = await eventsRes.json();

  let odDrug: string | null = null;
  let odEventTimestamp: number | null = null;
  // Tracks where the OD classification came from. 'events' = matched the
  // first-person regex against the events feed (can have noise from faction
  // narratives, so the cross-validation against drug-use counts applies);
  // 'log' = matched on a log entry whose data.item ID is authoritative
  // (cross-validation skipped — the structured ID won't lie about the drug).
  let odSource: 'events' | 'log' | null = null;

  // Diagnostics — captured whether or not we find a match so the no-match
  // path can surface what Torn actually returned. Without this we're
  // debugging blind on regex / phrasing / API-delay issues.
  const eventsDiag = {
    error: eventsData?.error || null,
    total_events: eventsData?.events ? Object.keys(eventsData.events).length : 0,
    in_window_count: 0,
    overdose_narratives: [] as Array<{ ts: number; text: string }>,
    sample_narratives: [] as Array<{ ts: number; text: string }>,
    from_ts: fromTs ?? null,
  };

  if (!eventsData.error && eventsData.events) {
    const events = Object.values(eventsData.events) as any[];
    events.sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0));
    for (const evt of events) {
      // Defensive timestamp re-check in case the API's `from` filter is fuzzy
      // and a pre-policy OD event from a previous jump leaks through.
      if (fromTs && evt.timestamp && evt.timestamp < fromTs) continue;
      eventsDiag.in_window_count++;
      const evtText = stripHtml(evt.event || '').toLowerCase();
      // Capture any narrative containing "overdose" so we can see why the
      // regex rejected it. Capture up to 5 generic samples too for context.
      if (evtText.includes('overdos') && eventsDiag.overdose_narratives.length < 10) {
        eventsDiag.overdose_narratives.push({ ts: evt.timestamp, text: evtText.slice(0, 300) });
      }
      if (eventsDiag.sample_narratives.length < 5) {
        eventsDiag.sample_narratives.push({ ts: evt.timestamp, text: evtText.slice(0, 200) });
      }
      const matchedDrug = classifyOdNarrative(evtText);
      if (matchedDrug) {
        odDrug = matchedDrug;
        odEventTimestamp = evt.timestamp;
        odSource = 'events';
        break;
      }
    }
  }
  console.log(`[report-od] eventsDiag: ${JSON.stringify(eventsDiag)}`);

  // 2. Check log for drug usage (paginated — drug use is in log, not events).
  // Also scan the log for OD entries — Torn's events feed sometimes lags
  // 2-5 minutes behind the actual OD while the log gets the entry within
  // seconds, so the log scan acts as a fallback when the events scan
  // finds nothing.
  const [xanaxResult, ecstasyUsage, logOd] = await Promise.all([
    countXanaxUsageInLog(api_key, fromTs),
    findEcstasyUsageInLog(api_key, fromTs),
    findOdInLog(api_key, fromTs),
  ]);

  const xanaxUsedCount = xanaxResult.count;
  const ecstasyUsed = !!ecstasyUsage;

  // Events-feed fallback — if the events scan didn't find an OD narrative
  // (regex miss or Torn API delay), use the log-scan result. The log
  // entry's timestamp serves as the replay-prevention key the same way an
  // events-feed timestamp would.
  if (!odDrug && logOd) {
    odDrug = logOd.drug;
    odEventTimestamp = logOd.timestamp;
    odSource = 'log';
    console.log(`[report-od] events-feed had no match, using log fallback: ${logOd.detail}`);
  }

  // Cross-validate the events-scan classification against the drug-use log.
  // You cannot OD on a drug you never took, so if events say "Xanax OD" but the
  // log shows zero in-policy Xanax uses while Ecstasy was used, the events match
  // is noise and the real OD is on Ecstasy. The log is ground truth for drug use.
  //
  // Only applied to events-source ODs — the log fallback path (odSource='log')
  // already classified by data.item ID, which is authoritative. Re-classifying
  // a Xanax-OD-on-first-pill as Ecstasy because xanaxUsedCount=0 (the OD was
  // the only Xanax entry, and the matcher excludes ODs from the count) would
  // be flatly wrong.
  if (odSource === 'events' && odDrug === 'xanax' && xanaxUsedCount === 0 && ecstasyUsed) {
    odDrug = 'ecstasy';
    // odEventTimestamp stays — still a valid timestamp for replay-prevention.
  }

  // If Ecstasy was used successfully AND no OD was detected, auto-close — the jump is complete.
  // Ecstasy is the final step of a Happy Jump; once it's used without an OD, coverage is spent
  // regardless of how many Xanax show in the log (clients commonly stack Xanax before buying
  // insurance, so the in-policy Xanax count is often < 4 even on a fully-completed jump).
  // IMPORTANT: do NOT clean-close if an OD event exists. An Ecstasy OD also produces an Ecstasy "use"
  // log entry (the OD is recorded separately in the events endpoint, and the use-log narrative does
  // not always contain "overdose"), so `ecstasyUsed` can be true precisely when the covered Ecstasy OD
  // happened. Falling through to the OD verification path below is what pays that claim out.
  if (!odDrug && ecstasyUsed) {
    const nowIso = new Date().toISOString();
    const closeUpdate: Record<string, unknown> = { status: 'closed_clean', closed_at: nowIso };
    // Defensive backstop for legacy purchased rows where amount_paid never got filled.
    if (Number(txn.amount_paid || 0) === 0 && txn.suggested_price) {
      closeUpdate.amount_paid = txn.suggested_price;
    }
    await supabase
      .from('transactions')
      .update(closeUpdate)
      .eq('id', txn_id);

    await adjustReserve(supabase, Number(txn.ecstasy_payout || 0));
    await syncClientStats(supabase, tornId, { torn_name: identData.name });

    await sendNotificationEmail(
      `Happy Jump — Clean Close (Ecstasy Used) — ${identData.name} [${tornId}]`,
      [
        `Client tried to claim an OD, but API log shows Ecstasy taken successfully (${xanaxUsedCount} Xanax + Ecstasy in-policy).`,
        `Policy auto-closed clean — the Happy Jump is complete.`,
        ``,
        `Player: ${identData.name} [${tornId}]`,
        `Transaction ID: ${txn_id}`,
        `Reserve released: ${formatMoney(Number(txn.ecstasy_payout || 0))}`,
      ].join('\n'),
    );

    return json({
      verified: false,
      policy_closed: true,
      torn_id: tornId,
      detail: `Ecstasy was already taken successfully — your Happy Jump is complete and the policy has been closed clean.`,
    });
  }

  // If all 4 Xanax used and they're claiming a Xanax OD — reject (covered uses consumed)
  if (xanaxUsedCount >= 4 && odDrug === 'xanax') {
    return json({
      verified: false,
      torn_id: tornId,
      detail: `All 4 covered Xanax uses have already been taken successfully. This Xanax OD is on an additional, uncovered pill.`,
    });
  }

  // No standalone "ecstasy already used" rejection — it was causing false negatives:
  //   • For an Ecstasy OD: Torn writes an Ecstasy "use" log entry for the OD itself (the
  //     overdose is in the events endpoint, not the log narrative), so ecstasyUsed=true IS
  //     the covered OD and must pay out.
  //   • For a Xanax OD (on a covered pill 1–4) after the Ecstasy was already used successfully,
  //     the Xanax OD is still covered — it's the Xanax pill that's being claimed.
  // Real protections: xanaxUsedCount>=4 check above (uncovered extra Xanax),
  // od_event_timestamp replay prevention below, and single-active-deal guard on purchase.

  if (!odDrug) {
    const playerStatus = identData.status?.description || 'unknown';
    return json({
      verified: false,
      detail: `Could not verify OD. No overdose on Xanax or Ecstasy found in your event log since this transaction started. Current status: "${playerStatus}". If you just OD'd, wait a moment and try again.`,
    });
  }

  if (odDrug !== 'xanax' && odDrug !== 'ecstasy') {
    return json({
      verified: false,
      detail: `Overdose detected on ${odDrug}, which is not covered by Happy Jump insurance.`,
    });
  }

  // Ecstasy-only policies do not cover Xanax ODs
  if (txn.product_type === 'ecstasy_only' && odDrug === 'xanax') {
    return json({
      verified: false,
      detail: `Xanax OD detected, but your L'Ultimo Miglio policy only covers Ecstasy ODs. Xanax ODs are not covered under this policy.`,
    });
  }

  // Prevent replay: check that no other transaction already used this same OD event
  if (odEventTimestamp) {
    const { data: existing } = await supabase
      .from('transactions')
      .select('id')
      .eq('torn_id', tornId)
      .eq('od_event_timestamp', odEventTimestamp)
      .neq('id', txn_id)
      .limit(1);

    if (existing && existing.length > 0) {
      return json({
        verified: false,
        detail: `This overdose event has already been used for a previous payout claim.`,
      });
    }
  }

  // Verified — update the transaction
  const odStatus = odDrug === 'xanax' ? 'od_xanax' : 'od_ecstasy';

  const updatePayload: any = { status: odStatus };
  if (odEventTimestamp) updatePayload.od_event_timestamp = odEventTimestamp;

  // Compute the payout. Xanax ODs are flat (4x Xanax + rehab, already snapshot
  // in xanax_payout). Ecstasy ODs replace exactly the happiness-boosting items
  // the client actually consumed (Choco-Jump fix) — scan the log + value live,
  // falling back to the stored snapshot if Torn is unreachable so a blip never
  // blocks a payout.
  let payoutAmount = Number(odDrug === 'xanax' ? txn.xanax_payout : txn.ecstasy_payout);
  let consumedPayout: Awaited<ReturnType<typeof computeEcstasyConsumedPayout>> = null;
  if (odDrug === 'ecstasy') {
    const { data: cfg } = await supabase.from('config').select('*').single();
    const odWindowEnd = odEventTimestamp || Math.floor(Date.now() / 1000);
    consumedPayout = (fromTs != null)
      ? await computeEcstasyConsumedPayout(api_key, cfg || {}, fromTs, odWindowEnd)
      : null;
    if (consumedPayout) {
      payoutAmount = consumedPayout.payout;
      updatePayload.consumed_items = consumedPayout.consumedItems;
    }
  }
  updatePayload.payout_amount = payoutAmount;

  const { error: updateErr } = await supabase
    .from('transactions')
    .update(updatePayload)
    .eq('id', txn_id);

  if (updateErr) return json({ error: updateErr.message }, 500);

  const drugLabel = odDrug === 'xanax' ? 'Xanax' : 'Ecstasy';

  // For an Ecstasy OD, spell out exactly what to send in-game: 4x Xanax + the
  // happiness items the client actually consumed + 1x Ecstasy + rehab bonus.
  const consumedLines: string[] = [];
  if (odDrug === 'ecstasy') {
    if (consumedPayout) {
      const ci: any = consumedPayout.consumedItems;
      consumedLines.push(``, `Replacement package to send (live-valued):`);
      consumedLines.push(`  ${ci.xanax.qty}x Xanax — ${formatMoney(ci.xanax.line_value)}`);
      for (const it of (ci.happy_items as any[])) {
        consumedLines.push(`  ${it.qty}x ${it.name} — ${formatMoney(it.line_value)}`);
      }
      if ((ci.happy_items as any[]).length === 0) {
        consumedLines.push(`  (no happiness items found in policy window)`);
      }
      consumedLines.push(`  ${ci.ecstasy.qty}x Ecstasy — ${formatMoney(ci.ecstasy.line_value)}`);
      consumedLines.push(`  Rehab bonus — ${formatMoney(ci.rehab_bonus)}`);
      if ((ci.excluded_items as any[])?.length) {
        consumedLines.push(`  NOT replaced (non-transferable): ${(ci.excluded_items as any[]).map((it) => `${it.qty}x ${it.name}`).join(', ')}`);
      }
    } else {
      consumedLines.push(``, `(Could not scan consumed items — Torn API blip. Payout uses the stored snapshot; verify the package manually.)`);
    }
  }

  // Must await — Edge Functions terminate the isolate after response is sent,
  // so un-awaited promises get killed before the SMTP send completes.
  await sendNotificationEmail(
    `Happy Jump — OD Payout Request — ${identData.name} [${tornId}] — ${drugLabel}`,
    [
      `OD verified and payout required!`,
      ``,
      `Player: ${identData.name} [${tornId}]`,
      `OD Type: ${drugLabel}`,
      `Payout Amount: ${formatMoney(Number(payoutAmount))}`,
      ...consumedLines,
      ``,
      `Transaction ID: ${txn_id}`,
      ``,
      `Log in to the admin dashboard to send the payout.`,
    ].join('\n'),
  );

  // Sync client stats (clean streak recomputed from transactions)
  await syncClientStats(supabase, tornId, { torn_name: identData.name });

  return json({
    verified: true,
    od_type: odStatus,
    torn_id: tornId,
    detail: `OD on ${drugLabel} verified. Giro has been notified and will send your payout.`,
  });
}

async function handleCheckDrugUsage(body: any) {
  const { txn_id } = body;
  if (!txn_id) return json({ error: 'Missing txn_id' }, 400);

  const resolved = await resolveApiKey(body);
  if (resolved instanceof Response) return resolved;
  const api_key = resolved.key;

  console.log(`[handleCheckDrugUsage] START txn_id=${txn_id}`);

  // Validate API key
  const identRes = await fetch(`${TORN_API}/user/?selections=basic,profile&key=${api_key}`);
  const identData = await identRes.json();
  if (identData.error) return json({ error: `Torn API: ${identData.error.error}` }, 400);

  const tornId = String(identData.player_id);
  const supabase = serviceClient();

  const { data: txn, error: txnErr } = await supabase
    .from('transactions')
    .select('id, torn_id, purchased_at, status, suggested_price, amount_paid, ecstasy_payout')
    .eq('id', txn_id)
    .single();

  if (txnErr || !txn) return json({ error: 'Transaction not found' }, 404);
  if (txn.torn_id !== tornId) return json({ error: 'This transaction does not belong to you' }, 403);
  if (txn.status !== 'purchased') return json({ xanax_used: 0, ecstasy_used: false });

  // Paginate through log entries since purchase to check for drug usage
  const purchasedAt = txn.purchased_at ? new Date(txn.purchased_at) : null;
  const fromTs = purchasedAt ? Math.floor(purchasedAt.getTime() / 1000) : undefined;

  console.log(`[handleCheckDrugUsage] tornId=${tornId} purchased_at=${txn.purchased_at} fromTs=${fromTs}`);

  // Check both drugs in parallel
  const [xanaxResult, ecstasyUsage] = await Promise.all([
    countXanaxUsageInLog(api_key, fromTs),
    findEcstasyUsageInLog(api_key, fromTs),
  ]);

  const xanaxUsed = Math.min(xanaxResult.count, 4); // cap at 4 for display
  const ecstasyUsed = !!ecstasyUsage;

  console.log(`[handleCheckDrugUsage] RESULT txn_id=${txn_id} xanaxUsed=${xanaxUsed} (raw=${xanaxResult.count}) ecstasyUsed=${ecstasyUsed} pages=${xanaxResult.pages} totalEntries=${xanaxResult.totalEntries}`);

  // Debug info surfaced to the client so they (and the operator inspecting
  // the client's view) can verify detection against the Torn log.
  const debug = {
    purchased_at: txn.purchased_at,
    from_ts: fromTs,
    xanax_raw_count: xanaxResult.count,
    xanax_pages: xanaxResult.pages,
    xanax_log_entries_scanned: xanaxResult.totalEntries,
    xanax_details: xanaxResult.details,
    ecstasy_detail: ecstasyUsage ? ecstasyUsage.detail : null,
  };

  const nowIso = new Date().toISOString();

  // Auto-close if Ecstasy was used successfully — the Happy Jump is complete.
  // Xanax count is informational only; clients often stack Xanax before purchase, so the
  // in-policy count is frequently < 4 even on a fully-finished jump. Ecstasy use is the
  // unambiguous "jump done" signal.
  if (ecstasyUsed) {
    const closeUpdate: Record<string, unknown> = { status: 'closed_clean', closed_at: nowIso };
    // Defensive backstop for legacy purchased rows where amount_paid never got filled.
    if (Number(txn.amount_paid || 0) === 0 && txn.suggested_price) {
      closeUpdate.amount_paid = txn.suggested_price;
    }
    await supabase
      .from('transactions')
      .update(closeUpdate)
      .eq('id', txn_id);

    await adjustReserve(supabase, Number(txn.ecstasy_payout || 0));
    await syncClientStats(supabase, tornId, { torn_name: identData.name });

    await sendNotificationEmail(
      `Happy Jump — Clean Close (Ecstasy Used) — ${identData.name} [${tornId}]`,
      [
        `Client's API log confirms Ecstasy taken successfully (${xanaxUsed} Xanax + Ecstasy in-policy).`,
        `Policy auto-closed clean — the Happy Jump is complete.`,
        ``,
        `Player: ${identData.name} [${tornId}]`,
        `Transaction ID: ${txn_id}`,
        `Reserve released: ${formatMoney(Number(txn.ecstasy_payout || 0))}`,
      ].join('\n'),
    );

    return json({
      xanax_used: xanaxUsed,
      ecstasy_used: ecstasyUsed,
      policy_closed: true,
      detail: 'Ecstasy taken successfully — Happy Jump complete! Policy closed clean. Congrats!',
      debug,
    });
  }

  return json({ xanax_used: xanaxUsed, ecstasy_used: ecstasyUsed, debug });
}

// Admin-only: run the same Xanax/Ecstasy log scan as handleCheckDrugUsage
// but with a caller-supplied API key and arbitrary `from_ts`. Lets the
// operator test detection against their own Torn account without needing
// an actual transaction row. Returns the full debug payload.
async function handleAdminTestDrugCheck(req: Request, body: any) {
  const user = await requireAuth(req);
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const { api_key, from_ts } = body;
  if (!api_key) return json({ error: 'Missing api_key' }, 400);

  // Validate API key + grab identity so the operator can confirm it's theirs
  const identRes = await fetch(`${TORN_API}/user/?selections=basic,profile&key=${api_key}`);
  const identData = await identRes.json();
  if (identData.error) return json({ error: `Torn API: ${identData.error.error}` }, 400);

  // from_ts is optional — if omitted, scan default window (no cutoff)
  const fromTs = from_ts ? Number(from_ts) : undefined;
  if (from_ts && (!Number.isFinite(fromTs) || fromTs! <= 0)) {
    return json({ error: 'from_ts must be a positive unix timestamp in seconds' }, 400);
  }

  console.log(`[admin-test-drug-check] player=${identData.name} [${identData.player_id}] fromTs=${fromTs}`);

  const [xanaxResult, ecstasyUsage] = await Promise.all([
    countXanaxUsageInLog(api_key, fromTs),
    findEcstasyUsageInLog(api_key, fromTs),
  ]);

  return json({
    player: {
      name: identData.name,
      id: String(identData.player_id),
      level: identData.level || null,
    },
    from_ts: fromTs ?? null,
    from_iso: fromTs ? new Date(fromTs * 1000).toISOString() : null,
    xanax_count: xanaxResult.count,
    xanax_pages: xanaxResult.pages,
    xanax_log_entries_scanned: xanaxResult.totalEntries,
    xanax_details: xanaxResult.details,
    ecstasy_found: !!ecstasyUsage,
    ecstasy_detail: ecstasyUsage ? ecstasyUsage.detail : null,
  });
}

// Admin-only: run the full report-od logic against an arbitrary api_key +
// transaction id (or arbitrary from_ts) without mutating anything. Returns
// the events-feed scan, the log OD scan, and the drug-use counts so the
// operator can see exactly why a verify-od call did or did not succeed.
async function handleAdminTestOdVerify(req: Request, body: any) {
  const user = await requireAuth(req);
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const { api_key, txn_id, from_ts } = body;
  if (!api_key) return json({ error: 'Missing api_key' }, 400);

  const identRes = await fetch(`${TORN_API}/user/?selections=basic,profile&key=${api_key}`);
  const identData = await identRes.json();
  if (identData.error) return json({ error: `Torn API: ${identData.error.error}` }, 400);

  let fromTs: number | undefined;
  let txn: any = null;
  if (txn_id) {
    const supabase = serviceClient();
    const { data } = await supabase
      .from('transactions')
      .select('id, torn_id, torn_name, status, purchased_at, created_at, suggested_price, xanax_payout, ecstasy_payout, product_type, od_event_timestamp')
      .eq('id', txn_id)
      .maybeSingle();
    if (!data) return json({ error: `Transaction ${txn_id} not found` }, 404);
    txn = data;
    if (txn.purchased_at) fromTs = Math.floor(new Date(txn.purchased_at).getTime() / 1000);
  } else if (from_ts) {
    fromTs = Number(from_ts);
    if (!Number.isFinite(fromTs) || fromTs! <= 0) {
      return json({ error: 'from_ts must be a positive unix timestamp in seconds' }, 400);
    }
  }

  const stripHtml = (s: any) => String(s || '').replace(/<[^>]*>/g, '');

  const eventsUrl = fromTs
    ? `${TORN_API}/user/?selections=events&from=${fromTs}&key=${api_key}`
    : `${TORN_API}/user/?selections=events&key=${api_key}`;
  const eventsRes = await fetch(eventsUrl);
  const eventsData = await eventsRes.json();

  const eventsDiag = {
    error: eventsData?.error || null,
    total_events: eventsData?.events ? Object.keys(eventsData.events).length : 0,
    in_window_count: 0,
    overdose_narratives: [] as Array<{ ts: number; text: string }>,
    sample_narratives: [] as Array<{ ts: number; text: string }>,
    matched: null as null | { drug: string; ts: number; text: string },
  };

  if (!eventsData.error && eventsData.events) {
    const events = (Object.values(eventsData.events) as any[])
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    for (const evt of events) {
      if (fromTs && evt.timestamp && evt.timestamp < fromTs) continue;
      eventsDiag.in_window_count++;
      const evtText = stripHtml(evt.event || '').toLowerCase();
      if (evtText.includes('overdos') && eventsDiag.overdose_narratives.length < 10) {
        eventsDiag.overdose_narratives.push({ ts: evt.timestamp, text: evtText.slice(0, 300) });
      }
      if (eventsDiag.sample_narratives.length < 5) {
        eventsDiag.sample_narratives.push({ ts: evt.timestamp, text: evtText.slice(0, 200) });
      }
      const matchedDrug = classifyOdNarrative(evtText);
      if (matchedDrug && !eventsDiag.matched) {
        eventsDiag.matched = { drug: matchedDrug, ts: evt.timestamp, text: evtText.slice(0, 300) };
      }
    }
  }

  const [xanaxResult, ecstasyUsage, logOd] = await Promise.all([
    countXanaxUsageInLog(api_key, fromTs),
    findEcstasyUsageInLog(api_key, fromTs),
    findOdInLog(api_key, fromTs),
  ]);

  // Mirror the report-od classification logic so the operator sees
  // exactly what the live endpoint would have decided.
  let finalDrug: string | null = eventsDiag.matched?.drug || null;
  let finalSource: 'events' | 'log' | null = finalDrug ? 'events' : null;
  let finalTs: number | null = eventsDiag.matched?.ts || null;
  if (!finalDrug && logOd) {
    finalDrug = logOd.drug;
    finalSource = 'log';
    finalTs = logOd.timestamp;
  }
  if (
    finalSource === 'events' &&
    finalDrug === 'xanax' &&
    xanaxResult.count === 0 &&
    !!ecstasyUsage
  ) {
    finalDrug = 'ecstasy';
  }

  return json({
    player: {
      name: identData.name,
      id: String(identData.player_id),
      level: identData.level || null,
      status: identData.status?.description || null,
    },
    transaction: txn,
    from_ts: fromTs ?? null,
    from_iso: fromTs ? new Date(fromTs * 1000).toISOString() : null,
    events_scan: eventsDiag,
    log_od_scan: logOd
      ? { found: true, drug: logOd.drug, timestamp: logOd.timestamp, detail: logOd.detail }
      : { found: false },
    xanax_log: {
      count: xanaxResult.count,
      pages: xanaxResult.pages,
      total_entries: xanaxResult.totalEntries,
      details: xanaxResult.details,
    },
    ecstasy_log: {
      used: !!ecstasyUsage,
      detail: ecstasyUsage?.detail || null,
    },
    classification: {
      drug: finalDrug,
      source: finalSource,
      timestamp: finalTs,
      timestamp_iso: finalTs ? new Date(finalTs * 1000).toISOString() : null,
    },
  });
}

// Admin-only: scan an API key's log for happiness-boosting item uses in a
// window and value them live, without touching any transaction. Lets the
// operator ingest some EDVDs / candy on their own account and confirm the
// detector captures them correctly before we wire this into the payout path.
async function handleAdminDetectHappyItems(req: Request, body: any) {
  const user = await requireAuth(req);
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const { api_key, from_ts, until_ts } = body;
  if (!api_key) return json({ error: 'Missing api_key' }, 400);

  const identRes = await fetch(`${TORN_API}/user/?selections=basic,profile&key=${api_key}`);
  const identData = await identRes.json();
  if (identData.error) return json({ error: `Torn API: ${identData.error.error}` }, 400);

  // Default to the last 24h if no window given, so the scan is bounded.
  let fromTs: number;
  let windowDefaulted = false;
  if (from_ts && Number.isFinite(Number(from_ts)) && Number(from_ts) > 0) {
    fromTs = Number(from_ts);
  } else {
    fromTs = Math.floor(Date.now() / 1000) - 24 * 3600;
    windowDefaulted = true;
  }
  const untilTs = until_ts && Number.isFinite(Number(until_ts)) && Number(until_ts) > 0
    ? Number(until_ts)
    : undefined;

  const [scan, itemsMap] = await Promise.all([
    countHappyItemsUsed(api_key, fromTs, untilTs),
    fetchTornItemsMap(api_key),
  ]);

  const items = Object.entries(scan.items).map(([id, info]) => {
    const meta = itemsMap?.[id];
    const unitValue = meta ? Number(meta.market_value) : 0;
    const transferable = !isNonTransferableHappyItem(Number(id), meta);
    return {
      item_id: Number(id),
      name: meta?.name || `item ${id}`,
      qty: info.qty,
      unit_value: unitValue,
      line_value: unitValue * info.qty,
      tradeable: meta ? meta.tradeable : null,
      transferable,
      sample_narrative: info.sampleNarrative,
      first_ts: info.firstTs,
      last_ts: info.lastTs,
    };
  }).sort((a, b) => b.line_value - a.line_value);

  const happyItemsValue = items.reduce((s, it) => s + it.line_value, 0);
  const replaceableValue = items.filter((i) => i.transferable).reduce((s, it) => s + it.line_value, 0);
  const excludedValue = items.filter((i) => !i.transferable).reduce((s, it) => s + it.line_value, 0);

  // Enrich the raw item-use samples with names so the operator can eyeball
  // exactly what was seen vs. matched.
  const itemUseSamples = scan.itemUseSamples.map((s) => ({
    ...s,
    name: itemsMap?.[String(s.itemId)]?.name || `item ${s.itemId}`,
  }));

  return json({
    player: {
      name: identData.name,
      id: String(identData.player_id),
      level: identData.level || null,
      status: identData.status?.description || null,
    },
    from_ts: fromTs,
    from_iso: new Date(fromTs * 1000).toISOString(),
    until_ts: untilTs ?? null,
    until_iso: untilTs ? new Date(untilTs * 1000).toISOString() : null,
    window_defaulted: windowDefaulted,
    prices_available: !!itemsMap,
    items,
    happy_item_count: scan.totalQty,
    happy_items_value: happyItemsValue,
    replaceable_value: replaceableValue,
    excluded_value: excludedValue,
    scan: {
      pages: scan.pages,
      total_entries: scan.totalEntries,
      in_window_total: scan.inWindowTotal,
      reached_cutoff: scan.reachedCutoff,
    },
    item_use_samples: itemUseSamples,
  });
}

// Admin-only: for a single active (purchased) transaction, scan the client's
// log for the happiness-boosting items they've consumed since purchase and
// value them live — i.e. the running Ecstasy-OD liability if they OD'd right
// now. Uses the client's own server-stored key (player_secrets); if they never
// signed in we have no key to scan, so we say so plainly rather than showing
// a misleading $0. Read-only: never mutates the transaction.
async function handleAdminActiveConsumed(req: Request, body: any) {
  const user = await requireAuth(req);
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const { txn_id } = body;
  if (!txn_id) return json({ error: 'Missing txn_id' }, 400);

  const supabase = serviceClient();
  const { data: txn } = await supabase
    .from('transactions')
    .select('id, torn_id, torn_name, purchased_at, status')
    .eq('id', txn_id)
    .maybeSingle();
  if (!txn) return json({ error: 'Transaction not found' }, 404);
  if (!txn.purchased_at) return json({ has_key: false, reason: 'not_purchased' });

  const tornIdNum = Number(txn.torn_id);
  if (!Number.isFinite(tornIdNum)) return json({ error: 'Invalid torn_id' }, 400);

  const { data: secret } = await supabase
    .from('player_secrets')
    .select('api_key_enc, api_key_iv')
    .eq('torn_player_id', tornIdNum)
    .maybeSingle();
  if (!secret) return json({ has_key: false, reason: 'no_stored_key' });

  const apiKey = await decryptApiKey(secret.api_key_enc, secret.api_key_iv);
  if (!apiKey) return json({ has_key: false, reason: 'decrypt_failed' });

  // Probe first so a paused/revoked key reads as an error rather than "0 used".
  const probeRes = await fetch(`${TORN_API}/user/?selections=basic&key=${apiKey}`);
  const probe = await probeRes.json().catch(() => ({}));
  if (probe?.error) {
    return json({ has_key: true, key_error: probe.error.error, torn_error_code: probe.error.code });
  }

  const { data: cfg } = await supabase.from('config').select('*').single();
  const fromTs = Math.floor(new Date(txn.purchased_at).getTime() / 1000);
  const untilTs = Math.floor(Date.now() / 1000);
  const [computed, xanaxResult] = await Promise.all([
    computeEcstasyConsumedPayout(apiKey, cfg || {}, fromTs, untilTs),
    countXanaxUsageInLog(apiKey, fromTs),
  ]);
  if (!computed) return json({ has_key: true, scan_failed: true, xanax_used: xanaxResult?.count ?? null });

  return json({
    has_key: true,
    consumed: computed.consumedItems,
    projected_ecstasy_payout: computed.payout,
    xanax_used: xanaxResult.count,
    from_ts: fromTs,
    until_ts: untilTs,
  });
}

// Admin-triggered auto-detect — runs the exact same detection the client's own
// login runs, but server-side using the client's stored key. report-od both
// registers a verified OD (computing payout + emailing the operator) AND
// auto-closes clean when Ecstasy was taken without an OD, so a single call
// covers both the old "Xanax/Ecstasy OD" and "Close Clean" buttons. The
// operator no longer makes the call manually — the client's API log decides.
async function handleAdminAutoDetect(req: Request, body: any) {
  const user = await requireAuth(req);
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const { txn_id } = body;
  if (!txn_id) return json({ error: 'Missing txn_id' }, 400);

  const supabase = serviceClient();
  const { data: txn } = await supabase
    .from('transactions')
    .select('id, torn_id, status')
    .eq('id', txn_id)
    .maybeSingle();
  if (!txn) return json({ error: 'Transaction not found' }, 404);
  if (txn.status !== 'purchased') {
    return json({ error: 'Transaction is not in the active insurance window.' }, 400);
  }

  const tornIdNum = Number(txn.torn_id);
  if (!Number.isFinite(tornIdNum)) return json({ error: 'Invalid torn_id' }, 400);

  // Every client must sign in with a valid Torn key to enter the system, so a
  // stored key should always be on file. Fail loudly if it somehow isn't.
  const { data: secret } = await supabase
    .from('player_secrets')
    .select('api_key_enc, api_key_iv')
    .eq('torn_player_id', tornIdNum)
    .maybeSingle();
  if (!secret) return json({ error: 'No stored key for this client — cannot auto-detect.' }, 409);

  const apiKey = await decryptApiKey(secret.api_key_enc, secret.api_key_iv);
  if (!apiKey) return json({ error: 'Stored key could not be decrypted — ask the client to sign in again.' }, 409);

  // Drive the client-login detection with the stored key. Relay its response
  // verbatim so the admin UI sees the same { verified / policy_closed / detail }
  // shape the client would.
  return await handleReportOd({ key: apiKey, txn_id });
}

async function handleVerifyPayment(body: any) {
  const { txn_id } = body;
  if (!txn_id) return json({ error: 'Missing txn_id' }, 400);

  const resolved = await resolveApiKey(body);
  if (resolved instanceof Response) return resolved;
  const api_key = resolved.key;

  // Validate the API key and get player identity
  const identRes = await fetch(`${TORN_API}/user/?selections=basic,profile&key=${api_key}`);
  const identData = await identRes.json();
  if (identData.error) {
    return json({ error: `Torn API: ${identData.error.error}` }, 400);
  }

  const tornId = String(identData.player_id);
  const supabase = serviceClient();

  // Get the transaction and verify ownership
  const { data: txn, error: txnErr } = await supabase
    .from('transactions')
    .select('id, torn_id, status, suggested_price, amount_paid, created_at, ecstasy_payout')
    .eq('id', txn_id)
    .single();

  if (txnErr || !txn) return json({ error: 'Transaction not found' }, 404);
  if (txn.torn_id !== tornId) return json({ error: 'This transaction does not belong to you' }, 403);
  if (txn.status !== 'requested') return json({ error: 'Transaction is not awaiting payment' }, 400);

  // Operator identity — used to match client's "You sent $X to GiroVagabondo" events
  const operatorName = 'GiroVagabondo';
  const operatorTornId = '3667375';

  // Fetch client's events AND log since transaction creation.
  // Money-send records appear in the user's LOG (actions they took),
  // not EVENTS (things that happened to them).
  const createdAt = txn.created_at ? new Date(txn.created_at) : null;
  const fromTs = createdAt ? Math.floor(createdAt.getTime() / 1000) : undefined;

  const stripHtml = (s: any) => String(s || '').replace(/<[^>]*>/g, '');

  // Fetch events (single call, with from-filter if available)
  const eventsUrl = fromTs
    ? `${TORN_API}/user/?selections=events&from=${fromTs}&key=${api_key}`
    : `${TORN_API}/user/?selections=events&key=${api_key}`;
  const eventsRes = await fetch(eventsUrl);
  const eventsData = await eventsRes.json();

  if (eventsData.error) {
    return json({
      verified: false,
      detail: `Torn API error: ${eventsData.error.error || JSON.stringify(eventsData.error)}. Your API key may need "Events" and "Log" permissions enabled.`,
    });
  }

  // Paginate log: fetch batches of 100 using 'to' parameter, up to 7 days back or 10 pages
  const allLogEntries: any[] = [];
  const cutoffTs = fromTs || Math.floor((Date.now() - 7 * 86400_000) / 1000);
  let toParam = '';

  for (let page = 0; page < 10; page++) {
    const fromParam = fromTs ? `&from=${fromTs}` : '';
    const logUrl = `${TORN_API}/user/?selections=log${fromParam}${toParam}&key=${api_key}`;
    const logRes = await fetch(logUrl);
    const logData = await logRes.json();
    if (logData.error || !logData.log) break;

    const entries = Object.values(logData.log) as any[];
    if (entries.length === 0) break;

    allLogEntries.push(...entries);

    const oldestTs = Math.min(...entries.map((e: any) => e.timestamp || Infinity));
    if (oldestTs <= cutoffTs) break;
    if (entries.length < 100) break;

    toParam = `&to=${oldestTs - 1}`;
  }

  const expectedAmount = Number(txn.suggested_price);
  const previouslyPaid = Number(txn.amount_paid || 0);
  let totalPaid = 0;
  const matchedEvents: string[] = [];

  // Collect entries from both events and log into a single list.
  const allEntries: { text: string }[] = [];
  if (eventsData.events) {
    for (const evt of Object.values(eventsData.events) as any[]) {
      allEntries.push({ text: evt.event || '' });
    }
  }
  // 1. Check structured log data for "Money send" to operator (most reliable)
  for (const entry of allLogEntries) {
    const title = String(entry.title || entry.log || '').toLowerCase();
    const data = entry.data || {};
    if ((title.includes('money send') || title.includes('money transfer')) &&
        String(data.receiver || '') === operatorTornId &&
        Number(data.money || 0) > 0) {
      const amount = Number(data.money);
      totalPaid += amount;
      matchedEvents.push(`${entry.title} — $${amount.toLocaleString()} (log structured data)`);
    }
  }

  // 2. Also check event text for plain-text matches (fallback)
  for (const entry of allLogEntries) {
    const titlePart = entry.log || entry.title || '';
    const dataPart = entry.data ? ' ' + JSON.stringify(entry.data) : '';
    allEntries.push({ text: titlePart + dataPart });
  }

  const debugEntries: string[] = [];
  for (const entry of allEntries) {
    const rawHtml = entry.text;
    const evtText = stripHtml(rawHtml);
    const evtLower = evtText.toLowerCase();

    if (debugEntries.length < 5) {
      debugEntries.push(evtText.substring(0, 120));
    }

    const hasMoney = evtLower.includes('$');
    const hasSendVerb = evtLower.includes('sent') || evtLower.includes('send')
      || evtLower.includes('transfer') || evtLower.includes('paid')
      || evtLower.includes('trade') || evtLower.includes('traded');
    if (!hasMoney || !hasSendVerb) continue;

    const mentionsOperator =
      (operatorName && evtLower.includes(operatorName.toLowerCase())) ||
      evtLower.includes('giro') ||
      rawHtml.includes(String(operatorTornId));

    if (!mentionsOperator) continue;

    const amountMatch = evtText.match(/\$([0-9,]+)/);
    if (!amountMatch) continue;

    const eventAmount = Number(amountMatch[1].replace(/,/g, ''));
    totalPaid += eventAmount;
    matchedEvents.push(evtText);
  }

  // No payments found at all
  if (totalPaid === 0) {
    const evtCount = eventsData.events ? Object.keys(eventsData.events).length : 0;
    const logCount = allLogEntries.length;
    const diag = `[events: ${evtCount}, log: ${logCount}]`;
    const sampleEntries = debugEntries.length > 0
      ? ` Recent entries: ${debugEntries.map((e, i) => `(${i + 1}) "${e}"`).join('; ')}`
      : '';
    console.log(`[verify-payment] No match found. ${diag}${sampleEntries}`);
    return json({
      verified: false,
      detail: allEntries.length === 0
        ? `Your Torn API returned 0 events/log entries ${diag}. This usually means your API key is missing "Log" permissions. Try creating a new key with the link on the home page.`
        : `Could not find any payment to Giro in ${allEntries.length} recent entries. If you just sent the money, wait a moment and try again.`,
      debug_entries: debugEntries,
    });
  }

  // Underpaid — store cumulative amount, return balance due
  if (totalPaid < expectedAmount) {
    const balanceDue = expectedAmount - totalPaid;

    // Update amount_paid on the transaction
    await supabase
      .from('transactions')
      .update({ amount_paid: totalPaid })
      .eq('id', txn_id);

    return json({
      verified: false,
      underpaid: true,
      torn_id: tornId,
      amount_paid: totalPaid,
      balance_due: balanceDue,
      suggested_price: expectedAmount,
      detail: `You've paid ${formatMoney(totalPaid)} of ${formatMoney(expectedAmount)}. Balance due: ${formatMoney(balanceDue)}.`,
    });
  }

  // Paid in full (exact or overpaid) — advance to "purchased"
  const now = new Date().toISOString();
  const closesAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

  const { error: updateErr } = await supabase
    .from('transactions')
    .update({
      status: 'purchased',
      purchased_at: now,
      closes_at: closesAt,
      amount_paid: totalPaid,
    })
    .eq('id', txn_id);

  if (updateErr) return json({ error: updateErr.message }, 500);

  // Notify operator
  const overpaidNote = totalPaid > expectedAmount
    ? `\nNote: Client overpaid by ${formatMoney(totalPaid - expectedAmount)}.`
    : '';
  await sendNotificationEmail(
    `Happy Jump — Payment Verified — ${identData.name} [${tornId}]`,
    [
      `Payment auto-verified via Torn API events!`,
      ``,
      `Player: ${identData.name} [${tornId}]`,
      `Amount paid: ${formatMoney(totalPaid)} (owed: ${formatMoney(expectedAmount)})${overpaidNote}`,
      `Events: ${matchedEvents.join(' | ')}`,
      ``,
      `Transaction ID: ${txn_id}`,
      `Status has been auto-advanced to "purchased" — 3-day insurance window is now active.`,
    ].join('\n'),
  );

  // Sync client stats
  await syncClientStats(supabase, tornId, { torn_name: identData.name });

  return json({
    verified: true,
    torn_id: tornId,
    detail: `Payment of ${formatMoney(totalPaid)} verified! Your 3-day insurance window is now active.`,
  });
}

async function handleAdminCheckPayment(body: any) {
  const { api_key, recipient } = body;
  if (!api_key) return json({ error: 'Missing api_key' }, 400);

  // Validate API key and get player identity
  const identRes = await fetch(`${TORN_API}/user/?selections=basic,profile&key=${api_key}`);
  const identData = await identRes.json();
  if (identData.error) {
    return json({ error: `Torn API: ${identData.error.error}` }, 400);
  }

  const playerName = identData.name || 'Unknown';
  const tornId = String(identData.player_id);

  // Default recipient is GiroVagabondo; can override for testing
  // Accept either a name or a Torn ID
  const recipientInput = recipient || 'GiroVagabondo';
  const isRecipientId = /^\d+$/.test(recipientInput);
  const recipientName = isRecipientId ? null : recipientInput;
  const recipientTornId = isRecipientId ? recipientInput : '3667375'; // default to operator ID

  const stripHtml = (s: any) => String(s || '').replace(/<[^>]*>/g, '');

  // Fetch events (single call)
  const eventsRes = await fetch(`${TORN_API}/user/?selections=events&key=${api_key}`);
  const eventsData = await eventsRes.json();
  if (eventsData.error) {
    return json({
      player: `${playerName} [${tornId}]`,
      error: `Torn API error: ${eventsData.error.error || JSON.stringify(eventsData.error)}`,
    });
  }

  // Paginate log: fetch batches of 100 using 'to' parameter, up to 7 days back or 10 pages
  const allLogEntries: any[] = [];
  const sevenDaysAgo = Math.floor((Date.now() - 7 * 86400_000) / 1000);
  let toParam = '';
  let pagesScanned = 0;

  for (let page = 0; page < 10; page++) {
    const logUrl = `${TORN_API}/user/?selections=log${toParam}&key=${api_key}`;
    const logRes = await fetch(logUrl);
    const logData = await logRes.json();
    if (logData.error || !logData.log) break;

    const entries = Object.values(logData.log) as any[];
    if (entries.length === 0) break;

    allLogEntries.push(...entries);
    pagesScanned = page + 1;

    // Find oldest timestamp in this batch to paginate further back
    const oldestTs = Math.min(...entries.map((e: any) => e.timestamp || Infinity));
    if (oldestTs <= sevenDaysAgo) break;
    if (entries.length < 100) break;

    toParam = `&to=${oldestTs - 1}`;
  }

  const evtCount = eventsData.events ? Object.keys(eventsData.events).length : 0;
  const logCount = allLogEntries.length;

  // Collect all entries
  const allEntries: { text: string; raw: string; timestamp: number; source: string }[] = [];
  if (eventsData.events) {
    for (const [key, evt] of Object.entries(eventsData.events) as any[]) {
      allEntries.push({ text: stripHtml(evt.event || ''), raw: evt.event || '', timestamp: evt.timestamp || 0, source: 'event' });
    }
  }
  for (const entry of allLogEntries) {
    const titlePart = entry.log || entry.title || '';
    const dataPart = entry.data ? ' ' + JSON.stringify(entry.data) : '';
    const rawText = titlePart + dataPart;
    allEntries.push({ text: stripHtml(rawText), raw: rawText, timestamp: entry.timestamp || 0, source: 'log' });
  }

  // 1. Check raw log entries by structured data (most reliable for money sends)
  const matched: { text: string; amount: number; timestamp: number; source: string }[] = [];
  const moneyLogEntries: { title: string; data: any; timestamp: number }[] = [];

  for (const entry of allLogEntries) {
    const title = String(entry.title || entry.log || '').toLowerCase();
    const data = entry.data || {};

    // Detect money-related log entries by title keywords or data fields
    const hasMoney = data.money || data.amount || data.cost || data.value;
    const isMoneySend = title.includes('send') || title.includes('sent') || title.includes('money')
      || title.includes('trade') || title.includes('transfer') || title.includes('pay');

    if (hasMoney || isMoneySend) {
      moneyLogEntries.push({ title: entry.title || entry.log || '', data, timestamp: entry.timestamp || 0 });

      // Check if recipient matches — by receiver ID in data, or name in text
      const receiverId = String(data.receiver || data.player_id || '');
      const mentionsRecipient =
        (receiverId && receiverId === recipientTornId) ||
        (recipientName && JSON.stringify(data).toLowerCase().includes(recipientName.toLowerCase())) ||
        (recipientName && title.includes(recipientName.toLowerCase()));

      if (mentionsRecipient) {
        const amount = Number(data.money || data.amount || data.cost || data.value || 0);
        if (amount > 0) {
          matched.push({
            text: `${entry.title || ''} ${JSON.stringify(data)}`.substring(0, 200),
            amount,
            timestamp: entry.timestamp || 0,
            source: 'log',
          });
        }
      }
    }
  }

  // 2. Also check event text (plain text format: "You sent $X to PlayerName")
  const moneyEventEntries: { text: string; timestamp: number; source: string }[] = [];
  for (const entry of allEntries) {
    if (entry.source !== 'event') continue;
    const evtLower = entry.text.toLowerCase();

    const hasMoney = evtLower.includes('$');
    const hasSendVerb = evtLower.includes('sent') || evtLower.includes('send')
      || evtLower.includes('transfer') || evtLower.includes('paid')
      || evtLower.includes('trade') || evtLower.includes('traded');

    if (!hasMoney || !hasSendVerb) continue;

    moneyEventEntries.push({ text: entry.text.substring(0, 200), timestamp: entry.timestamp, source: 'event' });

    const mentionsRecipient =
      (recipientName && evtLower.includes(recipientName.toLowerCase())) ||
      (recipientName && recipientName.toLowerCase() === 'girovagabondo' && evtLower.includes('giro')) ||
      entry.raw.includes(recipientTornId);

    if (!mentionsRecipient) continue;

    const amountMatch = entry.text.match(/\$([0-9,]+)/);
    if (!amountMatch) continue;

    const eventAmount = Number(amountMatch[1].replace(/,/g, ''));
    matched.push({ text: entry.text.substring(0, 200), amount: eventAmount, timestamp: entry.timestamp, source: 'event' });
  }

  // Sample log entries (to debug structured format)
  const sampleLogEntries = allLogEntries.slice(0, 5).map((e: any) => ({
    title: String(e.title || e.log || '').substring(0, 100),
    data: e.data ? JSON.stringify(e.data).substring(0, 200) : null,
    timestamp: e.timestamp || 0,
  }));

  return json({
    player: `${playerName} [${tornId}]`,
    recipient: recipientName || `ID:${recipientTornId}`,
    total_entries: allEntries.length,
    events_count: evtCount,
    log_count: logCount,
    pages_scanned: pagesScanned,
    matched_payments: matched,
    total_matched: matched.reduce((sum, m) => sum + m.amount, 0),
    money_event_entries: moneyEventEntries,
    money_log_entries: moneyLogEntries.slice(0, 20).map(e => ({ title: e.title, data: JSON.stringify(e.data).substring(0, 200), timestamp: e.timestamp })),
    sample_log_entries: sampleLogEntries,
    sample_entries: allEntries.filter(e => e.source === 'event').slice(0, 5).map(e => ({ text: e.text.substring(0, 150), source: e.source, timestamp: e.timestamp })),
  });
}

async function handleAdminSyncAllClients(req: Request) {
  const user = await requireAuth(req);
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const supabase = serviceClient();

  // Get all distinct torn_ids from transactions
  const { data: txns, error } = await supabase
    .from('transactions')
    .select('torn_id, torn_name, torn_faction, torn_level');

  if (error) return json({ error: error.message }, 500);

  // Dedupe by torn_id, keeping latest info
  const clientMap = new Map<string, any>();
  for (const t of (txns || [])) {
    if (!t.torn_id) continue;
    if (!clientMap.has(t.torn_id) || (t.torn_name && t.torn_name !== 'null')) {
      clientMap.set(t.torn_id, t);
    }
  }

  let synced = 0;
  for (const [tornId, info] of clientMap) {
    await syncClientStats(supabase, tornId, {
      torn_name: info.torn_name || undefined,
      torn_faction: info.torn_faction || undefined,
      torn_level: info.torn_level || undefined,
    });
    synced++;
  }

  console.log(`[admin-sync-all-clients] Synced ${synced} clients`);
  return json({ success: true, synced });
}

// ── Test email (admin-only diagnostic) ───────────────────────────────

async function handleTestEmail(req: Request) {
  const user = await requireAuth(req);
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const envStatus = {
    SMTP_HOST: Deno.env.get('SMTP_HOST') ? `set (${Deno.env.get('SMTP_HOST')})` : 'MISSING',
    SMTP_USER: Deno.env.get('SMTP_USER') ? `set (${Deno.env.get('SMTP_USER')})` : 'MISSING',
    SMTP_PASS: Deno.env.get('SMTP_PASS') ? 'set (hidden)' : 'MISSING',
    SMTP_PORT: Deno.env.get('SMTP_PORT') || '465',
    NOTIFY_EMAIL: Deno.env.get('NOTIFY_EMAIL') ? `set (${Deno.env.get('NOTIFY_EMAIL')})` : 'MISSING',
  };

  try {
    await sendNotificationEmail(
      'Happy Jump — Test Email',
      'This is a test email from the Happy Jump gateway.\n\nIf you see this, email notifications are working!\n\nThis uses the same sendNotificationEmail() function as all other notifications.',
    );
    return json({ success: true, message: 'Test email sent', envStatus });
  } catch (e) {
    return json({ error: `SMTP send failed: ${e?.message || e}`, envStatus }, 500);
  }
}

// ── Public stats ─────────────────────────────────────────────────────

async function handleGetPublicStats() {
  const sb = serviceClient();

  // Count total insured jumps (all non-rejected transactions that made it past requested)
  const { count: totalJumps, error: jumpErr } = await sb
    .from('transactions')
    .select('*', { count: 'exact', head: true })
    .in('status', ['purchased', 'closed_clean', 'od_xanax', 'od_ecstasy', 'payout_sent']);

  // Sum total paid out
  const { data: payoutRows, error: payErr } = await sb
    .from('transactions')
    .select('payout_amount')
    .eq('status', 'payout_sent');

  // Count distinct torn_ids for unique customers
  const { data: distinctCustomers, error: distErr } = await sb
    .from('transactions')
    .select('torn_id')
    .in('status', ['purchased', 'closed_clean', 'od_xanax', 'od_ecstasy', 'payout_sent']);

  if (jumpErr || payErr || distErr) {
    return json({ error: 'Failed to fetch stats' }, 500);
  }

  const uniqueIds = new Set((distinctCustomers || []).map((r: any) => r.torn_id));

  const totalPaidOut = (payoutRows || []).reduce(
    (sum: number, r: any) => sum + Number(r.payout_amount || 0), 0
  );

  // Determine best seller by product_type count
  const { data: productRows } = await sb
    .from('transactions')
    .select('product_type')
    .in('status', ['purchased', 'closed_clean', 'od_xanax', 'od_ecstasy', 'payout_sent']);

  const productCounts: Record<string, number> = {};
  for (const r of (productRows || [])) {
    const pt = r.product_type || 'package';
    productCounts[pt] = (productCounts[pt] || 0) + 1;
  }
  let bestSeller = null;
  let bestCount = 0;
  for (const [pt, count] of Object.entries(productCounts)) {
    if (count > bestCount) {
      bestCount = count;
      bestSeller = pt;
    }
  }

  return json({
    happy_customers: uniqueIds.size,
    total_jumps: totalJumps || 0,
    total_paid_out: totalPaidOut,
    best_seller: bestSeller,
  });
}
async function handleTestApiAccess(body: any) {
  const { api_key } = body;
  if (!api_key) return json({ error: 'Missing api_key' }, 400);

  const results: Record<string, { ok: boolean; detail: string }> = {};

  // Test basic,profile access
  const basicRes = await fetch(`${TORN_API}/user/?selections=basic,profile&key=${api_key}`);
  const basicData = await basicRes.json();
  if (basicData.error) {
    results.basic = { ok: false, detail: basicData.error.error || 'Unknown error' };
  } else {
    results.basic = { ok: true, detail: `${basicData.name} [${basicData.player_id}]` };
  }

  // Test events access (needed for OD reporting)
  const eventsRes = await fetch(`${TORN_API}/user/?selections=events&limit=1&key=${api_key}`);
  const eventsData = await eventsRes.json();
  if (eventsData.error) {
    results.events = { ok: false, detail: eventsData.error.error || 'Unknown error' };
  } else {
    results.events = { ok: true, detail: 'Events access confirmed' };
  }

  // Test log access (needed for payment verification)
  const logRes = await fetch(`${TORN_API}/user/?selections=log&limit=1&key=${api_key}`);
  const logData = await logRes.json();
  if (logData.error) {
    results.log = { ok: false, detail: logData.error.error || 'Unknown error' };
  } else {
    results.log = { ok: true, detail: 'Log access confirmed' };
  }

  const allOk = results.basic.ok && results.events.ok && results.log.ok;
  return json({ ok: allOk, results });
}

async function handleAdminCheckEcstasy(body: any) {
  const { api_key } = body;
  if (!api_key) return json({ error: 'Missing api_key' }, 400);

  // Get player identity
  const identRes = await fetch(`${TORN_API}/user/?selections=basic,profile&key=${api_key}`);
  const identData = await identRes.json();
  if (identData.error) return json({ error: `Torn API: ${identData.error.error}` }, 400);

  const tornId = String(identData.player_id);
  const playerName = identData.name || tornId;
  const stripHtml = (s: any) => String(s || '').replace(/<[^>]*>/g, '');

  // Fetch events (single call) and log (paginated — active players have 100s of market entries).
  const eventsRes = await fetch(`${TORN_API}/user/?selections=events&key=${api_key}`);
  const eventsData = await eventsRes.json();

  // Paginate log: fetch batches of 100 using 'to' parameter, up to 7 days back or 10 pages
  const allLogEntries: any[] = [];
  const sevenDaysAgo = Math.floor((Date.now() - 7 * 86400_000) / 1000);
  let toParam = '';
  let sampleLogEntry: any = null;
  let pagesScanned = 0;

  for (let page = 0; page < 10; page++) {
    const logUrl = `${TORN_API}/user/?selections=log${toParam}&key=${api_key}`;
    const logRes = await fetch(logUrl);
    const logData = await logRes.json();
    if (logData.error || !logData.log) break;

    const entries = Object.values(logData.log) as any[];
    if (entries.length === 0) break;

    if (page === 0 && entries.length > 0) sampleLogEntry = entries[0];
    allLogEntries.push(...entries);
    pagesScanned = page + 1;

    // Find oldest timestamp in this batch to paginate further back
    const oldestTs = Math.min(...entries.map((e: any) => e.timestamp || Infinity));
    if (oldestTs <= sevenDaysAgo) break; // gone back far enough
    if (entries.length < 100) break; // no more pages

    toParam = `&to=${oldestTs - 1}`; // next page: before this batch's oldest
  }

  const evtCount = eventsData.events ? Object.keys(eventsData.events).length : 0;
  const logCount = allLogEntries.length;

  // Combine events and log entries into one list
  const allEntries: { timestamp: number; text: string; source: string }[] = [];
  if (eventsData.events) {
    for (const evt of Object.values(eventsData.events) as any[]) {
      allEntries.push({ timestamp: evt.timestamp, text: stripHtml(evt.event || ''), source: 'event' });
    }
  }
  for (const entry of allLogEntries) {
    const textParts = [entry.title || '', entry.data ? JSON.stringify(entry.data) : ''];
    allEntries.push({ timestamp: entry.timestamp, text: textParts.join(' '), source: 'log' });
  }

  const ecstasyEvents: { type: string; timestamp: number; text: string; source: string }[] = [];
  const debugEcstasyMentions: string[] = [];

  // Also scan log entries by structured item ID (most reliable)
  for (const entry of allLogEntries) {
    if (entry.data?.item === ECSTASY_ITEM_ID && entry.title?.toLowerCase().includes('item use')) {
      const text = `${entry.title} ecstasy ${JSON.stringify(entry.data)}`;
      ecstasyEvents.push({ type: 'used', timestamp: entry.timestamp, text, source: 'log' });
      debugEcstasyMentions.push(`[log:${entry.timestamp}] ${text}`);
    }
  }

  // Text-based fallback scan across all entries
  for (const entry of allEntries) {
    const entryLower = entry.text.toLowerCase();
    if (entryLower.includes('ecstasy')) {
      debugEcstasyMentions.push(`[${entry.source}:${entry.timestamp}] ${entry.text}`);
    }
    if (entryLower.includes('ecstasy') && entryLower.includes('happ') && !entryLower.includes('overdos')) {
      // Avoid duplicates from item ID check
      if (!ecstasyEvents.some(e => e.timestamp === entry.timestamp && e.type === 'used')) {
        ecstasyEvents.push({ type: 'used', timestamp: entry.timestamp, text: entry.text, source: entry.source });
      }
    } else if (entryLower.includes('overdos') && entryLower.includes('ecstasy')) {
      ecstasyEvents.push({ type: 'od', timestamp: entry.timestamp, text: entry.text, source: entry.source });
    }
  }

  // Sort chronologically
  ecstasyEvents.sort((a, b) => a.timestamp - b.timestamp);

  return json({
    player: `${playerName} [${tornId}]`,
    ecstasy_events: ecstasyEvents,
    has_usage: ecstasyEvents.some((e) => e.type === 'used'),
    has_od: ecstasyEvents.some((e) => e.type === 'od'),
    debug: {
      total_combined: allEntries.length,
      events_count: evtCount,
      log_count: logCount,
      log_pages_scanned: pagesScanned,
      sample_log_entry: sampleLogEntry,
      ecstasy_mentions: debugEcstasyMentions,
    },
  });
}

// ── Faction Events ───────────────────────────────────────────────────
// Self-contained leaderboard feature: count item-use log entries (e.g.
// Beer / Cannabis) per participant inside a bounded window. Lives next
// to the Happy Jump pipeline but does NOT touch transactions/clients.

function parseFactionEventTimestamp(s: any, label: string): { ts: Date | null; err: string | null } {
  if (typeof s !== 'string' || !s) return { ts: null, err: `Missing ${label}` };
  const d = new Date(s);
  if (isNaN(d.getTime())) return { ts: null, err: `Invalid ${label}` };
  return { ts: d, err: null };
}

async function handleCreateFactionEvent(body: any) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const event_type = body.event_type === 'attacks' ? 'attacks' : 'drug_use';
  const drug_item_id = Number(body.drug_item_id);
  const drug_name = typeof body.drug_name === 'string' ? body.drug_name.trim() : '';

  if (!title) return json({ error: 'Title is required' }, 400);
  if (title.length > 120) return json({ error: 'Title too long' }, 400);
  // Drug fields are only meaningful for drug_use events.
  if (event_type === 'drug_use') {
    if (!Number.isFinite(drug_item_id) || drug_item_id <= 0) {
      return json({ error: 'drug_item_id must be a positive integer' }, 400);
    }
    if (!drug_name) return json({ error: 'drug_name is required' }, 400);
    if (drug_name.length > 60) return json({ error: 'drug_name too long' }, 400);
  }

  const startsParsed = parseFactionEventTimestamp(body.starts_at, 'starts_at');
  if (startsParsed.err) return json({ error: startsParsed.err }, 400);
  const endsParsed = parseFactionEventTimestamp(body.ends_at, 'ends_at');
  if (endsParsed.err) return json({ error: endsParsed.err }, 400);

  const starts_at = startsParsed.ts!;
  const ends_at = endsParsed.ts!;
  if (ends_at.getTime() <= starts_at.getTime()) {
    return json({ error: 'ends_at must be after starts_at' }, 400);
  }
  // Cap duration at 30 days to keep log scans bounded.
  const MAX_MS = 30 * 24 * 60 * 60 * 1000;
  if (ends_at.getTime() - starts_at.getTime() > MAX_MS) {
    return json({ error: 'Event window cannot exceed 30 days' }, 400);
  }

  // personal_start_at is OPTIONAL on create — if the creator doesn't
  // supply one, default to the event start. Each participant (including
  // the creator) can change their own start time later via the me-card
  // "Change my start time" UI; pre-baking it into the create flow makes
  // the create form longer than it needs to be and conflates two
  // independent decisions (when does the event run vs. when do I start
  // counting).
  let personalStart: Date;
  if (body.personal_start_at !== undefined && body.personal_start_at !== null && body.personal_start_at !== '') {
    const personalParsed = parseFactionEventTimestamp(body.personal_start_at, 'personal_start_at');
    if (personalParsed.err) return json({ error: personalParsed.err }, 400);
    personalStart = personalParsed.ts!;
  } else {
    personalStart = starts_at;
  }

  // Creating an event requires a Faction Event session — we need a stable
  // creator_torn_id for later edit authorization, and we need the creator's
  // own API key to seed their initial participant row. Direct `{ key: ... }`
  // bodies are NOT honored here: there is no session row to anchor the
  // creator on, so creator-only edits would never work afterward.
  if (!body.player_id || !body.session_token) {
    return json({ error: 'Sign in required to create an event' }, 401);
  }
  const resolved = await resolveFactionEventApiKey(body);
  if (resolved instanceof Response) return resolved;
  const api_key = resolved.key;
  const creatorTornId = String(resolved.torn_id || '');
  if (!creatorTornId) return json({ error: 'Sign in required to create an event' }, 401);

  const supabase = serviceClient();

  // Re-validate the key + grab creator identity (name / faction) for the
  // initial participant row. This also doubles as a freshness check —
  // a key revoked since auto-login is detected and cleaned up here.
  const identRes = await fetch(`${TORN_API}/user/?selections=basic,profile&key=${api_key}`);
  const identData = await identRes.json();
  if (identData.error) {
    if (isPermanentTornKeyError(identData.error.code)) {
      await cascadeDeleteFactionEventSecret(supabase, creatorTornId);
    }
    return json({ error: `Torn API: ${identData.error.error}` }, 400);
  }

  // Defence-in-depth: identity from Torn must match the session torn_id.
  if (String(identData.player_id) !== creatorTornId) {
    return json({ error: 'Session identity mismatch' }, 401);
  }

  const creatorTornName = String(identData.name || '');
  const creatorTornFaction = identData.faction?.faction_name ? String(identData.faction.faction_name) : null;
  const creatorFactionIdRaw = Number(identData.faction?.faction_id);
  const creatorFactionId =
    Number.isFinite(creatorFactionIdRaw) && creatorFactionIdRaw > 0 ? creatorFactionIdRaw : null;

  // Refresh the creator's cached identity on the secret row — we just
  // re-validated against Torn so this is the freshest data we have, and
  // we're about to use the same lookup (torn_faction_id) to find faction-
  // mates. Keeps name/faction in sync without waiting for the next
  // fe-auto-login round-trip.
  await supabase
    .from('faction_event_player_secrets')
    .update({
      torn_name: creatorTornName || null,
      torn_faction_id: creatorFactionId,
      torn_faction_name: creatorTornFaction,
    })
    .eq('torn_player_id', Number(creatorTornId));

  // Floor the creator's personal start to event_start (you can't begin
  // counting before the event has started). No upper clamp: each
  // drug_use participant's count window is [personal_start,
  // personal_start + duration], so a late personal_start just shifts
  // the whole window later — it doesn't get truncated by event.ends_at.
  //
  // Attack events ignore personal_start_at entirely (everyone shares
  // event.starts_at → event.ends_at), so we just nail it to event_start
  // for those rows. The column is still NOT NULL.
  const clampedStartMs = event_type === 'attacks'
    ? starts_at.getTime()
    : Math.max(personalStart.getTime(), starts_at.getTime());
  const clampedStartIso = new Date(clampedStartMs).toISOString();

  // Initial count for the creator over their personal duration window.
  const { fromSec, untilSec } = participantCountWindow(
    { event_type, starts_at: starts_at.toISOString(), ends_at: ends_at.toISOString() },
    clampedStartIso,
  );
  const seedEventShape = {
    event_type,
    drug_item_id: event_type === 'drug_use' ? drug_item_id : null,
    drug_name: event_type === 'drug_use' ? drug_name : null,
  };
  const seedScan = await runEventScanner(
    api_key,
    seedEventShape,
    creatorTornId,
    fromSec,
    untilSec,
  );
  if (event_type === 'attacks' && seedScan.skipReason === 'scope_error') {
    return json({
      error: "Your API key doesn't have Attacks access. Re-sign in with a Custom Key that includes the 'attacks' scope, then try again.",
      torn_error_code: 16,
    }, 400);
  }
  const creatorCount = seedScan.count;

  // Insert event first.
  const { data: eventRow, error: evtErr } = await supabase
    .from('faction_events')
    .insert({
      title,
      event_type,
      drug_item_id: event_type === 'drug_use' ? drug_item_id : null,
      drug_name: event_type === 'drug_use' ? drug_name : null,
      starts_at: starts_at.toISOString(),
      ends_at: ends_at.toISOString(),
      creator_torn_id: creatorTornId,
    })
    .select()
    .single();

  if (evtErr) return json({ error: evtErr.message }, 500);

  // Then insert the creator's participant row. If this fails, roll back the
  // event so we never end up with an orphan event the creator can't edit.
  const checkedAt = new Date().toISOString();
  const { data: participantRow, error: partErr } = await supabase
    .from('faction_event_participants')
    .insert({
      event_id: eventRow.id,
      torn_id: creatorTornId,
      torn_name: creatorTornName,
      torn_faction: creatorTornFaction,
      personal_start_at: clampedStartIso,
      last_count: creatorCount,
      last_respect_total: seedScan.respect_total,
      last_best_single_respect: seedScan.best_single_respect,
      last_checked_at: checkedAt,
      last_diag_json: seedScan.diag,
    })
    .select()
    .single();

  if (partErr) {
    await supabase.from('faction_events').delete().eq('id', eventRow.id);
    return json({ error: `Failed to seed creator participant: ${partErr.message}` }, 500);
  }

  // Auto-add every other player whose stored FE session puts them in
  // one of the faction(s) the creator chose to seed from. Defaults to
  // just the creator's own faction (legacy behaviour) when the client
  // doesn't supply `auto_seed_faction_ids`. Caller can pass a list of
  // Torn faction_ids to invite multiple factions at once (cross-faction
  // events). Saves the creator from asking each faction-mate to log in
  // and join manually. The self-healing leaderboard sweep
  // (refresh-stale-participants) picks these rows up on the next
  // event-view load and runs the count using their server-stored key —
  // no creator-side scraping here.
  //
  // Skipped silently when the selected faction list is empty, when no
  // torn_name has been cached for a member (rows from before migration
  // 015), or when an insert collides with an existing row.
  const requestedFactionIds = Array.isArray(body.auto_seed_faction_ids)
    ? body.auto_seed_faction_ids
        .map((v: any) => Number(v))
        .filter((n: number) => Number.isFinite(n) && n > 0)
    : null;
  const autoSeedFactionIds =
    requestedFactionIds !== null
      ? requestedFactionIds
      : (creatorFactionId ? [creatorFactionId] : []);

  let autoAdded = 0;
  if (autoSeedFactionIds.length > 0) {
    const { data: factionMates = [] } = await supabase
      .from('faction_event_player_secrets')
      .select('torn_player_id, torn_name, torn_faction_name')
      .in('torn_faction_id', autoSeedFactionIds)
      .neq('torn_player_id', Number(creatorTornId));

    const seedRows = (factionMates || [])
      .filter((m: any) => m.torn_name)
      .map((m: any) => ({
        event_id: eventRow.id,
        torn_id: String(m.torn_player_id),
        torn_name: m.torn_name,
        torn_faction: m.torn_faction_name || creatorTornFaction,
        personal_start_at: starts_at.toISOString(),
        last_count: 0,
        // last_checked_at left NULL so refresh-stale-participants picks
        // these rows first (NULL-first ordering) on the next view load
        // and runs the count using the member's stored key.
        last_checked_at: null,
      }));

    if (seedRows.length > 0) {
      const { data: inserted, error: seedErr } = await supabase
        .from('faction_event_participants')
        .insert(seedRows)
        .select('id');
      if (seedErr) {
        // Don't fail the create — the event + creator row already exist
        // and the operator can use the per-row remove button to clean
        // up any partial seeding. Just log it.
        console.log(`[create-faction-event] auto-seed failed for event=${eventRow.id}: ${seedErr.message}`);
      } else {
        autoAdded = (inserted || []).length;
      }
    }
  }

  return json({ event: eventRow, participant: participantRow, auto_added: autoAdded });
}

async function handleGetFactionEvent(body: any) {
  const event_id = typeof body.event_id === 'string' ? body.event_id : '';
  if (!event_id) return json({ error: 'Missing event_id' }, 400);

  const supabase = serviceClient();
  const { data: event, error: evtErr } = await supabase
    .from('faction_events')
    .select('*')
    .eq('id', event_id)
    .maybeSingle();

  if (evtErr) return json({ error: evtErr.message }, 500);
  if (!event) return json({ error: 'Event not found' }, 404);

  // For attack events, default sort is total respect gained (most
  // cross-level-fair metric). The client can re-sort by column locally
  // but the initial server order matches what the leaderboard highlights.
  const eventType = event.event_type === 'attacks' ? 'attacks' : 'drug_use';
  const orderColumn = eventType === 'attacks' ? 'last_respect_total' : 'last_count';

  const { data: participants, error: partErr } = await supabase
    .from('faction_event_participants')
    .select('id, torn_id, torn_name, torn_faction, personal_start_at, last_count, last_respect_total, last_best_single_respect, last_checked_at, created_at, scrape_status')
    .eq('event_id', event_id)
    .order(orderColumn, { ascending: false, nullsFirst: false });

  if (partErr) return json({ error: partErr.message }, 500);

  return json({ event, participants: participants || [] });
}

// Visibility rules:
//   1. HJ admin (Supabase Auth) — sees every event.
//   2. FE-signed-in user — sees only events they created OR have a
//      participant row in.
//   3. Anonymous — empty list (events are not browseable without identity).
// Distinct factions among FE-signed-in users, with member counts.
// Drives the create-event "Auto-seed factions" checkbox list.
// Marks the calling user's faction with mine=true (defaults to first
// in the sort) when an FE session is supplied; otherwise no flag.
async function handleListFeFactions(body: any) {
  const supabase = serviceClient();

  let myFactionId: number | null = null;
  if (body && body.player_id && body.session_token) {
    const resolved = await resolveFactionEventApiKey(body);
    if (!(resolved instanceof Response) && resolved.torn_id) {
      const { data: secret } = await supabase
        .from('faction_event_player_secrets')
        .select('torn_faction_id')
        .eq('torn_player_id', Number(resolved.torn_id))
        .maybeSingle();
      if (secret?.torn_faction_id) myFactionId = Number(secret.torn_faction_id);
    }
  }

  const { data: rows = [], error } = await supabase
    .from('faction_event_player_secrets')
    .select('torn_faction_id, torn_faction_name')
    .not('torn_faction_id', 'is', null)
    .not('torn_faction_name', 'is', null);
  if (error) return json({ error: error.message }, 500);

  const factionMap = new Map<number, {
    torn_faction_id: number;
    torn_faction_name: string;
    member_count: number;
    mine: boolean;
  }>();
  for (const r of rows || []) {
    const id = Number((r as any).torn_faction_id);
    if (!Number.isFinite(id) || id <= 0) continue;
    const existing = factionMap.get(id);
    if (existing) existing.member_count++;
    else
      factionMap.set(id, {
        torn_faction_id: id,
        torn_faction_name: String((r as any).torn_faction_name),
        member_count: 1,
        mine: id === myFactionId,
      });
  }

  // Sort: caller's faction first, then by member_count desc, then by name.
  const factions = Array.from(factionMap.values()).sort((a, b) => {
    if (a.mine && !b.mine) return -1;
    if (!a.mine && b.mine) return 1;
    if (b.member_count !== a.member_count) return b.member_count - a.member_count;
    return a.torn_faction_name.localeCompare(b.torn_faction_name);
  });

  return json({ factions });
}

async function handleListFactionEvents(req: Request, body: any) {
  const supabase = serviceClient();
  const baseSelect = 'id, title, event_type, drug_name, drug_item_id, starts_at, ends_at, created_at, creator_torn_id';

  const adminUser = await requireAuth(req);
  if (adminUser) {
    const { data, error } = await supabase
      .from('faction_events')
      .select(baseSelect)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) return json({ error: error.message }, 500);
    return json({ events: data || [], scope: 'admin' });
  }

  const hasCreds = !!(body && (body.key || body.api_key || (body.player_id && body.session_token)));
  if (!hasCreds) {
    return json({ events: [], scope: 'anonymous' });
  }

  const resolved = await resolveFactionEventApiKey(body);
  if (resolved instanceof Response) return resolved;
  const tornId = String(resolved.torn_id || '');
  if (!tornId) {
    // Direct-key path can't be tied to a creator/participant — return empty.
    return json({ events: [], scope: 'anonymous' });
  }

  const { data: partRows, error: partErr } = await supabase
    .from('faction_event_participants')
    .select('event_id')
    .eq('torn_id', tornId);
  if (partErr) return json({ error: partErr.message }, 500);
  const partEventIds = Array.from(new Set((partRows || []).map((r: any) => r.event_id))).filter(Boolean);

  let query = supabase
    .from('faction_events')
    .select(baseSelect)
    .order('created_at', { ascending: false })
    .limit(20);

  if (partEventIds.length > 0) {
    query = query.or(`creator_torn_id.eq.${tornId},id.in.(${partEventIds.join(',')})`);
  } else {
    query = query.eq('creator_torn_id', tornId);
  }

  const { data, error } = await query;
  if (error) return json({ error: error.message }, 500);
  return json({ events: data || [], scope: 'user' });
}

// Creator-only patch of an event's title / drug / window. Authorized via
// a Faction Event session (resolveFactionEventApiKey) that resolves to the
// same torn_id stored in event.creator_torn_id. If the drug or window
// changes, every participant row is invalidated (last_checked_at = NULL)
// so the next sweep recounts. Personal-start times that now fall outside
// the new window are clamped back inside it.
// Two paths to authorize a delete:
//   1. FE session whose torn_id matches event.creator_torn_id (the
//      normal "I made this event, I can delete it" path).
//   2. Happy Jump admin via Supabase Auth (the operator backdoor — lets
//      Giro clean up any event regardless of creator).
// Participant rows are removed automatically by the ON DELETE CASCADE
// on faction_event_participants.event_id (migration 011 line 25).
async function handleDeleteFactionEvent(req: Request, body: any) {
  const event_id = typeof body.event_id === 'string' ? body.event_id : '';
  if (!event_id) return json({ error: 'Missing event_id' }, 400);

  const supabase = serviceClient();
  const { data: event, error: evtErr } = await supabase
    .from('faction_events')
    .select('id, creator_torn_id, title')
    .eq('id', event_id)
    .maybeSingle();
  if (evtErr) return json({ error: evtErr.message }, 500);
  if (!event) return json({ error: 'Event not found' }, 404);

  // Admin backdoor first — if a valid Supabase Auth session is on the
  // request, the caller is the HJ operator and gets unconditional
  // delete. requireAuth returns null for unauthenticated requests, so
  // this is safe to try without an FE session.
  const adminUser = await requireAuth(req);
  let authorizedBy: string;

  if (adminUser) {
    authorizedBy = `admin:${adminUser.id}`;
  } else {
    // Fall back to FE creator auth.
    const resolved = await resolveFactionEventApiKey(body);
    if (resolved instanceof Response) return resolved;
    const callerTornId = String(resolved.torn_id || '');
    if (!callerTornId) return json({ error: 'Sign in required' }, 401);
    if (!event.creator_torn_id || String(event.creator_torn_id) !== callerTornId) {
      return json({ error: 'Only the event creator (or the operator) can delete this event' }, 403);
    }
    authorizedBy = `creator:${callerTornId}`;
  }

  const { error: delErr } = await supabase
    .from('faction_events')
    .delete()
    .eq('id', event_id);
  if (delErr) return json({ error: delErr.message }, 500);

  console.log(`[delete-faction-event] event=${event_id} title=${JSON.stringify(event.title)} authorizedBy=${authorizedBy}`);
  return json({ success: true, deleted_event_id: event_id });
}

// Remove a single participant row from a faction event. Authorized by:
//   1. FE session whose torn_id matches event.creator_torn_id (the
//      "I run this event, kick this person out" path), or
//   2. HJ admin via Supabase Auth (operator backdoor).
// Does NOT touch the participant's secret row — they keep their FE
// session and can re-join the event manually if they want, and they'll
// still get auto-added to *future* events the creator makes.
async function handleRemoveFactionEventParticipant(req: Request, body: any) {
  const event_id = typeof body.event_id === 'string' ? body.event_id : '';
  const torn_id = typeof body.torn_id === 'string' ? body.torn_id : '';
  if (!event_id || !torn_id) return json({ error: 'Missing event_id or torn_id' }, 400);

  const supabase = serviceClient();
  const { data: event, error: evtErr } = await supabase
    .from('faction_events')
    .select('id, creator_torn_id, title')
    .eq('id', event_id)
    .maybeSingle();
  if (evtErr) return json({ error: evtErr.message }, 500);
  if (!event) return json({ error: 'Event not found' }, 404);

  const adminUser = await requireAuth(req);
  let authorizedBy: string;

  if (adminUser) {
    authorizedBy = `admin:${adminUser.id}`;
  } else {
    const resolved = await resolveFactionEventApiKey(body);
    if (resolved instanceof Response) return resolved;
    const callerTornId = String(resolved.torn_id || '');
    if (!callerTornId) return json({ error: 'Sign in required' }, 401);
    if (!event.creator_torn_id || String(event.creator_torn_id) !== callerTornId) {
      return json({ error: 'Only the event creator (or the operator) can remove participants' }, 403);
    }
    authorizedBy = `creator:${callerTornId}`;
  }

  const { error: delErr } = await supabase
    .from('faction_event_participants')
    .delete()
    .eq('event_id', event_id)
    .eq('torn_id', torn_id);
  if (delErr) return json({ error: delErr.message }, 500);

  console.log(`[remove-faction-event-participant] event=${event_id} torn_id=${torn_id} authorizedBy=${authorizedBy}`);
  return json({ success: true });
}

async function handleUpdateFactionEvent(req: Request, body: any) {
  const event_id = typeof body.event_id === 'string' ? body.event_id : '';
  if (!event_id) return json({ error: 'Missing event_id' }, 400);

  // Admin backdoor first — HJ operator gets unconditional edit access.
  // requireAuth returns null for unauthenticated requests, so this is
  // safe to try without an FE session. Falls back to FE creator auth.
  const adminUser = await requireAuth(req);

  const supabase = serviceClient();
  const { data: event, error: evtErr } = await supabase
    .from('faction_events')
    .select('*')
    .eq('id', event_id)
    .maybeSingle();
  if (evtErr) return json({ error: evtErr.message }, 500);
  if (!event) return json({ error: 'Event not found' }, 404);

  if (!adminUser) {
    const resolved = await resolveFactionEventApiKey(body);
    if (resolved instanceof Response) return resolved;
    const callerTornId = String(resolved.torn_id || '');
    if (!callerTornId) return json({ error: 'Sign in required' }, 401);
    if (!event.creator_torn_id || String(event.creator_torn_id) !== callerTornId) {
      return json({ error: 'Only the event creator (or the operator) can edit this event' }, 403);
    }
  }

  // Build the patch — only fields the caller actually supplied are touched.
  const patch: Record<string, unknown> = {};
  let drugChanged = false;
  let windowChanged = false;

  if (typeof body.title === 'string') {
    const title = body.title.trim();
    if (!title) return json({ error: 'Title cannot be empty' }, 400);
    if (title.length > 120) return json({ error: 'Title too long' }, 400);
    if (title !== event.title) patch.title = title;
  }

  if (body.drug_item_id !== undefined || typeof body.drug_name === 'string') {
    // Drug edits only apply to drug_use events. Reject silently with an
    // error for attacks events so the UI can't accidentally repaint with
    // a meaningless drug label.
    if (event.event_type === 'attacks') {
      return json({ error: 'Drug cannot be changed on an attacks event' }, 400);
    }
    const drug_item_id = Number(body.drug_item_id ?? event.drug_item_id);
    const drug_name = typeof body.drug_name === 'string' ? body.drug_name.trim() : event.drug_name;
    if (!Number.isFinite(drug_item_id) || drug_item_id <= 0) {
      return json({ error: 'drug_item_id must be a positive integer' }, 400);
    }
    if (!drug_name) return json({ error: 'drug_name is required' }, 400);
    if (drug_name.length > 60) return json({ error: 'drug_name too long' }, 400);
    if (drug_item_id !== Number(event.drug_item_id) || drug_name !== event.drug_name) {
      patch.drug_item_id = drug_item_id;
      patch.drug_name = drug_name;
      drugChanged = true;
    }
  }

  let newStartsAt = new Date(event.starts_at);
  let newEndsAt = new Date(event.ends_at);
  if (typeof body.starts_at === 'string') {
    const p = parseFactionEventTimestamp(body.starts_at, 'starts_at');
    if (p.err) return json({ error: p.err }, 400);
    newStartsAt = p.ts!;
  }
  if (typeof body.ends_at === 'string') {
    const p = parseFactionEventTimestamp(body.ends_at, 'ends_at');
    if (p.err) return json({ error: p.err }, 400);
    newEndsAt = p.ts!;
  }
  if (newEndsAt.getTime() <= newStartsAt.getTime()) {
    return json({ error: 'ends_at must be after starts_at' }, 400);
  }
  const MAX_MS = 30 * 24 * 60 * 60 * 1000;
  if (newEndsAt.getTime() - newStartsAt.getTime() > MAX_MS) {
    return json({ error: 'Event window cannot exceed 30 days' }, 400);
  }
  if (newStartsAt.toISOString() !== new Date(event.starts_at).toISOString()) {
    patch.starts_at = newStartsAt.toISOString();
    windowChanged = true;
  }
  if (newEndsAt.toISOString() !== new Date(event.ends_at).toISOString()) {
    patch.ends_at = newEndsAt.toISOString();
    windowChanged = true;
  }

  if (Object.keys(patch).length === 0) {
    return json({ event });
  }

  const { data: updatedEvent, error: updErr } = await supabase
    .from('faction_events')
    .update(patch)
    .eq('id', event_id)
    .select()
    .single();
  if (updErr) return json({ error: updErr.message }, 500);

  // If the count parameters changed, invalidate every participant's count so
  // the next refresh-stale-participants sweep recounts. Also re-anchor
  // personal_start_at to the new event date — preserving each participant's
  // chosen TIME-OF-DAY so a date edit moves their start by exactly the
  // amount the event moved. Under the new "personal_start + duration"
  // model the upper bound is irrelevant — only the new event_start floor
  // matters (so a personal_start that ended up before event_start gets
  // snapped forward).
  if (drugChanged || windowChanged) {
    const startMs = newStartsAt.getTime();
    const { data: parts } = await supabase
      .from('faction_event_participants')
      .select('id, personal_start_at')
      .eq('event_id', event_id);

    if (parts && parts.length > 0) {
      // First, blanket-invalidate counts (drug + attack metrics both).
      await supabase
        .from('faction_event_participants')
        .update({
          last_checked_at: null,
          last_count: 0,
          last_respect_total: null,
          last_best_single_respect: null,
        })
        .eq('event_id', event_id);

      if (windowChanged) {
        if (event.event_type === 'attacks') {
          // Attack events use the global event window for everyone —
          // re-pin every participant's personal_start_at to the new
          // event start. No time-of-day preservation since each
          // participant doesn't have an individual slot here.
          await supabase
            .from('faction_event_participants')
            .update({ personal_start_at: newStartsAt.toISOString() })
            .eq('event_id', event_id);
        } else {
          // Drug events: re-anchor each participant's personal-start
          // time to the new event date, keeping the same UTC time-of-day.
          // Floor at the new event start (you can't begin counting before
          // the event has started); no upper bound — a late
          // personal_start just shifts the [personal_start,
          // personal_start + duration] window later, it's never
          // truncated by event.ends_at.
          const newDateStr = newStartsAt.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
          for (const p of parts) {
            const oldPs = new Date(p.personal_start_at);
            const oldTimeStr = oldPs.toISOString().slice(11); // "HH:MM:SS.sssZ"
            const reAnchoredMs = new Date(`${newDateStr}T${oldTimeStr}`).getTime();
            let finalMs: number;
            if (Number.isNaN(reAnchoredMs) || reAnchoredMs < startMs) {
              // Old time-of-day predates the new event start — snap to
              // event start so the participant still has a valid window.
              finalMs = startMs;
            } else {
              finalMs = reAnchoredMs;
            }
            if (finalMs !== oldPs.getTime()) {
              await supabase
                .from('faction_event_participants')
                .update({ personal_start_at: new Date(finalMs).toISOString() })
                .eq('id', p.id);
            }
          }
        }
      }
    }
  }

  return json({ event: updatedEvent, drug_changed: drugChanged, window_changed: windowChanged });
}

// Shape of the per-scrape diagnostic blob persisted in
// faction_event_participants.last_diag_json. Mirrors the response field
// returned to the calling user from `refresh-faction-event` so the
// modal-mode display can use one renderer for stored + fresh scrapes.
type ScrapeDiag = {
  // 'drug_use' (default for legacy rows) or 'attacks'. Determines which
  // optional fields are populated.
  kind?: 'drug_use' | 'attacks';
  from_sec: number;
  until_sec: number;
  window_seconds: number;
  pages?: number;
  total_entries?: number;
  in_window_total?: number;
  reached_cutoff?: boolean;
  debug?: string[];
  rejected_samples?: string[];
  interesting_rejections?: string[];
  log_type_histogram?: Array<{ key: string; count: number }>;
  data_item_histogram?: Array<{ key: string; count: number }>;
  matched?: string[];
  // Structured per-match list — plain {ts (unix sec), drug} pairs so the
  // simplified modal can render "YYYY-MM-DD HH:MM:SS — Cannabis" lines
  // without parsing the human-readable `matched` strings.
  matched_items?: Array<{ ts: number; drug: string }>;
  skipped_reason?: string;
  scraped_at?: string;
  drug_name?: string;
  drug_item_id?: number;
  // attacks-only fields
  attack_count?: number;
  respect_total?: number;
  best_single_respect?: number;
  records_scanned?: number;
  scope_error?: boolean;
  torn_error?: { code: number; message: string } | null;
};

// Run the right scanner for an event's type and return a normalized
// result plus a ScrapeDiag the caller can persist verbatim into
// faction_event_participants.last_diag_json. Centralizes the branching so
// every refresh/create/join path stays event-type agnostic.
async function runEventScanner(
  apiKey: string,
  event: { event_type?: string | null; drug_item_id?: number | null; drug_name?: string | null },
  myTornId: string | number,
  fromSec: number,
  untilSec: number,
): Promise<{
  count: number;
  respect_total: number | null;
  best_single_respect: number | null;
  diag: ScrapeDiag;
  // Set when the scanner couldn't compute a fresh result (e.g. the
  // participant's key lacks `attacks` scope). Callers should skip
  // overwriting last_count when this is non-null.
  skipReason: 'scope_error' | null;
}> {
  const kind = event.event_type === 'attacks' ? 'attacks' : 'drug_use';
  const window_seconds = Math.max(0, untilSec - fromSec);
  const scrapedAt = new Date().toISOString();

  if (untilSec <= fromSec) {
    return {
      count: 0,
      respect_total: kind === 'attacks' ? 0 : null,
      best_single_respect: kind === 'attacks' ? 0 : null,
      diag: {
        kind,
        from_sec: fromSec,
        until_sec: untilSec,
        window_seconds,
        scraped_at: scrapedAt,
        skipped_reason: `untilSec (${untilSec}) <= fromSec (${fromSec}) — count window is zero-length, scanner not called`,
        ...(kind === 'drug_use'
          ? { drug_name: String(event.drug_name || ''), drug_item_id: Number(event.drug_item_id || 0) }
          : {}),
      },
      skipReason: null,
    };
  }

  if (kind === 'attacks') {
    const myId = Number(myTornId);
    const r = await countAttacksInWindow(apiKey, myId, fromSec, untilSec);
    return {
      count: r.count,
      respect_total: r.respect_total,
      best_single_respect: r.best_single,
      diag: {
        kind: 'attacks',
        from_sec: fromSec,
        until_sec: untilSec,
        window_seconds,
        scraped_at: scrapedAt,
        pages: r.pages,
        records_scanned: r.totalRecords,
        reached_cutoff: r.reachedCutoff,
        attack_count: r.count,
        respect_total: r.respect_total,
        best_single_respect: r.best_single,
        debug: r.debug,
        scope_error: r.scopeError,
        torn_error: r.tornError,
      },
      skipReason: r.scopeError ? 'scope_error' : null,
    };
  }

  // drug_use
  const drugItemId = Number(event.drug_item_id);
  const drugName = String(event.drug_name || '');
  const result = await countItemUseInLog(apiKey, drugItemId, drugName, fromSec, untilSec);
  return {
    count: result.count,
    respect_total: null,
    best_single_respect: null,
    diag: { kind: 'drug_use', ...buildScrapeDiag(fromSec, untilSec, drugName, drugItemId, result) },
    skipReason: null,
  };
}

// Per-participant count window.
//
// For drug_use events, each participant gets the FULL event duration
// anchored to their own personal_start_at — so a late joiner (e.g.
// personal_start = event_start + 6h on a 48h event) still has the
// full 48h to use drugs, even if their window runs past event.ends_at.
//
// For attacks events, there is no per-participant personal window:
// everyone uses the global [event.starts_at, event.ends_at]. The
// personal_start_at column is still populated (NOT NULL), but is
// ignored here. The creator picks an exact start time on event
// creation (not a 10:00 TCT anchor + slot picker).
//
// Returns { fromSec, untilSec } where untilSec is capped at "now" so a
// future personal_end never counts entries that haven't happened yet.
// Callers still guard `if (untilSec > fromSec)` before scraping.
function participantCountWindow(
  event: { event_type?: string | null; starts_at: string; ends_at: string },
  personal_start_at: string,
): { fromSec: number; untilSec: number } {
  const nowSec = Math.floor(Date.now() / 1000);
  if (event.event_type === 'attacks') {
    return {
      fromSec: Math.floor(new Date(event.starts_at).getTime() / 1000),
      untilSec: Math.min(nowSec, Math.floor(new Date(event.ends_at).getTime() / 1000)),
    };
  }
  const durationMs =
    new Date(event.ends_at).getTime() - new Date(event.starts_at).getTime();
  const personalStartMs = new Date(personal_start_at).getTime();
  const personalEndMs = personalStartMs + durationMs;
  return {
    fromSec: Math.floor(personalStartMs / 1000),
    untilSec: Math.min(nowSec, Math.floor(personalEndMs / 1000)),
  };
}

// Build a ScrapeDiag from a countItemUseInLog result for a given window.
// `result` is null when the window was zero-length and the count function
// was skipped; in that case the diag carries `skipped_reason` instead of
// the count payload. Both shapes are persisted so a "skipped: zero-length
// window" snapshot is itself diagnostic.
function buildScrapeDiag(
  fromSec: number,
  untilSec: number,
  drugName: string,
  drugItemId: number,
  result: Awaited<ReturnType<typeof countItemUseInLog>> | null,
): ScrapeDiag {
  const diag: ScrapeDiag = {
    from_sec: fromSec,
    until_sec: untilSec,
    window_seconds: untilSec - fromSec,
    scraped_at: new Date().toISOString(),
    drug_name: drugName,
    drug_item_id: drugItemId,
  };
  if (result) {
    diag.pages = result.pages;
    diag.total_entries = result.totalEntries;
    diag.in_window_total = result.inWindowTotal;
    diag.reached_cutoff = result.reachedCutoff;
    diag.debug = result.debug;
    diag.rejected_samples = result.rejectedSamples;
    diag.interesting_rejections = result.interestingRejections;
    diag.log_type_histogram = result.logTypeHistogram;
    diag.data_item_histogram = result.dataItemHistogram;
    diag.matched = result.details;
    diag.matched_items = result.matchedItems;
  } else {
    diag.skipped_reason = `untilSec (${untilSec}) <= fromSec (${fromSec}) — count window is zero-length, count function not called`;
  }
  return diag;
}

// Validate the caller's API key, look up the event, run a bounded log scan,
// and either insert or update the participant row. Returns the updated row +
// fresh count so the client can render the leaderboard immediately.
async function handleJoinFactionEvent(body: any) {
  const event_id = typeof body.event_id === 'string' ? body.event_id : '';
  if (!event_id) return json({ error: 'Missing event_id' }, 400);

  const resolved = await resolveFactionEventApiKey(body);
  if (resolved instanceof Response) return resolved;
  const api_key = resolved.key;

  const supabase = serviceClient();
  const { data: event, error: evtErr } = await supabase
    .from('faction_events')
    .select('*')
    .eq('id', event_id)
    .maybeSingle();
  if (evtErr) return json({ error: evtErr.message }, 500);
  if (!event) return json({ error: 'Event not found' }, 404);

  const eventStartMs = new Date(event.starts_at).getTime();
  // Attack events ignore the per-participant personal start — everyone
  // shares the global [event.starts_at, event.ends_at] window — so we
  // hard-pin personal_start_at to event_start regardless of what the
  // client supplied. For drug events the personal start floors at
  // event_start (no upper clamp; late starts just shift the whole
  // count window later).
  let clampedStartMs: number;
  if (event.event_type === 'attacks') {
    clampedStartMs = eventStartMs;
  } else {
    const personalStartParsed = parseFactionEventTimestamp(body.personal_start_at, 'personal_start_at');
    if (personalStartParsed.err) return json({ error: personalStartParsed.err }, 400);
    clampedStartMs = Math.max(personalStartParsed.ts!.getTime(), eventStartMs);
  }
  const clampedStartIso = new Date(clampedStartMs).toISOString();

  // Validate the key + grab identity (name / faction)
  const identRes = await fetch(`${TORN_API}/user/?selections=basic,profile&key=${api_key}`);
  const identData = await identRes.json();
  if (identData.error) {
    if (resolved.torn_id && isPermanentTornKeyError(identData.error.code)) {
      await cascadeDeleteFactionEventSecret(supabase, resolved.torn_id);
    }
    return json({ error: `Torn API: ${identData.error.error}` }, 400);
  }

  const tornId = String(identData.player_id);
  const tornName = String(identData.name || '');
  const tornFaction = identData.faction?.faction_name ? String(identData.faction.faction_name) : null;

  // Run the count over [personal_start, min(now, personal_start + duration)].
  const { fromSec, untilSec } = participantCountWindow(event, clampedStartIso);
  const scan = await runEventScanner(api_key, event, tornId, fromSec, untilSec);
  if (scan.skipReason === 'scope_error') {
    return json({
      error: "Your API key doesn't have Attacks access. Re-sign in with a Custom Key that includes the 'attacks' scope, then try joining again.",
      torn_error_code: 16,
    }, 400);
  }

  const checkedAt = new Date().toISOString();

  // Upsert participant row (unique on event_id + torn_id)
  const { data: upserted, error: upsertErr } = await supabase
    .from('faction_event_participants')
    .upsert(
      {
        event_id,
        torn_id: tornId,
        torn_name: tornName,
        torn_faction: tornFaction,
        personal_start_at: clampedStartIso,
        last_count: scan.count,
        last_respect_total: scan.respect_total,
        last_best_single_respect: scan.best_single_respect,
        last_checked_at: checkedAt,
        last_diag_json: scan.diag,
      },
      { onConflict: 'event_id,torn_id' },
    )
    .select()
    .single();

  if (upsertErr) return json({ error: upsertErr.message }, 500);

  return json({
    participant: upserted,
    count: scan.count,
    event,
  });
}

// Two-path authorization for "view another participant's scrape log"
// affordances: same model as handleDeleteFactionEvent. Admin Supabase
// session (operator backdoor) wins outright; otherwise the caller must
// hold a Faction Event session whose torn_id matches event.creator_torn_id.
// Returns either an authorization label string or a Response with 401/403.
async function authorizeScrapeLogAccess(
  req: Request,
  body: any,
  event: { creator_torn_id?: string | null },
): Promise<string | Response> {
  const adminUser = await requireAuth(req);
  if (adminUser) return `admin:${adminUser.id}`;

  const resolved = await resolveFactionEventApiKey(body);
  if (resolved instanceof Response) return resolved;
  const callerTornId = String(resolved.torn_id || '');
  if (!callerTornId) return json({ error: 'Sign in required' }, 401);
  if (!event.creator_torn_id || String(event.creator_torn_id) !== callerTornId) {
    return json({ error: 'Only the event creator (or the operator) can view scrape logs' }, 403);
  }
  return `creator:${callerTornId}`;
}

// Read the most recent persisted scrape diagnostic for a single participant.
// Authorized to HJ admin OR the event's creator (per authorizeScrapeLogAccess).
// Surfaces last_diag_json + the participant's count metadata so the modal
// can render one cohesive view without two round-trips.
async function handleGetParticipantScrapeLog(req: Request, body: any) {
  const event_id = typeof body.event_id === 'string' ? body.event_id : '';
  const torn_id = typeof body.torn_id === 'string' ? body.torn_id : '';
  if (!event_id || !torn_id) return json({ error: 'Missing event_id or torn_id' }, 400);

  const supabase = serviceClient();
  const { data: event, error: evtErr } = await supabase
    .from('faction_events')
    .select('id, title, event_type, drug_name, drug_item_id, starts_at, ends_at, creator_torn_id')
    .eq('id', event_id)
    .maybeSingle();
  if (evtErr) return json({ error: evtErr.message }, 500);
  if (!event) return json({ error: 'Event not found' }, 404);

  const authResult = await authorizeScrapeLogAccess(req, body, event);
  if (authResult instanceof Response) return authResult;

  const { data: participant, error: pErr } = await supabase
    .from('faction_event_participants')
    .select('id, torn_id, torn_name, torn_faction, personal_start_at, last_count, last_checked_at, last_diag_json')
    .eq('event_id', event_id)
    .eq('torn_id', torn_id)
    .maybeSingle();
  if (pErr) return json({ error: pErr.message }, 500);
  if (!participant) return json({ error: 'Participant not found' }, 404);

  return json({ participant, event, authorized_by: authResult });
}

// Run a fresh scrape against ANY participant's stored API key and persist
// the result + diag. Authorized to HJ admin OR the event's creator. Differs
// from refresh-faction-event in that the *caller's* identity does NOT have
// to match the participant being scraped — instead we look up the
// participant's stored key from faction_event_player_secrets and use that.
// If the participant has no stored key (signed out, never set one) or the
// key has been revoked, we surface that as a clear error so the caller
// understands why no fresh scrape is possible.
async function handleAdminRescrapeParticipant(req: Request, body: any) {
  const event_id = typeof body.event_id === 'string' ? body.event_id : '';
  const torn_id = typeof body.torn_id === 'string' ? body.torn_id : '';
  if (!event_id || !torn_id) return json({ error: 'Missing event_id or torn_id' }, 400);

  const supabase = serviceClient();
  const { data: event, error: evtErr } = await supabase
    .from('faction_events')
    .select('id, title, event_type, drug_name, drug_item_id, starts_at, ends_at, creator_torn_id')
    .eq('id', event_id)
    .maybeSingle();
  if (evtErr) return json({ error: evtErr.message }, 500);
  if (!event) return json({ error: 'Event not found' }, 404);

  const authResult = await authorizeScrapeLogAccess(req, body, event);
  if (authResult instanceof Response) return authResult;

  const { data: participant, error: pErr } = await supabase
    .from('faction_event_participants')
    .select('id, torn_id, torn_name, torn_faction, personal_start_at, last_count, last_checked_at')
    .eq('event_id', event_id)
    .eq('torn_id', torn_id)
    .maybeSingle();
  if (pErr) return json({ error: pErr.message }, 500);
  if (!participant) return json({ error: 'Participant not found' }, 404);

  const tornIdNum = Number(torn_id);
  if (!Number.isFinite(tornIdNum)) return json({ error: 'Invalid torn_id' }, 400);

  const { data: secret } = await supabase
    .from('faction_event_player_secrets')
    .select('api_key_enc, api_key_iv')
    .eq('torn_player_id', tornIdNum)
    .maybeSingle();
  if (!secret) {
    return json({ error: 'No stored API key for this participant — they need to sign in to Faction Events to enable re-scrape.' }, 409);
  }

  const apiKey = await decryptApiKey(secret.api_key_enc, secret.api_key_iv);
  if (!apiKey) {
    return json({ error: 'Stored key for this participant could not be decrypted (master key changed?). Ask them to sign in again.' }, 500);
  }

  // Identity probe before the count call. Without this, a paused / revoked
  // key returns an error on every page of countItemUseInLog and we'd
  // happily write last_count=0 over a previously-good count. Mirror the
  // probe pattern from handleRefreshStaleParticipants:
  //   - permanent error (codes 2/16) → cascade-delete and 410 to caller
  //   - transient error (paused / rate-limited / IP-banned / 5xx) →
  //     return 503 to caller WITHOUT touching last_count or last_diag_json
  //     so the prior good count survives
  const probeRes = await fetch(`${TORN_API}/user/?selections=basic&key=${apiKey}`);
  const probe = await probeRes.json().catch(() => ({}));
  if (probe?.error) {
    if (isPermanentTornKeyError(probe.error.code)) {
      await cascadeDeleteFactionEventSecret(supabase, tornIdNum);
      return json({ error: `Torn API: ${probe.error.error} — participant's stored key has been removed.` }, 410);
    }
    return json({
      error: `Torn API (transient, count not overwritten): code ${probe.error.code} — ${probe.error.error}`,
      torn_error_code: probe.error.code,
    }, 503);
  }

  const { fromSec, untilSec } = participantCountWindow(event, participant.personal_start_at);
  const scan = await runEventScanner(apiKey, event, participant.torn_id, fromSec, untilSec);
  if (scan.skipReason === 'scope_error') {
    return json({
      error: "Participant's key doesn't have Attacks access — count left unchanged. They need to re-sign in with a Custom Key that includes 'attacks'.",
      torn_error_code: 16,
    }, 503);
  }

  const updateFields: Record<string, unknown> = {
    last_count: scan.count,
    last_checked_at: new Date().toISOString(),
    last_diag_json: scan.diag,
  };
  if (event.event_type === 'attacks') {
    updateFields.last_respect_total = scan.respect_total;
    updateFields.last_best_single_respect = scan.best_single_respect;
  }

  const { data: updated, error: updErr } = await supabase
    .from('faction_event_participants')
    .update(updateFields)
    .eq('id', participant.id)
    .select('id, torn_id, torn_name, torn_faction, personal_start_at, last_count, last_respect_total, last_best_single_respect, last_checked_at, last_diag_json')
    .single();
  if (updErr) return json({ error: updErr.message }, 500);

  console.log(`[admin-rescrape-participant] event=${event_id} torn_id=${torn_id} count=${scan.count} authorizedBy=${authResult}`);
  return json({ participant: updated, count: scan.count, event, diag: scan.diag, authorized_by: authResult });
}

// Force-refresh every participant in an event in a single call. Unlike
// handleRefreshStaleParticipants (which is a public, no-auth sweep that
// only picks up to 15 stale rows), this handler:
//   - Requires HJ-admin or event-creator auth (authorizeScrapeLogAccess)
//   - Ignores last_checked_at — picks ALL rows for the event
//   - Caps at MAX_BATCH so a 200-participant event can't hang the Edge Function
//     (operator can call it again to finish the rest)
// Per-row outcomes mirror the sweep:
//   - No stored key → skipped (left unchanged)
//   - Permanent Torn error → cascade-delete + counted as deleted
//   - Transient Torn error → skipped (count + diag NOT overwritten so a
//     paused key never destroys a good count)
//   - Success → count + diag persisted
async function handleForceRefreshAllParticipants(req: Request, body: any) {
  const event_id = typeof body.event_id === 'string' ? body.event_id : '';
  if (!event_id) return json({ error: 'Missing event_id' }, 400);

  const MAX_BATCH = 100;

  const supabase = serviceClient();
  const { data: event, error: evtErr } = await supabase
    .from('faction_events')
    .select('id, title, event_type, drug_name, drug_item_id, starts_at, ends_at, creator_torn_id')
    .eq('id', event_id)
    .maybeSingle();
  if (evtErr) return json({ error: evtErr.message }, 500);
  if (!event) return json({ error: 'Event not found' }, 404);

  const authResult = await authorizeScrapeLogAccess(req, body, event);
  if (authResult instanceof Response) return authResult;

  // Stale-first ordering: rows with NULL last_checked_at, then oldest first.
  // Lets a partial pass make maximum progress on the most-out-of-date rows.
  const { data: rows = [] } = await supabase
    .from('faction_event_participants')
    .select('id, torn_id, torn_name, personal_start_at, last_count, last_checked_at')
    .eq('event_id', event_id)
    .order('last_checked_at', { ascending: true, nullsFirst: true })
    .limit(MAX_BATCH);

  if (!rows || rows.length === 0) {
    return json({ refreshed: 0, deleted: 0, skipped: 0, transient: 0, total: 0, picked: 0 });
  }

  let refreshed = 0;
  let deleted = 0;
  let skipped = 0;
  let transient = 0;
  const transientNames: string[] = [];
  const deletedNames: string[] = [];
  const skippedNames: string[] = [];

  for (const row of rows) {
    const tornIdNum = Number(row.torn_id);
    if (!Number.isFinite(tornIdNum)) {
      skipped++;
      skippedNames.push(row.torn_name || row.torn_id);
      continue;
    }

    const { data: secret } = await supabase
      .from('faction_event_player_secrets')
      .select('api_key_enc, api_key_iv')
      .eq('torn_player_id', tornIdNum)
      .maybeSingle();

    if (!secret) {
      skipped++;
      skippedNames.push(row.torn_name || row.torn_id);
      continue;
    }

    const apiKey = await decryptApiKey(secret.api_key_enc, secret.api_key_iv);
    if (!apiKey) {
      await cascadeDeleteFactionEventSecret(supabase, tornIdNum);
      deleted++;
      deletedNames.push(row.torn_name || row.torn_id);
      continue;
    }

    const probeRes = await fetch(`${TORN_API}/user/?selections=basic&key=${apiKey}`);
    const probe = await probeRes.json().catch(() => ({}));
    if (probe?.error) {
      if (isPermanentTornKeyError(probe.error.code)) {
        await cascadeDeleteFactionEventSecret(supabase, tornIdNum);
        deleted++;
        deletedNames.push(row.torn_name || row.torn_id);
      } else {
        transient++;
        transientNames.push(`${row.torn_name || row.torn_id} (code ${probe.error.code})`);
      }
      continue;
    }

    const { fromSec, untilSec } = participantCountWindow(event, row.personal_start_at);
    const scan = await runEventScanner(apiKey, event, row.torn_id, fromSec, untilSec);
    if (scan.skipReason === 'scope_error') {
      transient++;
      transientNames.push(`${row.torn_name || row.torn_id} (no attacks scope)`);
      continue;
    }

    const updateFields: Record<string, unknown> = {
      last_count: scan.count,
      last_checked_at: new Date().toISOString(),
      last_diag_json: scan.diag,
    };
    if (event.event_type === 'attacks') {
      updateFields.last_respect_total = scan.respect_total;
      updateFields.last_best_single_respect = scan.best_single_respect;
    }
    await supabase
      .from('faction_event_participants')
      .update(updateFields)
      .eq('id', row.id);
    refreshed++;
  }

  console.log(`[force-refresh-all-participants] event=${event_id} refreshed=${refreshed} transient=${transient} deleted=${deleted} skipped=${skipped} authorizedBy=${authResult}`);
  return json({
    refreshed,
    deleted,
    skipped,
    transient,
    total: rows.length,
    picked: rows.length,
    transient_names: transientNames,
    deleted_names: deletedNames,
    skipped_names: skippedNames,
  });
}

// Mark every participant in an event as scrape_status='pending'. The
// frontend then drives a one-at-a-time loop calling scrape-next-pending
// with a timer between calls. Authorized to HJ admin OR event creator.
// Idempotent — calling it twice in a row is safe (still ends with all
// rows pending). If a prior run was interrupted (some rows still
// pending), this resets ALL rows to pending again. To resume an
// interrupted batch instead of starting over, the frontend should skip
// this call and just keep calling scrape-next-pending.
async function handleStartBulkRefresh(req: Request, body: any) {
  const event_id = typeof body.event_id === 'string' ? body.event_id : '';
  if (!event_id) return json({ error: 'Missing event_id' }, 400);

  const supabase = serviceClient();
  const { data: event, error: evtErr } = await supabase
    .from('faction_events')
    .select('id, title, event_type, drug_name, drug_item_id, starts_at, ends_at, creator_torn_id')
    .eq('id', event_id)
    .maybeSingle();
  if (evtErr) return json({ error: evtErr.message }, 500);
  if (!event) return json({ error: 'Event not found' }, 404);

  const authResult = await authorizeScrapeLogAccess(req, body, event);
  if (authResult instanceof Response) return authResult;

  const { data: updated, error: updErr } = await supabase
    .from('faction_event_participants')
    .update({ scrape_status: 'pending' })
    .eq('event_id', event_id)
    .select('id, torn_id, torn_name');
  if (updErr) return json({ error: updErr.message }, 500);

  console.log(`[start-bulk-refresh] event=${event_id} marked=${updated?.length || 0} authorizedBy=${authResult}`);
  return json({ marked: updated?.length || 0, participants: updated || [] });
}

// Pick the oldest scrape_status='pending' row for the event, run a
// probe + scrape using their stored API key, persist the result, and
// clear scrape_status. Frontend drives the loop: call repeatedly with
// a timer between calls until `done: true` is returned.
//
// Per-row outcomes (mirror the bulk sweep):
//   - 'refreshed'        → count + diag updated, scrape_status cleared
//   - 'transient_error'  → count + diag NOT touched (paused / rate-
//                          limited / 5xx); scrape_status cleared so
//                          the queue still drains
//   - 'permanent_error'  → cascade-delete; row no longer exists
//   - 'no_key'           → no stored secret; scrape_status cleared
//   - 'decrypt_failed'   → cascade-delete (master key changed?)
async function handleScrapeNextPending(req: Request, body: any) {
  const event_id = typeof body.event_id === 'string' ? body.event_id : '';
  if (!event_id) return json({ error: 'Missing event_id' }, 400);

  const supabase = serviceClient();
  const { data: event, error: evtErr } = await supabase
    .from('faction_events')
    .select('id, title, event_type, drug_name, drug_item_id, starts_at, ends_at, creator_torn_id')
    .eq('id', event_id)
    .maybeSingle();
  if (evtErr) return json({ error: evtErr.message }, 500);
  if (!event) return json({ error: 'Event not found' }, 404);

  const authResult = await authorizeScrapeLogAccess(req, body, event);
  if (authResult instanceof Response) return authResult;

  // Pick the oldest pending row. Order by created_at so we process
  // participants in the order they joined — gives the operator a
  // predictable "we're working through the leaderboard top-to-bottom"
  // feel rather than random.
  const { data: row, error: rowErr } = await supabase
    .from('faction_event_participants')
    .select('id, torn_id, torn_name, personal_start_at, last_count, last_checked_at')
    .eq('event_id', event_id)
    .eq('scrape_status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (rowErr) return json({ error: rowErr.message }, 500);

  if (!row) {
    // Queue is empty → tell the frontend to stop looping.
    const { count: remaining } = await supabase
      .from('faction_event_participants')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', event_id)
      .eq('scrape_status', 'pending');
    return json({ done: true, remaining: remaining || 0 });
  }

  const tornIdNum = Number(row.torn_id);
  const clearStatus = async () =>
    supabase.from('faction_event_participants').update({ scrape_status: null }).eq('id', row.id);

  if (!Number.isFinite(tornIdNum)) {
    await clearStatus();
    return await respondWithRemaining(supabase, event_id, {
      status: 'no_key',
      participant: row,
      message: `Invalid torn_id: ${row.torn_id}`,
    });
  }

  const { data: secret } = await supabase
    .from('faction_event_player_secrets')
    .select('api_key_enc, api_key_iv')
    .eq('torn_player_id', tornIdNum)
    .maybeSingle();

  if (!secret) {
    await clearStatus();
    return await respondWithRemaining(supabase, event_id, {
      status: 'no_key',
      participant: row,
      message: 'No stored API key on file.',
    });
  }

  const apiKey = await decryptApiKey(secret.api_key_enc, secret.api_key_iv);
  if (!apiKey) {
    await cascadeDeleteFactionEventSecret(supabase, tornIdNum);
    return await respondWithRemaining(supabase, event_id, {
      status: 'decrypt_failed',
      participant: row,
      message: 'Stored key could not be decrypted; participant row removed.',
    });
  }

  const probeRes = await fetch(`${TORN_API}/user/?selections=basic&key=${apiKey}`);
  const probe = await probeRes.json().catch(() => ({}));
  if (probe?.error) {
    if (isPermanentTornKeyError(probe.error.code)) {
      await cascadeDeleteFactionEventSecret(supabase, tornIdNum);
      return await respondWithRemaining(supabase, event_id, {
        status: 'permanent_error',
        participant: row,
        message: `Torn API: ${probe.error.error} — participant removed.`,
        torn_error_code: probe.error.code,
      });
    }
    await clearStatus();
    return await respondWithRemaining(supabase, event_id, {
      status: 'transient_error',
      participant: row,
      message: `Torn API (transient): code ${probe.error.code} — ${probe.error.error}`,
      torn_error_code: probe.error.code,
    });
  }

  const { fromSec, untilSec } = participantCountWindow(event, row.personal_start_at);
  const scan = await runEventScanner(apiKey, event, row.torn_id, fromSec, untilSec);

  // Attack-event scope errors leave last_count untouched — same posture
  // as transient errors — so a participant who hasn't widened their key
  // doesn't get zeroed out on every sweep.
  if (scan.skipReason === 'scope_error') {
    await clearStatus();
    return await respondWithRemaining(supabase, event_id, {
      status: 'transient_error',
      participant: row,
      message: 'Key missing attacks scope — count left unchanged. Ask the participant to re-sign in with a wider Custom Key.',
      torn_error_code: 16,
    });
  }

  const updateFields: Record<string, unknown> = {
    last_count: scan.count,
    last_checked_at: new Date().toISOString(),
    last_diag_json: scan.diag,
    scrape_status: null,
  };
  if (event.event_type === 'attacks') {
    updateFields.last_respect_total = scan.respect_total;
    updateFields.last_best_single_respect = scan.best_single_respect;
  }

  const { data: updated, error: updErr } = await supabase
    .from('faction_event_participants')
    .update(updateFields)
    .eq('id', row.id)
    .select('id, torn_id, torn_name, torn_faction, personal_start_at, last_count, last_respect_total, last_best_single_respect, last_checked_at, scrape_status')
    .single();
  if (updErr) return json({ error: updErr.message }, 500);

  console.log(`[scrape-next-pending] event=${event_id} torn_id=${row.torn_id} count=${scan.count} authorizedBy=${authResult}`);
  return await respondWithRemaining(supabase, event_id, {
    status: 'refreshed',
    participant: updated,
    count: scan.count,
    diag: scan.diag,
  });
}

// Helper for handleScrapeNextPending: append the remaining-pending
// count to whatever per-row response the caller built. The frontend
// uses `remaining` to decide whether to keep looping.
async function respondWithRemaining(
  supabase: any,
  event_id: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const { count: remaining } = await supabase
    .from('faction_event_participants')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', event_id)
    .eq('scrape_status', 'pending');
  return json({ done: false, remaining: remaining || 0, ...payload });
}

// Re-run the count for the calling user against the same event. Identical
// scan to `join`, but does NOT change personal_start_at or identity fields.
async function handleRefreshFactionEventParticipant(body: any) {
  const event_id = typeof body.event_id === 'string' ? body.event_id : '';
  if (!event_id) return json({ error: 'Missing event_id' }, 400);

  const resolved = await resolveFactionEventApiKey(body);
  if (resolved instanceof Response) return resolved;
  const api_key = resolved.key;

  const supabase = serviceClient();
  const { data: event, error: evtErr } = await supabase
    .from('faction_events')
    .select('*')
    .eq('id', event_id)
    .maybeSingle();
  if (evtErr) return json({ error: evtErr.message }, 500);
  if (!event) return json({ error: 'Event not found' }, 404);

  const identRes = await fetch(`${TORN_API}/user/?selections=basic,profile&key=${api_key}`);
  const identData = await identRes.json();
  if (identData.error) {
    if (resolved.torn_id && isPermanentTornKeyError(identData.error.code)) {
      await cascadeDeleteFactionEventSecret(supabase, resolved.torn_id);
    }
    return json({ error: `Torn API: ${identData.error.error}` }, 400);
  }
  const tornId = String(identData.player_id);

  const { data: existing, error: existErr } = await supabase
    .from('faction_event_participants')
    .select('*')
    .eq('event_id', event_id)
    .eq('torn_id', tornId)
    .maybeSingle();
  if (existErr) return json({ error: existErr.message }, 500);
  if (!existing) return json({ error: 'You have not joined this event yet' }, 404);

  const { fromSec, untilSec } = participantCountWindow(event, existing.personal_start_at);
  const scan = await runEventScanner(api_key, event, tornId, fromSec, untilSec);
  if (scan.skipReason === 'scope_error') {
    return json({
      error: "Your API key doesn't have Attacks access. Re-sign in with a Custom Key that includes the 'attacks' scope, then refresh again.",
      torn_error_code: 16,
    }, 400);
  }

  const checkedAt = new Date().toISOString();
  const updateFields: Record<string, unknown> = {
    last_count: scan.count,
    last_checked_at: checkedAt,
    last_diag_json: scan.diag,
    torn_name: String(identData.name || existing.torn_name),
    torn_faction: identData.faction?.faction_name ?? existing.torn_faction,
  };
  if (event.event_type === 'attacks') {
    updateFields.last_respect_total = scan.respect_total;
    updateFields.last_best_single_respect = scan.best_single_respect;
  }

  const { data: updated, error: updErr } = await supabase
    .from('faction_event_participants')
    .update(updateFields)
    .eq('id', existing.id)
    .select()
    .single();

  if (updErr) return json({ error: updErr.message }, 500);
  return json({ participant: updated, count: scan.count, event, diag: scan.diag });
}

// Public sweep called in the background by every viewer of an event page so
// the leaderboard self-heals without each viewer needing each participant's
// API key. No caller auth required (the keys we use are the participants'
// own stored keys from faction_event_player_secrets).
//
// Pick up to MAX_BATCH stale rows for this event — NULL last_checked_at
// first (newly-invalidated by an event edit, or never refreshed since join),
// then any row older than STALE_AFTER_SEC. Process sequentially so we can
// react to revoked keys row-by-row without burning rate limit on already-dead
// keys, and so cascade-deletes don't race with their own follow-up updates.
//
// Per-row outcomes:
//   - No stored key for this torn_id (signed out / never saved): touch
//     last_checked_at = now() so the row drops out of the stale queue and
//     stops getting re-picked every sweep. Count is left unchanged.
//   - Permanent Torn error (codes 2 / 16): cascadeDeleteFactionEventSecret
//     drops the secret row + every participant row for this torn_id, then
//     we move on. The participant rows vanish from every event leaderboard.
//   - Transient Torn error (5 / 8 / 9): leave the row alone (don't touch
//     last_checked_at) so the next sweep retries it as soon as it qualifies.
//   - Success: re-run countItemUseInLog over [personal_start_at, min(now,
//     ends_at)] and write the fresh count + last_checked_at.
async function handleRefreshStaleParticipants(body: any) {
  const event_id = typeof body.event_id === 'string' ? body.event_id : '';
  if (!event_id) return json({ error: 'Missing event_id' }, 400);

  const MAX_BATCH = 15;
  const STALE_AFTER_SEC = 60;

  const supabase = serviceClient();
  const { data: event, error: evtErr } = await supabase
    .from('faction_events')
    .select('*')
    .eq('id', event_id)
    .maybeSingle();
  if (evtErr) return json({ error: evtErr.message }, 500);
  if (!event) return json({ error: 'Event not found' }, 404);

  const cutoffIso = new Date(Date.now() - STALE_AFTER_SEC * 1000).toISOString();

  // NULL-first: rows that were invalidated (by event edit) or never refreshed
  // since the initial join. Order by created_at to stay deterministic.
  const { data: nullRows = [] } = await supabase
    .from('faction_event_participants')
    .select('id, torn_id, personal_start_at, last_count, last_checked_at')
    .eq('event_id', event_id)
    .is('last_checked_at', null)
    .order('created_at', { ascending: true })
    .limit(MAX_BATCH);

  let stale = nullRows || [];
  if (stale.length < MAX_BATCH) {
    const remaining = MAX_BATCH - stale.length;
    const { data: oldRows = [] } = await supabase
      .from('faction_event_participants')
      .select('id, torn_id, personal_start_at, last_count, last_checked_at')
      .eq('event_id', event_id)
      .not('last_checked_at', 'is', null)
      .lt('last_checked_at', cutoffIso)
      .order('last_checked_at', { ascending: true })
      .limit(remaining);
    stale = stale.concat(oldRows || []);
  }

  if (stale.length === 0) {
    return json({ refreshed: 0, deleted: 0, skipped: 0 });
  }

  let refreshed = 0;
  let deleted = 0;
  let skipped = 0;

  for (const row of stale) {
    const tornIdNum = Number(row.torn_id);
    if (!Number.isFinite(tornIdNum)) {
      skipped++;
      continue;
    }

    const { data: secret } = await supabase
      .from('faction_event_player_secrets')
      .select('api_key_enc, api_key_iv')
      .eq('torn_player_id', tornIdNum)
      .maybeSingle();

    if (!secret) {
      // No key on file — touch last_checked_at so this row stops dominating
      // the stale queue. The participant can re-join after signing in again.
      await supabase
        .from('faction_event_participants')
        .update({ last_checked_at: new Date().toISOString() })
        .eq('id', row.id);
      skipped++;
      continue;
    }

    const apiKey = await decryptApiKey(secret.api_key_enc, secret.api_key_iv);
    if (!apiKey) {
      // Decrypt failure means the row is corrupt or the master key changed.
      // Cascade-delete so we don't keep failing on it forever.
      await cascadeDeleteFactionEventSecret(supabase, tornIdNum);
      deleted++;
      continue;
    }

    // Cheap probe — basic alone is enough to learn whether the key is alive.
    const probeRes = await fetch(`${TORN_API}/user/?selections=basic&key=${apiKey}`);
    const probe = await probeRes.json().catch(() => ({}));

    if (probe?.error) {
      if (isPermanentTornKeyError(probe.error.code)) {
        await cascadeDeleteFactionEventSecret(supabase, tornIdNum);
        deleted++;
      } else {
        // Transient — leave row alone so we retry next sweep.
        skipped++;
      }
      continue;
    }

    const { fromSec, untilSec } = participantCountWindow(event, row.personal_start_at);
    const scan = await runEventScanner(apiKey, event, row.torn_id, fromSec, untilSec);
    if (scan.skipReason === 'scope_error') {
      // Key is alive but missing attacks scope. Touch last_checked_at so
      // we don't re-pick this row every sweep; the participant needs to
      // re-sign in with a wider Custom Key before counts resume.
      await supabase
        .from('faction_event_participants')
        .update({ last_checked_at: new Date().toISOString() })
        .eq('id', row.id);
      skipped++;
      continue;
    }

    const updateFields: Record<string, unknown> = {
      last_count: scan.count,
      last_checked_at: new Date().toISOString(),
      last_diag_json: scan.diag,
    };
    if (event.event_type === 'attacks') {
      updateFields.last_respect_total = scan.respect_total;
      updateFields.last_best_single_respect = scan.best_single_respect;
    }
    await supabase
      .from('faction_event_participants')
      .update(updateFields)
      .eq('id', row.id);
    refreshed++;
  }

  return json({ refreshed, deleted, skipped, picked: stale.length });
}

// Best-effort: read the caller's in-game "Event start time" from Torn so the
// Faction Events page can pre-fill the personal-start-time picker. Torn's
// public docs are vague on which exact selection surfaces this preference,
// so we try the likely candidates (`calendar` + `events`) and return both
// the raw payloads and a parsed guess at the start time. The frontend uses
// it as a hint only — manual override always wins.
async function handleFetchTornEventStart(body: any) {
  const resolved = await resolveFactionEventApiKey(body);
  if (resolved instanceof Response) return resolved;
  const api_key = resolved.key;

  const calRes = await fetch(`${TORN_API}/user/?selections=calendar&key=${api_key}`);
  const calData = await calRes.json().catch(() => ({}));

  // If Torn permanently rejected the key here too, cascade-delete the
  // session row before returning. Calendar is a soft feature — we don't
  // surface the error to the frontend, but we do clean up.
  if (calData?.error && resolved.torn_id && isPermanentTornKeyError(calData.error.code)) {
    const supabase = serviceClient();
    await cascadeDeleteFactionEventSecret(supabase, resolved.torn_id);
  }

  // Heuristic parse: look for any field whose key contains "start" and whose
  // value is a unix timestamp or HH:MM string.
  let guess_start_unix: number | null = null;
  let guess_start_label: string | null = null;
  function walk(obj: any, depth = 0) {
    if (!obj || depth > 4) return;
    if (Array.isArray(obj)) {
      for (const v of obj) walk(v, depth + 1);
      return;
    }
    if (typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        const kl = k.toLowerCase();
        if (kl.includes('start') && (typeof v === 'number' || typeof v === 'string')) {
          if (typeof v === 'number' && v > 1_000_000_000) {
            if (!guess_start_unix) guess_start_unix = v;
          } else if (typeof v === 'string' && /^\d{1,2}:\d{2}/.test(v)) {
            if (!guess_start_label) guess_start_label = v;
          }
        }
        if (v && typeof v === 'object') walk(v, depth + 1);
      }
    }
  }
  walk(calData);

  return json({
    calendar_raw: calData,
    guess_start_unix,
    guess_start_label,
  });
}

// ── Faction Event test bench (diagnostic, no DB writes) ─────────────
// Lets the operator paste a raw Torn API key and run the same scanners
// the live FE app uses (or will use), so we can verify the data shape
// before rolling new metrics into the app proper. No auth — the key
// being scanned IS the auth.

async function handleFeTestCountDrugs(body: any) {
  const { api_key, drug_item_id, drug_name, from_ts, to_ts } = body;
  if (!api_key) return json({ error: 'Missing api_key' }, 400);
  const itemId = Number(drug_item_id);
  if (!Number.isFinite(itemId) || itemId <= 0) {
    return json({ error: 'Missing or invalid drug_item_id' }, 400);
  }
  const drugName = typeof drug_name === 'string' ? drug_name.trim() : '';
  if (!drugName) return json({ error: 'Missing drug_name' }, 400);

  const identRes = await fetch(`${TORN_API}/user/?selections=basic,profile&key=${api_key}`);
  const identData = await identRes.json();
  if (identData.error) return json({ error: `Torn API: ${identData.error.error}`, code: identData.error.code }, 400);

  const fromSec = from_ts ? Number(from_ts) : undefined;
  const toSec = to_ts ? Number(to_ts) : undefined;
  if (from_ts && (!Number.isFinite(fromSec) || fromSec! <= 0)) {
    return json({ error: 'from_ts must be a positive unix timestamp in seconds' }, 400);
  }
  if (to_ts && (!Number.isFinite(toSec) || toSec! <= 0)) {
    return json({ error: 'to_ts must be a positive unix timestamp in seconds' }, 400);
  }

  const result = await countItemUseInLog(api_key, itemId, drugName, fromSec, toSec);

  return json({
    player: {
      name: identData.name,
      id: String(identData.player_id),
      level: identData.level || null,
      faction: identData.faction?.faction_name || null,
    },
    drug: { id: itemId, name: drugName },
    window: {
      from_ts: fromSec ?? null,
      to_ts: toSec ?? null,
      from_iso: fromSec ? new Date(fromSec * 1000).toISOString() : null,
      to_iso: toSec ? new Date(toSec * 1000).toISOString() : null,
    },
    count: result.count,
    pages_fetched: result.pages,
    total_entries_scanned: result.totalEntries,
    in_window_total: result.inWindowTotal,
    reached_cutoff: result.reachedCutoff,
    matched_items: result.matchedItems,
    details: result.details,
    log_type_histogram: result.logTypeHistogram,
    data_item_histogram: result.dataItemHistogram,
    interesting_rejections: result.interestingRejections,
    rejected_samples: result.rejectedSamples.slice(0, 20),
    debug: result.debug,
  });
}

// Hits Torn's v1 `attacks` selection (full per-attack records, last ~100)
// over an optional from/to window and returns the raw payload plus a
// best-effort computed summary so we can see WHICH fields carry attacks,
// assists and respect_gain before committing to a schema. Defenses are
// also separated out for sanity-checking.
async function handleFeTestCountAttacks(body: any) {
  const { api_key, from_ts, to_ts } = body;
  if (!api_key) return json({ error: 'Missing api_key' }, 400);

  const identRes = await fetch(`${TORN_API}/user/?selections=basic,profile&key=${api_key}`);
  const identData = await identRes.json();
  if (identData.error) return json({ error: `Torn API: ${identData.error.error}`, code: identData.error.code }, 400);

  const myId = Number(identData.player_id);
  const fromSec = from_ts ? Number(from_ts) : undefined;
  const toSec = to_ts ? Number(to_ts) : undefined;
  if (from_ts && (!Number.isFinite(fromSec) || fromSec! <= 0)) {
    return json({ error: 'from_ts must be a positive unix timestamp in seconds' }, 400);
  }
  if (to_ts && (!Number.isFinite(toSec) || toSec! <= 0)) {
    return json({ error: 'to_ts must be a positive unix timestamp in seconds' }, 400);
  }

  const fromParam = fromSec ? `&from=${fromSec}` : '';
  const toParam = toSec ? `&to=${toSec}` : '';
  const url = `${TORN_API}/user/?selections=attacks${fromParam}${toParam}&key=${api_key}`;
  const r = await fetch(url);
  const data = await r.json();

  if (data.error) {
    return json({
      player: { name: identData.name, id: String(identData.player_id) },
      torn_error: data.error,
      hint: data.error.code === 16
        ? 'Your API key does not have Attacks access. Mint a Custom Key on Torn with at least "attacks" enabled to use this metric.'
        : null,
    });
  }

  const records: any[] = data.attacks ? Object.values(data.attacks) : [];

  let offensive = 0;
  let defensive = 0;
  let assists_by_result = 0;
  let stalemates = 0;
  let losses_offensive = 0;
  let wins_offensive = 0;
  // Raw = respect_gain as Torn reports it. Base = respect_gain with the
  // chain_bonus multiplier stripped (so a 3-respect hit boosted to 103
  // by a milestone chain bonus contributes 3, not 103). Production
  // scanner uses Base; we surface both so the operator can validate.
  let respect_total_all_raw = 0;
  let respect_total_offensive_raw = 0;
  let respect_total_offensive_base = 0;
  let respect_total_defensive_raw = 0;
  let chain_bonus_hits = 0;
  let chain_bonus_max = 1;
  const result_field_histogram = new Map<string, number>();

  for (const a of records) {
    const attackerId = Number(a.attacker_id);
    const defenderId = Number(a.defender_id);
    const respectRaw = Number(a.respect_gain ?? a.respect ?? 0) || 0;
    const chainBonus = Number(a?.modifiers?.chain_bonus ?? 1) || 1;
    const respectBase = chainBonus > 1 ? respectRaw / chainBonus : respectRaw;
    if (chainBonus > 1) {
      chain_bonus_hits++;
      if (chainBonus > chain_bonus_max) chain_bonus_max = chainBonus;
    }
    respect_total_all_raw += respectRaw;
    const result = String(a.result || '');
    result_field_histogram.set(result, (result_field_histogram.get(result) || 0) + 1);
    if (attackerId === myId) {
      offensive++;
      respect_total_offensive_raw += respectRaw;
      respect_total_offensive_base += respectBase;
      if (/loss|lost/i.test(result)) losses_offensive++;
      else if (/^attacked|mugged|hospitalized|left|special|assist/i.test(result)) wins_offensive++;
    } else if (defenderId === myId) {
      defensive++;
      respect_total_defensive_raw += respectRaw;
    }
    if (result === 'Assist') assists_by_result++;
    if (result === 'Stalemate') stalemates++;
  }

  return json({
    player: {
      name: identData.name,
      id: String(identData.player_id),
      level: identData.level || null,
      faction: identData.faction?.faction_name || null,
    },
    window: {
      from_ts: fromSec ?? null,
      to_ts: toSec ?? null,
      from_iso: fromSec ? new Date(fromSec * 1000).toISOString() : null,
      to_iso: toSec ? new Date(toSec * 1000).toISOString() : null,
    },
    total_records: records.length,
    summary: {
      offensive,
      defensive,
      wins_offensive,
      losses_offensive,
      assists_by_result_field: assists_by_result,
      stalemates,
      respect_total_all_raw,
      respect_total_offensive_raw,
      respect_total_offensive_base,
      respect_total_defensive_raw,
      avg_respect_per_offensive_raw: offensive ? respect_total_offensive_raw / offensive : 0,
      avg_respect_per_offensive_base: offensive ? respect_total_offensive_base / offensive : 0,
      chain_bonus_hits,
      chain_bonus_max,
    },
    result_field_histogram: Array.from(result_field_histogram.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({ key, count })),
    sample_records: records.slice(0, 5),
    raw_response_keys: Object.keys(data),
  });
}

// ── Main router ──────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const action = body.action;

    switch (action) {
      case 'validate-player':
        return await handleValidatePlayer(body);
      case 'set-api-key':
        return await handleSetApiKey(body);
      case 'auto-login':
        return await handleAutoLogin(body);
      case 'revoke-session':
        return await handleRevokeSession(body);
      case 'fe-set-api-key':
        return await handleFeSetApiKey(body);
      case 'fe-auto-login':
        return await handleFeAutoLogin(body);
      case 'fe-revoke-session':
        return await handleFeRevokeSession(body);
      case 'torn-proxy':
        return await handleTornProxy(body);
      case 'create-transaction':
        return await handleCreateTransaction(body);
      case 'get-player-transactions':
        return await handleGetPlayerTransactions(body);
      case 'get-availability':
        return await handleGetAvailability();
      case 'get-public-stats':
        return await handleGetPublicStats();
      case 'admin-update-status':
        return await handleAdminUpdateStatus(req, body);
      case 'admin-update-client':
        return await handleAdminUpdateClient(req, body);
      case 'admin-reject-and-block':
        return await handleAdminRejectAndBlock(req, body);
      case 'update-config':
        return await handleUpdateConfig(req, body);
      case 'report-od':
        return await handleReportOd(body);
      case 'check-drug-usage':
      case 'check-ecstasy-usage':
        return await handleCheckDrugUsage(body);
      case 'verify-payment':
        return await handleVerifyPayment(body);
      case 'admin-sync-all-clients':
        return await handleAdminSyncAllClients(req);
      case 'test-email':
        return await handleTestEmail(req);
      case 'test-api-access':
        return await handleTestApiAccess(body);
      case 'admin-check-ecstasy':
        return await handleAdminCheckEcstasy(body);
      case 'admin-check-payment':
        return await handleAdminCheckPayment(body);
      case 'admin-test-drug-check':
        return await handleAdminTestDrugCheck(req, body);
      case 'admin-test-od-verify':
        return await handleAdminTestOdVerify(req, body);
      case 'admin-detect-happy-items':
        return await handleAdminDetectHappyItems(req, body);
      case 'admin-active-consumed':
        return await handleAdminActiveConsumed(req, body);
      case 'admin-auto-detect':
        return await handleAdminAutoDetect(req, body);
      case 'create-faction-event':
        return await handleCreateFactionEvent(body);
      case 'get-faction-event':
        return await handleGetFactionEvent(body);
      case 'list-faction-events':
        return await handleListFactionEvents(req, body);
      case 'list-fe-factions':
        return await handleListFeFactions(body);
      case 'update-faction-event':
        return await handleUpdateFactionEvent(req, body);
      case 'delete-faction-event':
        return await handleDeleteFactionEvent(req, body);
      case 'remove-faction-event-participant':
        return await handleRemoveFactionEventParticipant(req, body);
      case 'join-faction-event':
        return await handleJoinFactionEvent(body);
      case 'refresh-faction-event':
        return await handleRefreshFactionEventParticipant(body);
      case 'refresh-stale-participants':
        return await handleRefreshStaleParticipants(body);
      case 'get-participant-scrape-log':
        return await handleGetParticipantScrapeLog(req, body);
      case 'admin-rescrape-participant':
        return await handleAdminRescrapeParticipant(req, body);
      case 'force-refresh-all-participants':
        return await handleForceRefreshAllParticipants(req, body);
      case 'start-bulk-refresh':
        return await handleStartBulkRefresh(req, body);
      case 'scrape-next-pending':
        return await handleScrapeNextPending(req, body);
      case 'fetch-torn-event-start':
        return await handleFetchTornEventStart(body);
      case 'fe-test-count-drugs':
        return await handleFeTestCountDrugs(body);
      case 'fe-test-count-attacks':
        return await handleFeTestCountAttacks(body);
      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    return json({ error: err.message }, 500);
  }
});
