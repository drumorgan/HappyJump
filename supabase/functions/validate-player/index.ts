// Validate Player — verifies a client's Torn identity via their API key.
// Returns player info for confirmation. Key is used once, never stored.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

const TORN_API = 'https://api.torn.com';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { key } = await req.json();

    if (!key) {
      return new Response(
        JSON.stringify({ error: 'Missing API key' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Fetch basic player info from Torn API
    const url = `${TORN_API}/user/?selections=basic,profile&key=${key}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      return new Response(
        JSON.stringify({ error: `Torn API: ${data.error.error}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Return only the fields we need — no sensitive data
    const player = {
      torn_id: String(data.player_id),
      torn_name: data.name,
      torn_faction: data.faction?.faction_name || null,
      torn_level: data.level,
      status: data.status?.description || 'Unknown',
    };

    return new Response(JSON.stringify(player), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
