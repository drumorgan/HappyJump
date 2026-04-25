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

// Verified Torn narrative samples (provided by operator) — all 4 matched:
//   "You used some Xanax gaining 250 energy and 75 happiness"
// The drug name lives in the narrative, NOT in entry.title (which is a
// category label like "Item use"). Detection matches on narrative text.

function entryMatchesDrugUse(entry: any, drugName: string, itemId: number): boolean {
  const drugLower = drugName.toLowerCase();

  // Build a haystack from every stringy field Torn might put the narrative in
  const parts: string[] = [];
  if (entry.title) parts.push(String(entry.title));
  if (entry.log) parts.push(String(entry.log));
  if (entry.category) parts.push(String(entry.category));
  if (entry.data) parts.push(JSON.stringify(entry.data));
  if (entry.params) parts.push(JSON.stringify(entry.params));
  const hay = parts.join(' ').toLowerCase();

  // Exclude overdoses — those aren't successful uses
  if (hay.includes('overdos')) return false;
  // Exclude buys / trades / sends / receives — only successful uses count.
  // (Intentionally NOT excluding "used" — that's the verb we want.)
  // "buy" covers Torn titles like "Item buy abroad" / "Item market buy"; "abroad"
  // catches country-run bulk purchases whose title may not include "buy".
  if (/\b(buy|bought|buying|purchase|purchased|sold|sell|sent|received|dumped|bazaar|market|trade|traded|gift|abroad)\b/.test(hay)) return false;

  // Primary signal: structured data points at the drug.
  // IMPORTANT: only data.item (singular) indicates a USE. data.items (plural, an
  // object like {"197": 19}) is how Torn logs bulk transactions (buys from abroad,
  // bazaar sales, trades) — those are NOT uses and must not match here.
  const itemField = entry.data?.item;
  const structuredMatch =
    itemField === itemId ||
    itemField === String(itemId) ||
    (typeof itemField === 'string' && itemField.toLowerCase() === drugLower);

  // Narrative signal: drug name plus a "use" verb or a known stat gain phrase
  const narrativeMatch =
    hay.includes(drugLower) &&
    (hay.includes('used some ' + drugLower) ||
      hay.includes('used ' + drugLower) ||
      hay.includes('gaining') ||
      hay.includes('energy') ||
      hay.includes('happiness'));

  return structuredMatch || narrativeMatch;
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

// Generic Torn-log item-use counter used by Faction Events. Same paging
// shape as countXanaxUsageInLog but parameterised by item id + display
// name, with both a `since` and an optional `until` cutoff so we can scope
// counts to an event window. Honours the same dedupe-by-log-key rule.
async function countItemUseInLog(
  apiKey: string,
  itemId: number,
  drugName: string,
  sinceTimestamp?: number,
  untilTimestamp?: number,
  maxPages = 30,
): Promise<{ count: number; details: string[]; pages: number; totalEntries: number }> {
  let toParam = untilTimestamp ? `&to=${untilTimestamp}` : '';
  const fromParam = sinceTimestamp ? `&from=${sinceTimestamp}` : '';
  const cutoff = sinceTimestamp || 0;
  const upper = untilTimestamp || Number.POSITIVE_INFINITY;
  const seenKeys = new Set<string>();
  const uses: { timestamp: number; detail: string; key: string }[] = [];
  let pagesFetched = 0;
  let totalEntries = 0;
  let lastOldestTs = Infinity;

  for (let page = 0; page < maxPages; page++) {
    const url = `${TORN_API}/user/?selections=log${fromParam}${toParam}&key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error || !data.log) break;

    const entriesKv = Object.entries(data.log) as [string, any][];
    if (entriesKv.length === 0) break;
    pagesFetched++;
    totalEntries += entriesKv.length;

    for (const [key, entry] of entriesKv) {
      const ts = entry.timestamp || 0;
      if (ts < cutoff || ts > upper) continue;
      if (!entryMatchesDrugUse(entry, drugName, itemId)) continue;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const narrative = String(entry.log || entry.title || '').slice(0, 200);
      uses.push({
        timestamp: ts,
        detail: `${drugName} @ ${new Date(ts * 1000).toISOString()} — "${narrative}"`,
        key,
      });
    }

    const oldestTs = Math.min(...entriesKv.map(([, e]) => e.timestamp || Infinity));
    if (oldestTs <= cutoff) break;
    if (oldestTs === Infinity || oldestTs >= lastOldestTs) break;
    lastOldestTs = oldestTs;
    toParam = `&to=${oldestTs - 1}`;
  }

  uses.sort((a, b) => a.timestamp - b.timestamp);
  return {
    count: uses.length,
    details: uses.map((u) => u.detail),
    pages: pagesFetched,
    totalEntries,
  };
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
    .select('id, torn_id, torn_name, ecstasy_payout')
    .eq('status', 'purchased')
    .lt('closes_at', nowIso);

  if (!expired || expired.length === 0) return;

  for (const txn of expired) {
    await supabase
      .from('transactions')
      .update({ status: 'closed_clean', closed_at: nowIso })
      .eq('id', txn.id);

    // Release locked reserve (atomic)
    await adjustReserve(supabase, Number(txn.ecstasy_payout || 0));

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

  await supabase
    .from('faction_event_player_secrets')
    .update({ failed_attempts: 0, last_login_at: new Date().toISOString() })
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
    .select('torn_id, torn_name, status, xanax_payout, ecstasy_payout, payout_amount')
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
  }

  // Determine reserve transition direction
  const oldStatus = txnRecord.status;
  const reserveReleasedStates = ['closed_clean', 'payout_sent', 'rejected'];
  const reserveLockedStates = ['requested', 'purchased', 'od_xanax', 'od_ecstasy'];
  const wasReleased = reserveReleasedStates.includes(oldStatus);
  const willBeLocked = reserveLockedStates.includes(new_status);
  const wasLocked = reserveLockedStates.includes(oldStatus);
  const willBeReleased = reserveReleasedStates.includes(new_status);

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

  // Sync client stats — always use torn_id from the transaction record
  try {
    await syncClientStats(supabase, String(tornId));
    console.log(`[admin-update-status] Client stats synced for ${tornId}`);
  } catch (e) {
    console.error(`[admin-update-status] syncClientStats failed for ${tornId}:`, e?.message || e);
  }

  // Email notification for key status changes
  const emailStatuses = ['purchased', 'payout_sent', 'rejected'];
  if (emailStatuses.includes(new_status)) {
    const payoutInfo = new_status === 'payout_sent'
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
    .select('id, ecstasy_payout')
    .eq('torn_id', String(torn_id))
    .in('status', ['requested', 'purchased']);

  const now = new Date().toISOString();
  let rejectedCount = 0;

  // Reject each pending transaction and release reserve (atomic)
  for (const txn of (pending || [])) {
    await supabase
      .from('transactions')
      .update({ status: 'rejected', closed_at: now })
      .eq('id', txn.id);

    await adjustReserve(supabase, Number(txn.ecstasy_payout || 0));
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
    .select('id, torn_id, purchased_at, closes_at, status, product_type, xanax_payout, ecstasy_payout')
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

  if (!eventsData.error && eventsData.events) {
    const events = Object.values(eventsData.events) as any[];
    events.sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0));
    for (const evt of events) {
      const evtText = stripHtml(evt.event || '').toLowerCase();
      if (evtText.includes('overdos')) {
        if (evtText.includes('xanax')) { odDrug = 'xanax'; odEventTimestamp = evt.timestamp; break; }
        if (evtText.includes('ecstasy')) { odDrug = 'ecstasy'; odEventTimestamp = evt.timestamp; break; }
      }
    }
  }

  // 2. Check log for drug usage (paginated — drug use is in log, not events)
  const [xanaxResult, ecstasyUsage] = await Promise.all([
    countXanaxUsageInLog(api_key, fromTs),
    findEcstasyUsageInLog(api_key, fromTs),
  ]);

  const xanaxUsedCount = xanaxResult.count;
  const ecstasyUsed = !!ecstasyUsage;

  // If all drugs used (4 Xanax + 1 Ecstasy) AND no OD was detected, auto-close — the jump is complete.
  // IMPORTANT: do NOT clean-close if an OD event exists. An Ecstasy OD also produces an Ecstasy "use"
  // log entry (the OD is recorded separately in the events endpoint, and the use-log narrative does
  // not always contain "overdose"), so `ecstasyUsed` can be true precisely when the covered Ecstasy OD
  // happened. Falling through to the OD verification path below is what pays that claim out.
  if (!odDrug && xanaxUsedCount >= 4 && ecstasyUsed) {
    const nowIso = new Date().toISOString();
    await supabase
      .from('transactions')
      .update({ status: 'closed_clean', closed_at: nowIso })
      .eq('id', txn_id);

    await adjustReserve(supabase, Number(txn.ecstasy_payout || 0));
    await syncClientStats(supabase, tornId, { torn_name: identData.name });

    await sendNotificationEmail(
      `Happy Jump — Clean Close (All Drugs Used) — ${identData.name} [${tornId}]`,
      [
        `Client tried to claim an OD, but API log shows all drugs taken successfully (${xanaxUsedCount} Xanax + Ecstasy).`,
        `Policy auto-closed clean.`,
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
      detail: `All 4 Xanax and Ecstasy were already taken successfully — your Happy Jump is complete and the policy has been closed clean.`,
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
  const payoutAmount = odDrug === 'xanax' ? txn.xanax_payout : txn.ecstasy_payout;

  const updatePayload: any = { status: odStatus, payout_amount: payoutAmount };
  if (odEventTimestamp) updatePayload.od_event_timestamp = odEventTimestamp;

  const { error: updateErr } = await supabase
    .from('transactions')
    .update(updatePayload)
    .eq('id', txn_id);

  if (updateErr) return json({ error: updateErr.message }, 500);

  const drugLabel = odDrug === 'xanax' ? 'Xanax' : 'Ecstasy';

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
    .select('id, torn_id, purchased_at, status, ecstasy_payout')
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

  // Auto-close if all drugs used successfully (4 Xanax + 1 Ecstasy)
  if (xanaxUsed >= 4 && ecstasyUsed) {
    await supabase
      .from('transactions')
      .update({ status: 'closed_clean', closed_at: nowIso })
      .eq('id', txn_id);

    await adjustReserve(supabase, Number(txn.ecstasy_payout || 0));
    await syncClientStats(supabase, tornId, { torn_name: identData.name });

    await sendNotificationEmail(
      `Happy Jump — Clean Close (All Drugs Used) — ${identData.name} [${tornId}]`,
      [
        `Client's API log confirms all drugs taken successfully (${xanaxUsed} Xanax + Ecstasy).`,
        `Policy auto-closed clean.`,
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
      detail: 'All drugs taken successfully — Happy Jump complete! Policy closed clean. Congrats!',
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
  const drug_item_id = Number(body.drug_item_id);
  const drug_name = typeof body.drug_name === 'string' ? body.drug_name.trim() : '';

  if (!title) return json({ error: 'Title is required' }, 400);
  if (title.length > 120) return json({ error: 'Title too long' }, 400);
  if (!Number.isFinite(drug_item_id) || drug_item_id <= 0) {
    return json({ error: 'drug_item_id must be a positive integer' }, 400);
  }
  if (!drug_name) return json({ error: 'drug_name is required' }, 400);
  if (drug_name.length > 60) return json({ error: 'drug_name too long' }, 400);

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

  const personalParsed = parseFactionEventTimestamp(body.personal_start_at, 'personal_start_at');
  if (personalParsed.err) return json({ error: personalParsed.err }, 400);
  const personalStart = personalParsed.ts!;

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

  // Clamp the creator's personal start to the event window.
  const clampedStartMs = Math.min(
    Math.max(personalStart.getTime(), starts_at.getTime()),
    ends_at.getTime(),
  );
  const clampedStartIso = new Date(clampedStartMs).toISOString();

  // Initial count for the creator. If the personal start is in the future
  // (shouldn't happen post-clamp, but defensively) we just record 0.
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = Math.floor(clampedStartMs / 1000);
  const untilSec = Math.min(nowSec, Math.floor(ends_at.getTime() / 1000));
  let creatorCount = 0;
  if (untilSec > fromSec) {
    const result = await countItemUseInLog(api_key, drug_item_id, drug_name, fromSec, untilSec);
    creatorCount = result.count;
  }

  // Insert event first.
  const { data: eventRow, error: evtErr } = await supabase
    .from('faction_events')
    .insert({
      title,
      drug_item_id,
      drug_name,
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
      last_checked_at: checkedAt,
    })
    .select()
    .single();

  if (partErr) {
    await supabase.from('faction_events').delete().eq('id', eventRow.id);
    return json({ error: `Failed to seed creator participant: ${partErr.message}` }, 500);
  }

  return json({ event: eventRow, participant: participantRow });
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

  const { data: participants, error: partErr } = await supabase
    .from('faction_event_participants')
    .select('id, torn_id, torn_name, torn_faction, personal_start_at, last_count, last_checked_at, created_at')
    .eq('event_id', event_id)
    .order('last_count', { ascending: false });

  if (partErr) return json({ error: partErr.message }, 500);

  return json({ event, participants: participants || [] });
}

async function handleListFactionEvents(_body: any) {
  const supabase = serviceClient();
  const { data, error } = await supabase
    .from('faction_events')
    .select('id, title, drug_name, drug_item_id, starts_at, ends_at, created_at')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) return json({ error: error.message }, 500);
  return json({ events: data || [] });
}

// Creator-only patch of an event's title / drug / window. Authorized via
// a Faction Event session (resolveFactionEventApiKey) that resolves to the
// same torn_id stored in event.creator_torn_id. If the drug or window
// changes, every participant row is invalidated (last_checked_at = NULL)
// so the next sweep recounts. Personal-start times that now fall outside
// the new window are clamped back inside it.
async function handleUpdateFactionEvent(body: any) {
  const event_id = typeof body.event_id === 'string' ? body.event_id : '';
  if (!event_id) return json({ error: 'Missing event_id' }, 400);

  const resolved = await resolveFactionEventApiKey(body);
  if (resolved instanceof Response) return resolved;
  const callerTornId = String(resolved.torn_id || '');
  if (!callerTornId) return json({ error: 'Sign in required' }, 401);

  const supabase = serviceClient();
  const { data: event, error: evtErr } = await supabase
    .from('faction_events')
    .select('*')
    .eq('id', event_id)
    .maybeSingle();
  if (evtErr) return json({ error: evtErr.message }, 500);
  if (!event) return json({ error: 'Event not found' }, 404);

  if (!event.creator_torn_id || String(event.creator_torn_id) !== callerTornId) {
    return json({ error: 'Only the event creator can edit this event' }, 403);
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
  // the next refresh-stale-participants sweep recounts. Also clamp
  // personal_start_at into the new window for any rows that fell outside.
  if (drugChanged || windowChanged) {
    const startMs = newStartsAt.getTime();
    const endMs = newEndsAt.getTime();
    const { data: parts } = await supabase
      .from('faction_event_participants')
      .select('id, personal_start_at')
      .eq('event_id', event_id);

    if (parts && parts.length > 0) {
      // First, blanket-invalidate counts.
      await supabase
        .from('faction_event_participants')
        .update({ last_checked_at: null, last_count: 0 })
        .eq('event_id', event_id);

      // Then clamp any out-of-window personal-start times. Sequential rather
      // than batched because per-row clamp values differ.
      for (const p of parts) {
        const psMs = new Date(p.personal_start_at).getTime();
        const clamped = Math.min(Math.max(psMs, startMs), endMs);
        if (clamped !== psMs) {
          await supabase
            .from('faction_event_participants')
            .update({ personal_start_at: new Date(clamped).toISOString() })
            .eq('id', p.id);
        }
      }
    }
  }

  return json({ event: updatedEvent, drug_changed: drugChanged, window_changed: windowChanged });
}

// Validate the caller's API key, look up the event, run a bounded log scan,
// and either insert or update the participant row. Returns the updated row +
// fresh count so the client can render the leaderboard immediately.
async function handleJoinFactionEvent(body: any) {
  const event_id = typeof body.event_id === 'string' ? body.event_id : '';
  if (!event_id) return json({ error: 'Missing event_id' }, 400);

  const personalStartParsed = parseFactionEventTimestamp(body.personal_start_at, 'personal_start_at');
  if (personalStartParsed.err) return json({ error: personalStartParsed.err }, 400);
  const personalStart = personalStartParsed.ts!;

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
  const eventEndMs = new Date(event.ends_at).getTime();
  // Clamp the personal start time to the event window: never earlier than the
  // event start, never later than the event end.
  const clampedStartMs = Math.min(Math.max(personalStart.getTime(), eventStartMs), eventEndMs);
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

  // Run the count for this user's window: [clampedStart, min(now, eventEnd)].
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = Math.floor(clampedStartMs / 1000);
  const untilSec = Math.min(nowSec, Math.floor(eventEndMs / 1000));

  let count = 0;
  if (untilSec > fromSec) {
    const result = await countItemUseInLog(api_key, Number(event.drug_item_id), String(event.drug_name), fromSec, untilSec);
    count = result.count;
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
        last_count: count,
        last_checked_at: checkedAt,
      },
      { onConflict: 'event_id,torn_id' },
    )
    .select()
    .single();

  if (upsertErr) return json({ error: upsertErr.message }, 500);

  return json({
    participant: upserted,
    count,
    event,
  });
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

  const eventEndMs = new Date(event.ends_at).getTime();
  const startMs = new Date(existing.personal_start_at).getTime();
  const fromSec = Math.floor(startMs / 1000);
  const untilSec = Math.min(Math.floor(Date.now() / 1000), Math.floor(eventEndMs / 1000));

  let count = 0;
  if (untilSec > fromSec) {
    const result = await countItemUseInLog(api_key, Number(event.drug_item_id), String(event.drug_name), fromSec, untilSec);
    count = result.count;
  }

  const checkedAt = new Date().toISOString();
  const { data: updated, error: updErr } = await supabase
    .from('faction_event_participants')
    .update({
      last_count: count,
      last_checked_at: checkedAt,
      torn_name: String(identData.name || existing.torn_name),
      torn_faction: identData.faction?.faction_name ?? existing.torn_faction,
    })
    .eq('id', existing.id)
    .select()
    .single();

  if (updErr) return json({ error: updErr.message }, 500);
  return json({ participant: updated, count, event });
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

  const eventEndMs = new Date(event.ends_at).getTime();
  const drugItemId = Number(event.drug_item_id);
  const drugName = String(event.drug_name);

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

    const startMs = new Date(row.personal_start_at).getTime();
    const fromSec = Math.floor(startMs / 1000);
    const untilSec = Math.min(Math.floor(Date.now() / 1000), Math.floor(eventEndMs / 1000));

    let count = 0;
    if (untilSec > fromSec) {
      const result = await countItemUseInLog(apiKey, drugItemId, drugName, fromSec, untilSec);
      count = result.count;
    }

    await supabase
      .from('faction_event_participants')
      .update({ last_count: count, last_checked_at: new Date().toISOString() })
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
      case 'create-faction-event':
        return await handleCreateFactionEvent(body);
      case 'get-faction-event':
        return await handleGetFactionEvent(body);
      case 'list-faction-events':
        return await handleListFactionEvents(body);
      case 'update-faction-event':
        return await handleUpdateFactionEvent(body);
      case 'join-faction-event':
        return await handleJoinFactionEvent(body);
      case 'refresh-faction-event':
        return await handleRefreshFactionEventParticipant(body);
      case 'refresh-stale-participants':
        return await handleRefreshStaleParticipants(body);
      case 'fetch-torn-event-start':
        return await handleFetchTornEventStart(body);
      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    return json({ error: err.message }, 500);
  }
});
