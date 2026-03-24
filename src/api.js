// api.js — Supabase-backed API module for Happy Jump
// All calls route through the single gateway Edge Function.

import { supabase } from './supabaseClient.js';

/**
 * Call the gateway Edge Function with a given action + payload.
 * All edge function calls go through this single entry point.
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
 * Fetch the operator config row (pricing variables, reserve, etc.)
 * Public read via RLS.
 */
export async function getConfig() {
  const { data, error } = await supabase
    .from('config')
    .select('*')
    .single();

  if (error) throw new Error(`Failed to load config: ${error.message}`);
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
  // Torn API errors come in the response body, not as gateway errors
  if (data.error) {
    const err = data.error;
    throw new Error(typeof err === 'string' ? err : `Torn API error ${err.code}: ${err.error}`);
  }
  return data;
}

/**
 * Fetch market prices for Happy Jump items via the Torn API proxy.
 */
export async function fetchMarketPrices(apiKey) {
  const ITEM_IDS = { xanax: 206, ecstasy: 197, edvd: 366 };
  const data = await fetchTornProxy(apiKey, 'torn', '', 'items');

  const prices = {};
  for (const [name, id] of Object.entries(ITEM_IDS)) {
    const item = data.items?.[id];
    if (item) {
      prices[name] = {
        name: item.name,
        market_value: item.market_value,
        image: item.image,
      };
    }
  }
  return prices;
}

/**
 * Create a new transaction (request a Happy Jump package or insurance).
 * playerData should include product_type: 'package' | 'insurance'
 */
export async function createTransaction(playerData) {
  return gateway('create-transaction', playerData);
}

/**
 * Fetch a player's transaction history by torn_id.
 */
export async function getPlayerTransactions(tornId) {
  return gateway('get-player-transactions', { torn_id: String(tornId) });
}

/**
 * Get current availability: how many packages can be sold right now.
 */
export async function getAvailability() {
  return gateway('get-availability');
}

/**
 * Update operator config (admin only). Passes auth header automatically.
 */
export async function updateConfig(updates) {
  return gateway('update-config', updates);
}

/**
 * Admin: update transaction status (handles reserve + client sync server-side).
 */
export async function adminUpdateStatus(txnId, tornId, newStatus) {
  return gateway('admin-update-status', { txn_id: txnId, torn_id: tornId, new_status: newStatus });
}

/**
 * Admin: update client record (notes, blocked status).
 */
export async function adminUpdateClient(tornId, updates) {
  return gateway('admin-update-client', { torn_id: tornId, ...updates });
}

/**
 * Admin: reject all pending transactions for a player and block them.
 */
export async function adminRejectAndBlock(tornId) {
  return gateway('admin-reject-and-block', { torn_id: tornId });
}

/**
 * Report and verify an OD — client provides their API key for verification.
 */
export async function reportOd(apiKey, txnId) {
  return gateway('report-od', { api_key: apiKey, txn_id: txnId });
}

/**
 * Admin: resync all client stats from transactions (fixes stale data).
 */
export async function adminSyncAllClients() {
  return gateway('admin-sync-all-clients');
}
