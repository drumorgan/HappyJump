// api.js — Supabase-backed API module for Happy Jump
// All Torn API calls go through Edge Functions; config comes from the database.

import { supabase } from './supabaseClient.js';

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
 * Calls the validate-player Edge Function.
 * Key is used once by the Edge Function and never stored.
 */
export async function validatePlayer(apiKey) {
  const { data, error } = await supabase.functions.invoke('validate-player', {
    body: { key: apiKey },
  });

  if (error) throw new Error(`Validation failed: ${error.message}`);
  if (data.error) throw new Error(data.error);
  return data;
}

/**
 * Proxy a Torn API call through the torn-proxy Edge Function.
 * Keeps the client's API key off browser network logs.
 */
export async function fetchTornProxy(apiKey, section, id, selections) {
  const { data, error } = await supabase.functions.invoke('torn-proxy', {
    body: { key: apiKey, section, id, selections },
  });

  if (error) throw new Error(`Torn proxy error: ${error.message}`);
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
  const ITEM_IDS = { xanax: 206, ecstasy: 197, edvd: 389 };
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
 * Create a new transaction (request a Happy Jump package).
 * Calls the create-transaction Edge Function which snapshots prices.
 */
export async function createTransaction(playerData) {
  const { data, error } = await supabase.functions.invoke('create-transaction', {
    body: playerData,
  });

  if (error) throw new Error(`Transaction failed: ${error.message}`);
  if (data.error) throw new Error(data.error);
  return data;
}

/**
 * Get current availability: how many packages can be sold right now.
 * Reads config and counts active transactions.
 */
export async function getAvailability() {
  const config = await getConfig();

  const packageCost =
    4 * config.xanax_price + 5 * config.edvd_price + config.ecstasy_price;
  const ecstasyPayout = packageCost + config.rehab_bonus;
  const maxPackages = Math.floor(config.current_reserve / ecstasyPayout);

  // Count active transactions (requested + purchased)
  const { count, error } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .in('status', ['requested', 'purchased']);

  if (error) throw new Error(`Failed to check availability: ${error.message}`);

  return {
    available: Math.max(0, maxPackages - (count || 0)),
    maxPackages,
    activeCount: count || 0,
  };
}
