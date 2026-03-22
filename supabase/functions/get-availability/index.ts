// Get Availability — returns package availability and next expected restock date.
// Uses service role to accurately count active transactions (anon RLS blocks reads).

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
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Fetch config
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

    const packageCost =
      4 * config.xanax_price + 5 * config.edvd_price + config.ecstasy_price;
    const ecstasyPayout = packageCost + config.rehab_bonus;
    const maxPackages = Math.floor(config.current_reserve / ecstasyPayout);

    // Count active transactions
    const { count: activeCount } = await supabase
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .in('status', ['requested', 'purchased']);

    const available = Math.max(0, maxPackages - (activeCount || 0));

    // If sold out, find the earliest closes_at among purchased deals
    // (requested deals don't have a closes_at yet since the timer hasn't started)
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

    return new Response(
      JSON.stringify({
        available,
        maxPackages,
        activeCount: activeCount || 0,
        nextCloseAt,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
