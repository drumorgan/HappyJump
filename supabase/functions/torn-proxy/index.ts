// Torn API Proxy — routes Torn API calls through Supabase Edge Function
// so client API keys are never exposed in browser network logs.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

const TORN_API = 'https://api.torn.com';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { key, section, id, selections } = await req.json();

    if (!key || !section) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: key, section' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const idPart = id ? `/${id}` : '';
    const selPart = selections ? `?selections=${selections}&` : '?';
    const url = `${TORN_API}/${section}${idPart}${selPart}key=${key}`;

    const res = await fetch(url);
    const data = await res.json();

    return new Response(JSON.stringify(data), {
      status: res.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
