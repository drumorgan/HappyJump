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

// Count consecutive clean closes from most recent backward (streak resets on OD).
function computeCleanStreak(txns: any[]): number {
  const completed = txns
    .filter((t: any) => ['closed_clean', 'od_xanax', 'od_ecstasy', 'payout_sent'].includes(t.status))
    .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  let streak = 0;
  for (const t of completed) {
    if (t.status === 'closed_clean') streak++;
    else break;
  }
  return streak;
}

// Recompute and upsert client stats from transactions.
// Optional `extraFields` allows setting torn_name etc. when available.
async function syncClientStats(supabase: any, tornId: string, extraFields?: Record<string, unknown>) {
  const { data: allTxns } = await supabase
    .from('transactions')
    .select('status, suggested_price, payout_amount, created_at, torn_name')
    .eq('torn_id', tornId);

  const txns = allTxns || [];
  const cleanCount = computeCleanStreak(txns);
  const txnCount = txns.length;
  const totalSpent = txns
    .filter((t: any) => ['closed_clean', 'payout_sent'].includes(t.status))
    .reduce((s: number, t: any) => s + Number(t.suggested_price || 0), 0);
  const totalPayouts = txns
    .filter((t: any) => t.status === 'payout_sent')
    .reduce((s: number, t: any) => s + Number(t.payout_amount || 0), 0);

  // If torn_name not provided in extraFields, pull from most recent transaction
  const upsertFields: Record<string, unknown> = {
    torn_id: tornId,
    clean_count: cleanCount,
    tier: computeTier(cleanCount),
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
      content: body,
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

// ── Auto-close expired transactions ──────────────────────────────────

async function autoCloseExpired(supabase: any) {
  const now = new Date().toISOString();
  const { data: expired } = await supabase
    .from('transactions')
    .select('id, torn_id, ecstasy_payout')
    .eq('status', 'purchased')
    .lt('closes_at', now);

  if (!expired || expired.length === 0) return;

  for (const txn of expired) {
    await supabase
      .from('transactions')
      .update({ status: 'closed_clean', closed_at: now })
      .eq('id', txn.id);

    // Release locked reserve
    const { data: cfg } = await supabase.from('config').select('current_reserve').single();
    if (cfg) {
      await supabase
        .from('config')
        .update({ current_reserve: Number(cfg.current_reserve) + Number(txn.ecstasy_payout || 0) })
        .eq('id', 1);
    }

    if (txn.torn_id) {
      await syncClientStats(supabase, txn.torn_id);
    }
  }
}

// ── Route handlers ───────────────────────────────────────────────────

async function handleValidatePlayer(body: any) {
  const { key } = body;
  if (!key) return json({ error: 'Missing API key' }, 400);

  const url = `${TORN_API}/user/?selections=basic,profile&key=${key}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.error) {
    return json({ error: `Torn API: ${data.error.error}` }, 400);
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

  // Determine tier based on consecutive clean streak
  const { data: playerHistory } = await supabase
    .from('transactions')
    .select('status, created_at')
    .eq('torn_id', String(torn_id))
    .in('status', ['closed_clean', 'od_xanax', 'od_ecstasy', 'payout_sent']);

  const cleanCount = computeCleanStreak(playerHistory || []);

  let tierMargin;
  if (cleanCount >= 5) tierMargin = Number(config.margin_legend);
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
    })
    .select('id, status, suggested_price, product_type')
    .single();

  if (txnErr) return json({ error: txnErr.message }, 500);

  // Lock worst-case liability from reserve for this new active sale
  await supabase
    .from('config')
    .update({ current_reserve: reserve - ecstasyPayout })
    .eq('id', 1);

  // Await email so it completes before the isolate shuts down
  const tier = computeTier(cleanCount);
  const productLabels: Record<string, string> = {
    package: 'La Bella Vita (Package)',
    insurance: 'Protezione Totale (Full Shield)',
    ecstasy_only: "L'Ultimo Miglio (Ecstasy Only)",
  };
  const productLabel = productLabels[productType] || 'Package';
  await sendNotificationEmail(
    `🛒 New ${productLabel} Request — ${torn_name} [${torn_id}]`,
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
      .select('torn_id, torn_name, torn_faction, torn_level, clean_count, tier, total_spent, total_payouts, transaction_count, is_blocked, first_seen_at, updated_at')
      .eq('torn_id', String(torn_id))
      .maybeSingle(),
  ]);

  if (txnResult.error) return json({ error: txnResult.error.message }, 500);

  const transactions = txnResult.data || [];
  const cleanCount = computeCleanStreak(transactions);
  const hasActiveDeal = transactions.some(
    (t: any) => ['requested', 'purchased', 'od_xanax', 'od_ecstasy'].includes(t.status),
  );

  return json({
    torn_id: String(torn_id),
    transactions,
    clean_count: cleanCount,
    has_active_deal: hasActiveDeal,
    is_blocked: clientResult.data?.is_blocked ?? false,
    client: clientResult.data || null,
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
    .select('torn_id, xanax_payout, ecstasy_payout, payout_amount')
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

  // Reserve management: release lock on close/payout/reject
  // Wrapped in try/catch so a failure here doesn't prevent client stats sync
  if (new_status === 'closed_clean' || new_status === 'payout_sent' || new_status === 'rejected') {
    try {
      const { data: cfg } = await supabase.from('config').select('current_reserve').single();
      if (cfg) {
        let newReserve = Number(cfg.current_reserve);
        const ecsP = Number(txnRecord.ecstasy_payout || 0);
        if (new_status === 'closed_clean' || new_status === 'rejected') {
          newReserve += ecsP;
        }
        if (new_status === 'payout_sent') {
          // Re-read payout_amount from the just-updated transaction
          const payAmt = new_status === 'payout_sent'
            ? Number(updates.payout_amount || txnRecord.payout_amount || 0)
            : 0;
          newReserve += ecsP - payAmt;
        }
        await supabase.from('config').update({ current_reserve: newReserve }).eq('id', 1);
        console.log(`[admin-update-status] Reserve updated: +${new_status === 'payout_sent' ? ecsP - Number(updates.payout_amount || txnRecord.payout_amount || 0) : ecsP} for txn ${txn_id}`);
      }
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

  // Reject each pending transaction and release reserve
  for (const txn of (pending || [])) {
    await supabase
      .from('transactions')
      .update({ status: 'rejected', closed_at: now })
      .eq('id', txn.id);

    // Release locked reserve
    const { data: cfg } = await supabase.from('config').select('current_reserve').single();
    if (cfg) {
      await supabase
        .from('config')
        .update({ current_reserve: Number(cfg.current_reserve) + Number(txn.ecstasy_payout || 0) })
        .eq('id', 1);
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
  const stripHtml = (s: string) => s.replace(/<[^>]*>/g, '');

  // Verify OD via events log — works for both Xanax (hospitalizes) and Ecstasy (does NOT hospitalize).
  // We always use the events log so we can capture the event timestamp for replay prevention.
  const purchasedAt = txn.purchased_at ? new Date(txn.purchased_at) : null;
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
    // Sort by timestamp descending so we find the most recent OD first
    events.sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0));
    for (const evt of events) {
      // Strip HTML tags — Torn API event text contains <a> tags etc.
      const evtText = stripHtml(evt.event || '').toLowerCase();
      if (evtText.includes('overdos')) {
        if (evtText.includes('xanax')) { odDrug = 'xanax'; odEventTimestamp = evt.timestamp; break; }
        if (evtText.includes('ecstasy')) { odDrug = 'ecstasy'; odEventTimestamp = evt.timestamp; break; }
      }
    }
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
    `⚠️ OD Payout Request — ${identData.name} [${tornId}] — ${drugLabel}`,
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

  // Fetch operator profile using operator's own API key
  const operatorKey = Deno.env.get('TORN_API_KEY');
  if (!operatorKey) {
    return json({ error: 'Operator API key not configured. Contact Giro.' }, 500);
  }
  const opRes = await fetch(`${TORN_API}/user/?selections=basic&key=${operatorKey}`);
  const opData = await opRes.json();
  if (opData.error || !opData.name) {
    return json({ error: 'Could not fetch operator profile. Contact Giro.' }, 500);
  }
  const operatorName: string = opData.name;
  const operatorTornId: string = String(opData.player_id);

  // Fetch client's events since transaction creation
  const createdAt = txn.created_at ? new Date(txn.created_at) : null;
  const fromTs = createdAt ? Math.floor(createdAt.getTime() / 1000) : undefined;
  const eventsUrl = fromTs
    ? `${TORN_API}/user/?selections=events&from=${fromTs}&key=${api_key}`
    : `${TORN_API}/user/?selections=events&key=${api_key}`;
  const eventsRes = await fetch(eventsUrl);
  const eventsData = await eventsRes.json();

  const stripHtml = (s: string) => s.replace(/<[^>]*>/g, '');
  const expectedAmount = Number(txn.suggested_price);
  const previouslyPaid = Number(txn.amount_paid || 0);
  let totalPaid = 0;
  const matchedEvents: string[] = [];

  if (!eventsData.error && eventsData.events) {
    const events = Object.values(eventsData.events) as any[];

    for (const evt of events) {
      const evtText = stripHtml(evt.event || '');
      const evtLower = evtText.toLowerCase();

      // Match money-send events: look for "sent" + operator name or operator ID
      // Torn event format (sender side): "You sent $X to [PlayerName]"
      const isSendEvent = evtLower.includes('sent') && evtLower.includes('$');
      if (!isSendEvent) continue;

      // Check if the event mentions the operator (by name or ID)
      const mentionsOperator =
        (operatorName && evtLower.includes(operatorName.toLowerCase())) ||
        evtText.includes(String(operatorTornId));

      if (!mentionsOperator) continue;

      // Extract dollar amount from event text — format: "$1,234,567" or "$1234567"
      const amountMatch = evtText.match(/\$([0-9,]+)/);
      if (!amountMatch) continue;

      const eventAmount = Number(amountMatch[1].replace(/,/g, ''));
      totalPaid += eventAmount;
      matchedEvents.push(evtText);
    }
  }

  // No payments found at all
  if (totalPaid === 0) {
    return json({
      verified: false,
      detail: `Could not find any payment to Giro. If you just sent the money, wait a moment and try again.`,
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
    `💰 Payment Verified — ${identData.name} [${tornId}]`,
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

// ── Public stats ─────────────────────────────────────────────────────

async function handleGetPublicStats() {
  const sb = serviceClient();

  // Count unique customers (distinct torn_id) with at least one completed transaction
  const { data: customers, error: custErr } = await sb
    .from('transactions')
    .select('torn_id', { count: 'exact', head: true })
    .in('status', ['purchased', 'closed_clean', 'od_xanax', 'od_ecstasy', 'payout_sent']);

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

  if (custErr || jumpErr || payErr) {
    return json({ error: 'Failed to fetch stats' }, 500);
  }

  // Count distinct torn_ids for unique customers
  const { data: distinctCustomers, error: distErr } = await sb
    .from('transactions')
    .select('torn_id')
    .in('status', ['purchased', 'closed_clean', 'od_xanax', 'od_ecstasy', 'payout_sent']);

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
      case 'verify-payment':
        return await handleVerifyPayment(body);
      case 'admin-sync-all-clients':
        return await handleAdminSyncAllClients(req);
      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    return json({ error: err.message }, 500);
  }
});
