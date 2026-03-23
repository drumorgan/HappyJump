// Gateway — single entry point for all Happy Jump edge function calls.
// Deployed with --no-verify-jwt. Routes requests by `action` field.
// Admin actions (update-config) verify auth internally.

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

// ── Email notifications ─────────────────────────────────────────────

async function sendNotificationEmail(subject: string, body: string) {
  const host = Deno.env.get('SMTP_HOST');
  const user = Deno.env.get('SMTP_USER');
  const pass = Deno.env.get('SMTP_PASS');
  const notify = Deno.env.get('NOTIFY_EMAIL');

  if (!host || !user || !pass || !notify) return;

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
  } catch (e) {
    console.error('Email notification failed:', e);
  }
}

function formatMoney(amount: number): string {
  return '$' + amount.toLocaleString('en-US');
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

  // Calculate costs
  const packageCost = 4 * config.xanax_price + 5 * config.edvd_price + config.ecstasy_price;
  const xanaxPayout = 4 * config.xanax_price + config.rehab_bonus;
  const ecstasyPayout = packageCost + config.rehab_bonus;

  // Check availability
  const maxPackages = Math.floor(config.current_reserve / ecstasyPayout);
  const { count: activeCount } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .in('status', ['requested', 'purchased']);

  const available = maxPackages - (activeCount || 0);
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
  const pXanOd = 1 - Math.pow(1 - Number(config.xanax_od_pct), 4);
  const pEcsOd = Math.pow(1 - Number(config.xanax_od_pct), 4) * Number(config.ecstasy_od_pct);
  const expectedLiability = pXanOd * xanaxPayout + pEcsOd * ecstasyPayout;
  const trueCost = packageCost + expectedLiability;
  const suggestedPrice = Math.round(trueCost / (1 - tierMargin));

  // Insert transaction
  const { data: txn, error: txnErr } = await supabase
    .from('transactions')
    .insert({
      torn_id, torn_name, torn_faction, torn_level,
      status: 'requested',
      package_cost: packageCost,
      suggested_price: suggestedPrice,
      xanax_payout: xanaxPayout,
      ecstasy_payout: ecstasyPayout,
    })
    .select('id, status, suggested_price')
    .single();

  if (txnErr) return json({ error: txnErr.message }, 500);

  // Fire-and-forget email notification for new purchase request
  const tier = computeTier(cleanCount);
  sendNotificationEmail(
    `🛒 New Purchase Request — ${torn_name} [${torn_id}]`,
    [
      `New Happy Jump purchase request!`,
      ``,
      `Player: ${torn_name} [${torn_id}]`,
      `Faction: ${torn_faction || 'None'}`,
      `Level: ${torn_level || 'Unknown'}`,
      `Tier: ${tier} (${cleanCount} clean closes)`,
      ``,
      `Package Price: ${formatMoney(suggestedPrice)}`,
      `Package Cost: ${formatMoney(packageCost)}`,
      ``,
      `Transaction ID: ${txn.id}`,
      ``,
      `Log in to the admin dashboard to mark as purchased.`,
    ].join('\n'),
  );

  // Upsert client record
  const { data: allTxns } = await supabase
    .from('transactions')
    .select('status, suggested_price, payout_amount, created_at')
    .eq('torn_id', String(torn_id));

  const txns = allTxns || [];
  const finalCleanCount = computeCleanStreak(txns);
  const txnCount = txns.length;
  const totalSpent = txns
    .filter((t: any) => ['closed_clean', 'payout_sent'].includes(t.status))
    .reduce((s: number, t: any) => s + (t.suggested_price || 0), 0);
  const totalPayouts = txns
    .filter((t: any) => t.status === 'payout_sent')
    .reduce((s: number, t: any) => s + (t.payout_amount || 0), 0);

  await supabase.from('clients').upsert({
    torn_id: String(torn_id),
    torn_name,
    torn_faction: torn_faction || null,
    torn_level: torn_level || null,
    clean_count: finalCleanCount,
    tier: computeTier(finalCleanCount),
    transaction_count: txnCount,
    total_spent: totalSpent,
    total_payouts: totalPayouts,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'torn_id' });

  return json(txn, 201);
}

async function handleGetPlayerTransactions(body: any) {
  const { torn_id } = body;
  if (!torn_id) return json({ error: 'Missing torn_id' }, 400);

  const supabase = serviceClient();

  const [txnResult, clientResult] = await Promise.all([
    supabase
      .from('transactions')
      .select('id, status, package_cost, suggested_price, xanax_payout, ecstasy_payout, payout_amount, purchased_at, closes_at, closed_at, created_at')
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
    (t: any) => t.status === 'requested' || t.status === 'purchased',
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

  const { data: config, error: configErr } = await supabase
    .from('config')
    .select('*')
    .single();

  if (configErr || !config) return json({ error: 'Failed to load config' }, 500);

  const packageCost = 4 * config.xanax_price + 5 * config.edvd_price + config.ecstasy_price;
  const ecstasyPayout = packageCost + config.rehab_bonus;
  const maxPackages = Math.floor(config.current_reserve / ecstasyPayout);

  const { count: activeCount } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .in('status', ['requested', 'purchased']);

  const available = Math.max(0, maxPackages - (activeCount || 0));

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

  return json({ available, maxPackages, activeCount: activeCount || 0, nextCloseAt });
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
    .select('id, torn_id, purchased_at, closes_at, status, xanax_payout, ecstasy_payout')
    .eq('id', txn_id)
    .single();

  if (txnErr || !txn) return json({ error: 'Transaction not found' }, 404);
  if (txn.torn_id !== tornId) return json({ error: 'This transaction does not belong to you' }, 403);
  if (txn.status !== 'purchased') return json({ error: 'Transaction is not in active insurance window' }, 400);

  // Check the player's current status for OD
  const status = (identData.status?.description || '').toLowerCase();
  const state = (identData.status?.state || '').toLowerCase();

  const isHospitalized = state === 'hospital';
  const odMatch = status.match(/overdos\w*\s+on\s+(\w+)/i);
  const odDrug = odMatch ? odMatch[1].toLowerCase() : null;

  if (!isHospitalized || !odDrug) {
    return json({
      verified: false,
      detail: `Could not verify OD. Current status: "${identData.status?.description || 'unknown'}". You must report while still hospitalized from the OD.`,
    });
  }

  if (odDrug !== 'xanax' && odDrug !== 'ecstasy') {
    return json({
      verified: false,
      detail: `Overdose detected on ${odDrug}, which is not covered by Happy Jump insurance.`,
    });
  }

  // Verified — update the transaction
  const odStatus = odDrug === 'xanax' ? 'od_xanax' : 'od_ecstasy';
  const payoutAmount = odDrug === 'xanax' ? txn.xanax_payout : txn.ecstasy_payout;

  const { error: updateErr } = await supabase
    .from('transactions')
    .update({ status: odStatus, payout_amount: payoutAmount })
    .eq('id', txn_id);

  if (updateErr) return json({ error: updateErr.message }, 500);

  // Sync client stats (clean streak recomputed from transactions)
  const { data: allTxns } = await supabase
    .from('transactions')
    .select('status, suggested_price, payout_amount, created_at')
    .eq('torn_id', tornId);

  const txns = allTxns || [];
  const cleanCount = computeCleanStreak(txns);
  const txnCount = txns.length;
  const totalSpent = txns
    .filter((t: any) => ['closed_clean', 'payout_sent'].includes(t.status))
    .reduce((s: number, t: any) => s + (t.suggested_price || 0), 0);
  const totalPayouts = txns
    .filter((t: any) => t.status === 'payout_sent')
    .reduce((s: number, t: any) => s + (t.payout_amount || 0), 0);

  await supabase.from('clients').upsert({
    torn_id: tornId,
    torn_name: identData.name,
    clean_count: cleanCount,
    tier: computeTier(cleanCount),
    transaction_count: txnCount,
    total_spent: totalSpent,
    total_payouts: totalPayouts,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'torn_id' });

  const drugLabel = odDrug === 'xanax' ? 'Xanax' : 'Ecstasy';

  // Fire-and-forget email notification for OD payout request
  sendNotificationEmail(
    `⚠️ OD Payout Request — ${identData.name} [${tornId}] — ${drugLabel}`,
    [
      `OD verified and payout required!`,
      ``,
      `Player: ${identData.name} [${tornId}]`,
      `OD Type: ${drugLabel}`,
      `Payout Amount: ${formatMoney(payoutAmount)}`,
      ``,
      `Transaction ID: ${txn_id}`,
      ``,
      `Log in to the admin dashboard to send the payout.`,
    ].join('\n'),
  );

  return json({
    verified: true,
    od_type: odStatus,
    detail: `OD on ${drugLabel} verified. Giro has been notified and will send your payout.`,
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
      case 'update-config':
        return await handleUpdateConfig(req, body);
      case 'report-od':
        return await handleReportOd(body);
      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    return json({ error: err.message }, 500);
  }
});
