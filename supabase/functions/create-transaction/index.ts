// Create Transaction — inserts a new transaction with price snapshots.
// Uses service role to bypass RLS for reading config + inserting transaction.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

    // Calculate price snapshots
    const packageCost =
      4 * config.xanax_price + 5 * config.edvd_price + config.ecstasy_price;
    const xanaxPayout = 4 * config.xanax_price + config.rehab_bonus;
    const ecstasyPayout = packageCost + config.rehab_bonus;

    const pXanOd = 1 - Math.pow(1 - Number(config.xanax_od_pct), 4);
    const pEcsOd = Math.pow(1 - Number(config.xanax_od_pct), 4) * Number(config.ecstasy_od_pct);
    const expectedLiability = pXanOd * xanaxPayout + pEcsOd * ecstasyPayout;
    const trueCost = packageCost + expectedLiability;
    const suggestedPrice = Math.round(trueCost / (1 - tierMargin));

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
    let tierMargin;
    if (cleanCount >= 5) tierMargin = 0.10;
    else if (cleanCount >= 3) tierMargin = 0.12;
    else if (cleanCount >= 1) tierMargin = 0.15;
    else tierMargin = 0.18;

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
