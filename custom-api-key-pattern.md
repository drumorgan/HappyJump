# Custom API Key Pattern — Reference for Reuse

Extracted from the HappyJump project for use in other Torn City applications.

---

## 1. Pre-Filled Key Creation Link

Direct users to Torn's API preferences with permissions pre-selected:

```
https://www.torn.com/preferences.php#tab=api?step=addNewKey&user=basic,profile,events,log&torn=items&title=YourAppName
```

**URL Parameters:**
- `step=addNewKey` — opens the "create new key" form
- `user=basic,profile,events,log` — pre-selects user-scope permissions
- `torn=items` — pre-selects torn-scope permissions
- `title=YourAppName` — pre-fills the key name

Adjust `user=` and `torn=` to match your app's needs. Available scopes are listed on Torn's API docs.

**HTML example:**
```html
<a href="https://www.torn.com/preferences.php#tab=api?step=addNewKey&user=basic,profile,events,log&torn=items&title=YourAppName"
   target="_blank" rel="noopener">
  Create a Custom Key
</a>
```

---

## 2. Client-Side API Helper (Vanilla JS + Supabase)

All API calls route through a single Edge Function ("gateway") so user keys never touch client-side code beyond the initial form input.

```js
// api.js — All calls route through a single gateway Edge Function.

import { supabase } from './supabaseClient.js';

/**
 * Call the gateway Edge Function with a given action + payload.
 */
async function gateway(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke('gateway', {
    body: { ...payload, action },
  });

  if (error) {
    // Extract real message from ReadableStream if present
    if (error.context?.body instanceof ReadableStream) {
      const text = await new Response(error.context.body).text();
      try {
        const parsed = JSON.parse(text);
        throw new Error(parsed.error || parsed.message || text);
      } catch (e) {
        if (e instanceof SyntaxError) throw new Error(text);
        throw e;
      }
    }
    throw new Error(error.message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

/**
 * Validate a player's identity via their Torn API key.
 */
export async function validatePlayer(apiKey) {
  return gateway('validate-player', { key: apiKey });
}

/**
 * Proxy a Torn API call through the gateway.
 */
export async function fetchTornProxy(apiKey, section, id, selections) {
  const data = await gateway('torn-proxy', { key: apiKey, section, id, selections });
  if (data.error) {
    const err = data.error;
    throw new Error(typeof err === 'string' ? err : `Torn API error ${err.code}: ${err.error}`);
  }
  return data;
}

/**
 * Test that an API key has the required permissions.
 */
export async function testApiAccess(apiKey) {
  return gateway('test-api-access', { api_key: apiKey });
}
```

---

## 3. Gateway Edge Function (Supabase/Deno)

Single Edge Function that handles all server-side logic. JWT verification is OFF — public actions have no auth, admin actions verify auth internally.

```ts
// supabase/functions/gateway/index.ts

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

function serviceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
}

// ── Validate Player ─────────────────────────────────────────────────

async function handleValidatePlayer(body: any) {
  const { key } = body;
  if (!key) return json({ error: 'Missing API key' }, 400);

  // Fetch basic info and verify events+log permissions in parallel
  const [basicRes, eventsRes] = await Promise.all([
    fetch(`${TORN_API}/user/?selections=basic,profile&key=${key}`),
    fetch(`${TORN_API}/user/?selections=events,log&limit=1&key=${key}`),
  ]);
  const [data, eventsData] = await Promise.all([basicRes.json(), eventsRes.json()]);

  if (data.error) {
    return json({ error: `Torn API: ${data.error.error}` }, 400);
  }

  // If events/log check fails, the key doesn't have sufficient permissions
  if (eventsData.error) {
    return json({
      error: 'Your API key is missing required permissions. Please create a new key with the required access enabled.',
    }, 400);
  }

  return json({
    torn_id: String(data.player_id),
    torn_name: data.name,
    torn_faction: data.faction?.faction_name || null,
    torn_level: data.level,
    status: data.status?.description || 'Unknown',
  });
}

// ── Torn API Proxy ──────────────────────────────────────────────────

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

// ── Test API Access ─────────────────────────────────────────────────

async function handleTestApiAccess(body: any) {
  const { api_key } = body;
  if (!api_key) return json({ error: 'Missing api_key' }, 400);

  const results: Record<string, { ok: boolean; detail: string }> = {};

  // Test basic,profile access
  const basicRes = await fetch(`${TORN_API}/user/?selections=basic,profile&key=${api_key}`);
  const basicData = await basicRes.json();
  if (basicData.error) {
    results.basic = { ok: false, detail: basicData.error.error || 'Unknown error' };
  } else {
    results.basic = { ok: true, detail: `${basicData.name} [${basicData.player_id}]` };
  }

  // Test events access
  const eventsRes = await fetch(`${TORN_API}/user/?selections=events&limit=1&key=${api_key}`);
  const eventsData = await eventsRes.json();
  if (eventsData.error) {
    results.events = { ok: false, detail: eventsData.error.error || 'Unknown error' };
  } else {
    results.events = { ok: true, detail: 'Events access confirmed' };
  }

  // Test log access
  const logRes = await fetch(`${TORN_API}/user/?selections=log&limit=1&key=${api_key}`);
  const logData = await logRes.json();
  if (logData.error) {
    results.log = { ok: false, detail: logData.error.error || 'Unknown error' };
  } else {
    results.log = { ok: true, detail: 'Log access confirmed' };
  }

  const allOk = results.basic.ok && results.events.ok && results.log.ok;
  return json({ ok: allOk, results });
}

// ── Main Router ─────────────────────────────────────────────────────

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
      case 'test-api-access':
        return await handleTestApiAccess(body);
      // Add your app-specific actions here...
      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    return json({ error: err.message }, 500);
  }
});
```

---

## 4. Key Design Principles

1. **Keys never stored** — API key is used once server-side for validation, then discarded.
2. **Single gateway** — All server logic in one Edge Function, routed by `action` field. No separate functions.
3. **Proxy pattern** — Client sends `{ action, key, ... }` to gateway; gateway calls Torn API; returns result. Client never calls Torn API directly.
4. **Permission validation** — On first use, test that the key has all required scopes (basic, events, log, etc.). If not, show a helpful error with the pre-filled creation link.
5. **CORS open** — Gateway allows all origins since it's a public storefront. Restrict if needed.
6. **Bigint gotcha** — Supabase returns `bigint` columns as strings. Always wrap in `Number()` before arithmetic.

---

## 5. Supabase Client Setup

```js
// supabaseClient.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const supabase = createClient(
  'https://YOUR_PROJECT.supabase.co',
  'YOUR_ANON_KEY'  // public anon key only — reads only, no writes from client
);
```

---

## 6. Adapting for Your App

1. Change `title=YourAppName` in the key creation URL
2. Adjust `user=` and `torn=` scopes to what your app needs
3. Add your app-specific gateway actions (e.g., matching, swiping, messaging)
4. Keep the same proxy + validate pattern — it's battle-tested
