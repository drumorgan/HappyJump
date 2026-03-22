// Get Player Transactions — returns a player's transaction history.
// Uses service role to bypass RLS. Caller must provide torn_id.

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
    const { torn_id } = await req.json();

    if (!torn_id) {
      return new Response(
        JSON.stringify({ error: 'Missing torn_id' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Fetch all transactions for this player, newest first
    const { data: transactions, error } = await supabase
      .from('transactions')
      .select('id, status, package_cost, suggested_price, xanax_payout, ecstasy_payout, payout_amount, purchased_at, closes_at, closed_at, created_at')
      .eq('torn_id', String(torn_id))
      .order('created_at', { ascending: false });

    if (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Calculate stats
    const cleanCount = (transactions || []).filter(
      (t) => t.status === 'closed_clean'
    ).length;

    const hasActiveDeal = (transactions || []).some(
      (t) => t.status === 'requested' || t.status === 'purchased'
    );

    return new Response(
      JSON.stringify({
        torn_id: String(torn_id),
        transactions: transactions || [],
        clean_count: cleanCount,
        has_active_deal: hasActiveDeal,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
