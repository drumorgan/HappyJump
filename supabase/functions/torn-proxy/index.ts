// Torn API Proxy — routes Torn API calls through Supabase Edge Function
// so client API keys are never exposed in browser network logs.

const TORN_API = 'https://api.torn.com';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
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

    // Always return 200 so supabase.functions.invoke() doesn't throw.
    // Torn API errors are passed in the JSON body for the client to handle.
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
