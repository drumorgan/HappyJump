// Get Player Transactions — returns a player's transaction history and client record.
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

    // Fetch transactions and client record in parallel
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

    if (txnResult.error) {
      return new Response(
        JSON.stringify({ error: txnResult.error.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const transactions = txnResult.data || [];

    // Calculate stats (fallback if client record doesn't exist yet)
    const cleanCount = transactions.filter(
      (t: any) => t.status === 'closed_clean'
    ).length;

    const hasActiveDeal = transactions.some(
      (t: any) => t.status === 'requested' || t.status === 'purchased'
    );

    return new Response(
      JSON.stringify({
        torn_id: String(torn_id),
        transactions,
        clean_count: clientResult.data?.clean_count ?? cleanCount,
        has_active_deal: hasActiveDeal,
        is_blocked: clientResult.data?.is_blocked ?? false,
        client: clientResult.data || null,
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
