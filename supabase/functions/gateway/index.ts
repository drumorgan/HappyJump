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

// Count total clean closes (ODs do not reset progress toward next tier).
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

// ── Ecstasy usage detection (shared helper) ─────────────────────────
// Paginates through Torn API log entries to find Ecstasy usage.
// Returns the timestamp of the earliest Ecstasy use, or null if none found.
// Uses structured data (item ID 197) as primary check, text matching as fallback.

const ECSTASY_ITEM_ID = 197;

async function findEcstasyUsageInLog(
  apiKey: string,
  sinceTimestamp?: number, // only find usage after this time (e.g. purchased_at)
  maxPages = 10,
): Promise<{ timestamp: number; detail: string } | null> {
  let toParam = '';
  let earliestUsage: { timestamp: number; detail: string } | null = null;
  const cutoff = sinceTimestamp || 0;

  for (let page = 0; page < maxPages; page++) {
    const url = `${TORN_API}/user/?selections=log${toParam}&key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error || !data.log) break;

    const entries = Object.values(data.log) as any[];
    if (entries.length === 0) break;

    for (const entry of entries) {
      const ts = entry.timestamp || 0;
      if (ts < cutoff) continue; // before our window

      // Primary: structured data check (item ID 197 = Ecstasy)
      if (entry.data?.item === ECSTASY_ITEM_ID && entry.title?.toLowerCase().includes('item use')) {
        earliestUsage = { timestamp: ts, detail: `Ecstasy used (item ${ECSTASY_ITEM_ID}) at ${new Date(ts * 1000).toISOString()}` };
        continue; // keep scanning for earlier usage
      }

      // Fallback: text matching
      const text = [entry.title || '', entry.data ? JSON.stringify(entry.data) : ''].join(' ').toLowerCase();
      if (text.includes('ecstasy') && text.includes('happ') && !text.includes('overdos')) {
        if (!earliestUsage || ts < earliestUsage.timestamp) {
          earliestUsage = { timestamp: ts, detail: `Ecstasy used (text match) at ${new Date(ts * 1000).toISOString()}` };
        }
      }
    }

    // Find oldest timestamp in this batch to paginate further back
    const oldestTs = Math.min(...entries.map((e: any) => e.timestamp || Infinity));
    if (oldestTs <= cutoff) break; // gone back past our window
    if (entries.length < 100) break; // no more pages
    toParam = `&to=${oldestTs - 1}`;
  }

  return earliestUsage;
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

  // Auto-close purchased transactions after 7 days
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
        `A 7-day insurance window has expired with no OD claim.`,
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
  const { key, section, id, selections } = body;
  if (!key || !section) {
    return json({ error: 'Missing required fields: key, section' }, 400);
  }

  const idPart = id ? `/${id}` : '';
  const selPart = selections ? `?selections=${selections}&` : '?';
  const url = `${TORN_API}/${section}${idPart}${selPart}key=${key}`;

  const res = await fetch(url);
  const data = await res.json();
  return json(data);
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

  // Calculate costs (bigint columns come back as strings from Supabase)
  const xanaxPrice = Number(config.xanax_price);
  const edvdPrice = Number(config.edvd_price);
  const ecstasyPrice = Number(config.ecstasy_price);
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
    .select('torn_id, torn_name, xanax_payout, ecstasy_payout, payout_amount')
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
    updates.closes_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    updates.expires_at = null; // Clear request expiry once purchased
  }

  if (new_status === 'closed_clean' || new_status === 'payout_sent' || new_status === 'rejected') {
    updates.closed_at = new Date().toISOString();
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

  // Reserve management: release lock on close/payout/reject (atomic)
  if (new_status === 'closed_clean' || new_status === 'payout_sent' || new_status === 'rejected') {
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
      console.log(`[admin-update-status] Reserve adjusted: +${releaseAmount} for txn ${txn_id}`);
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
  const { api_key, txn_id } = body;
  if (!api_key || !txn_id) {
    return json({ error: 'Missing api_key or txn_id' }, 400);
  }

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

  // 2. Check log for Ecstasy usage (paginated — drug use is in log, not events)
  const ecstasyUsage = await findEcstasyUsageInLog(api_key, fromTs);

  // If Ecstasy was used successfully, the insured tab is consumed.
  // Any subsequent OD is on an uninsured tab — reject and auto-close.
  if (ecstasyUsage) {
    // Auto-close the policy as closed_clean
    const nowIso = new Date().toISOString();
    await supabase
      .from('transactions')
      .update({ status: 'closed_clean', closed_at: nowIso })
      .eq('id', txn_id);

    // Release locked reserve
    await adjustReserve(supabase, Number(txn.ecstasy_payout || 0));

    // Sync client stats
    await syncClientStats(supabase, tornId, { torn_name: identData.name });

    await sendNotificationEmail(
      `Happy Jump — Clean Close (Ecstasy Used) — ${identData.name} [${tornId}]`,
      [
        `Client logged in to claim an OD, but their API log shows Ecstasy was already taken successfully.`,
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
      detail: `Your Ecstasy tab was already taken successfully — the insured package is consumed and your policy has been closed clean. Any further ODs are not covered under this policy.`,
    });
  }

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

async function handleCheckEcstasyUsage(body: any) {
  const { api_key, txn_id } = body;
  if (!api_key || !txn_id) return json({ error: 'Missing api_key or txn_id' }, 400);

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
  if (txn.status !== 'purchased') return json({ used: false });

  // Paginate through log entries since purchase to check for Ecstasy usage
  const purchasedAt = txn.purchased_at ? new Date(txn.purchased_at) : null;
  const fromTs = purchasedAt ? Math.floor(purchasedAt.getTime() / 1000) : undefined;
  const ecstasyUsage = await findEcstasyUsageInLog(api_key, fromTs);

  if (ecstasyUsage) {
    // Auto-close the policy
    const nowIso = new Date().toISOString();
    await supabase
      .from('transactions')
      .update({ status: 'closed_clean', closed_at: nowIso })
      .eq('id', txn_id);

    await adjustReserve(supabase, Number(txn.ecstasy_payout || 0));
    await syncClientStats(supabase, tornId, { torn_name: identData.name });

    await sendNotificationEmail(
      `Happy Jump — Clean Close (Ecstasy Used) — ${identData.name} [${tornId}]`,
      [
        `Client checked their Ecstasy status and API confirms it was taken successfully.`,
        `Policy auto-closed clean.`,
        ``,
        `Player: ${identData.name} [${tornId}]`,
        `Transaction ID: ${txn_id}`,
        `Reserve released: ${formatMoney(Number(txn.ecstasy_payout || 0))}`,
      ].join('\n'),
    );

    return json({
      used: true,
      policy_closed: true,
      detail: 'Your Ecstasy tab was taken successfully — policy closed clean. Congrats!',
    });
  }

  return json({ used: false });
}

async function handleVerifyPayment(body: any) {
  const { api_key, txn_id } = body;
  if (!api_key || !txn_id) {
    return json({ error: 'Missing api_key or txn_id' }, 400);
  }

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
  const closesAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

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
      `Status has been auto-advanced to "purchased" — 7-day insurance window is now active.`,
    ].join('\n'),
  );

  // Sync client stats
  await syncClientStats(supabase, tornId, { torn_name: identData.name });

  return json({
    verified: true,
    torn_id: tornId,
    detail: `Payment of ${formatMoney(totalPaid)} verified! Your 7-day insurance window is now active.`,
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
    .select('torn_id, torn_name, torn_faction, torn_level, status');

  if (error) return json({ error: error.message }, 500);

  // Dedupe by torn_id, keeping latest info and collecting all statuses
  const clientMap = new Map<string, any>();
  const clientTxnStatuses = new Map<string, string[]>();
  for (const t of (txns || [])) {
    if (!t.torn_id) continue;
    if (!clientMap.has(t.torn_id) || (t.torn_name && t.torn_name !== 'null')) {
      clientMap.set(t.torn_id, t);
    }
    if (!clientTxnStatuses.has(t.torn_id)) clientTxnStatuses.set(t.torn_id, []);
    clientTxnStatuses.get(t.torn_id)!.push(t.status);
  }

  const details: any[] = [];
  let synced = 0;
  for (const [tornId, info] of clientMap) {
    const statuses = clientTxnStatuses.get(tornId) || [];
    const cleanCount = statuses.filter(s => s === 'closed_clean').length;
    const tier = computeTier(cleanCount);

    await syncClientStats(supabase, tornId, {
      torn_name: info.torn_name || undefined,
      torn_faction: info.torn_faction || undefined,
      torn_level: info.torn_level || undefined,
    });

    details.push({
      torn_id: tornId,
      name: info.torn_name,
      txn_count: statuses.length,
      statuses,
      clean_count: cleanCount,
      computed_tier: tier,
    });
    synced++;
  }

  console.log(`[admin-sync-all-clients] Synced ${synced} clients`);
  return json({ success: true, synced, details });
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
      case 'check-ecstasy-usage':
        return await handleCheckEcstasyUsage(body);
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
      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    return json({ error: err.message }, 500);
  }
});
