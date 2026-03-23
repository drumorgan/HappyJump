// Create Transaction — inserts a new transaction with price snapshots.
// Uses service role to bypass RLS for reading config + inserting transaction.
// Also upserts the client record with latest player info and stats.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function computeTier(cleanCount: number): string {
  if (cleanCount >= 5) return 'legend';
  if (cleanCount >= 3) return 'road';
  if (cleanCount >= 1) return 'safe';
  return 'new';
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { torn_id, torn_name, torn_faction, torn_level } = await req.json();

    if (!torn_id || !torn_name) {
      return new Response(
        JSON.stringify({ error: 'Missing required player fields' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Use service role to access config and insert transaction
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Check if player is blocked
    const { data: client } = await supabase
      .from('clients')
      .select('is_blocked')
      .eq('torn_id', String(torn_id))
      .maybeSingle();

    if (client?.is_blocked) {
      return new Response(
        JSON.stringify({ error: 'Your account has been blocked. Contact Giro for details.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Fetch current config for price snapshots
    const { data: config, error: configErr } = await supabase
      .from('config')
      .select('*')
      .single();

    if (configErr || !config) {
      return new Response(
        JSON.stringify({ error: 'Failed to load config' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Check if player already has an active deal
    const { count: playerActiveCount } = await supabase
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('torn_id', String(torn_id))
      .in('status', ['requested', 'purchased']);

    if ((playerActiveCount || 0) > 0) {
      return new Response(
        JSON.stringify({ error: 'You already have an active deal. Wait for it to close before purchasing again.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Calculate base costs (margin-independent)
    const packageCost =
      4 * config.xanax_price + 5 * config.edvd_price + config.ecstasy_price;
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
      return new Response(
        JSON.stringify({ error: 'No packages available right now. Check back later.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Determine player's tier based on clean jump history
    const { data: playerHistory } = await supabase
      .from('transactions')
      .select('status')
      .eq('torn_id', String(torn_id))
      .eq('status', 'closed_clean');

    const cleanCount = playerHistory?.length || 0;
    const tierKey = computeTier(cleanCount);

    let tierMargin;
    if (cleanCount >= 5) tierMargin = Number(config.margin_legend);
    else if (cleanCount >= 3) tierMargin = Number(config.margin_road);
    else if (cleanCount >= 1) tierMargin = Number(config.margin_safe);
    else tierMargin = Number(config.margin_new);

    // Calculate final price with tier margin
    const pXanOd = 1 - Math.pow(1 - Number(config.xanax_od_pct), 4);
    const pEcsOd = Math.pow(1 - Number(config.xanax_od_pct), 4) * Number(config.ecstasy_od_pct);
    const expectedLiability = pXanOd * xanaxPayout + pEcsOd * ecstasyPayout;
    const trueCost = packageCost + expectedLiability;
    const suggestedPrice = Math.round(trueCost / (1 - tierMargin));

    // Insert transaction
    const { data: txn, error: txnErr } = await supabase
      .from('transactions')
      .insert({
        torn_id,
        torn_name,
        torn_faction,
        torn_level,
        status: 'requested',
        package_cost: packageCost,
        suggested_price: suggestedPrice,
        xanax_payout: xanaxPayout,
        ecstasy_payout: ecstasyPayout,
      })
      .select('id, status, suggested_price')
      .single();

    if (txnErr) {
      return new Response(
        JSON.stringify({ error: txnErr.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Upsert client record with latest player info and recalculated stats
    const { data: allTxns } = await supabase
      .from('transactions')
      .select('status, suggested_price, payout_amount')
      .eq('torn_id', String(torn_id));

    const txns = allTxns || [];
    const finalCleanCount = txns.filter((t: any) => t.status === 'closed_clean').length;
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

    return new Response(JSON.stringify(txn), {
      status: 201,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
