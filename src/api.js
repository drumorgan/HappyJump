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
 * Fetch a player's transaction history by torn_id.
 * Returns transactions, clean_count, and has_active_deal.
 */
export async function getPlayerTransactions(tornId) {
  const { data, error } = await supabase.functions.invoke('get-player-transactions', {
    body: { torn_id: String(tornId) },
  });

  if (error) throw new Error(`Failed to load history: ${error.message}`);
  if (data.error) throw new Error(data.error);
  return data;
}

/**
 * Get current availability: how many packages can be sold right now.
 * Calls the get-availability Edge Function (uses service role to read transactions).
 * Returns { available, maxPackages, activeCount, nextCloseAt }.
 */
export async function getAvailability() {
  const { data, error } = await supabase.functions.invoke('get-availability');

  if (error) throw new Error(`Failed to check availability: ${error.message}`);
  if (data.error) throw new Error(data.error);
  return data;
}
