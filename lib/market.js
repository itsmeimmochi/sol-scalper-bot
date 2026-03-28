/**
 * market.js — CoinGecko data fetching with smart caching.
 *
 * API call strategy (stays well within free tier limits):
 *   - Startup + every 2h: fetch full 7-day history per token (8 calls, 10s apart)
 *   - Every 30-min scan: ONE batch call to /simple/price for all tokens,
 *     append to in-memory cache — no per-token calls during normal scans
 *
 * This drops from ~16 calls/hour to ~2 calls/hour.
 */

import fetch from 'node-fetch';

const COINGECKO_BASE     = 'https://api.coingecko.com/api/v3';
const HISTORY_TTL_MS     = 2 * 60 * 60 * 1000; // refresh full history every 2h
const INTER_REQUEST_MS   = 10_000;              // 10s between individual history fetches

// In-memory cache: geckoId → { closes: number[], fetchedAt: number }
const _cache = new Map();
let _lastFullFetch = 0;

/** Sleep helper */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Fetch with basic retry on 429.
 * Waits 60s on rate limit (one clean retry only — if history TTL is 2h, this is rare).
 */
async function safeFetch(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 429) {
    console.warn('[market] Rate limited (429) — waiting 60s before retry...');
    await sleep(60_000);
    const retry = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!retry.ok) {
      const text = await retry.text();
      throw new Error(`CoinGecko fetch failed: ${retry.status} ${text}`);
    }
    return retry;
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CoinGecko fetch failed: ${res.status} ${text}`);
  }
  return res;
}

/**
 * Fetch 7-day hourly history for a single token.
 * Called only during full refresh cycles, with delays between tokens.
 * @param {string} geckoId
 * @returns {Promise<number[]>} closes, oldest first
 */
async function fetchHistory(geckoId) {
  const url = `${COINGECKO_BASE}/coins/${geckoId}/market_chart?vs_currency=usd&days=7&interval=hourly`;
  const res  = await safeFetch(url);
  const data = await res.json();

  if (!data.prices || !Array.isArray(data.prices)) {
    throw new Error(`Unexpected CoinGecko response for ${geckoId}`);
  }

  return data.prices.map(([, price]) => price);
}

/**
 * Batch-fetch current prices for all tokens in ONE API call.
 * @param {string[]} geckoIds
 * @returns {Promise<Map<string, number>>} geckoId → current price
 */
async function fetchCurrentPrices(geckoIds) {
  const ids = geckoIds.join(',');
  const url = `${COINGECKO_BASE}/simple/price?ids=${ids}&vs_currencies=usd`;
  const res  = await safeFetch(url);
  const data = await res.json();

  const result = new Map();
  for (const id of geckoIds) {
    if (data[id]?.usd != null) {
      result.set(id, data[id].usd);
    }
  }
  return result;
}

/**
 * Full history refresh — fetches all tokens one by one with a delay.
 * Called at startup and every HISTORY_TTL_MS thereafter.
 * @param {string[]} geckoIds
 */
export async function refreshHistory(geckoIds) {
  console.log(`[market] Refreshing full history for ${geckoIds.length} tokens (10s between each)...`);
  for (let i = 0; i < geckoIds.length; i++) {
    const id = geckoIds[i];
    try {
      const closes = await fetchHistory(id);
      _cache.set(id, { closes, fetchedAt: Date.now() });
      console.log(`[market] History loaded: ${id} (${closes.length} candles)`);
    } catch (e) {
      console.error(`[market] Failed to fetch history for ${id}: ${e.message}`);
    }
    if (i < geckoIds.length - 1) await sleep(INTER_REQUEST_MS);
  }
  _lastFullFetch = Date.now();
}

/**
 * Update all cached closes with fresh current prices (1 API call total).
 * Appends the current price as the latest data point.
 * @param {string[]} geckoIds
 * @returns {Promise<Map<string, number>>} geckoId → current price
 */
export async function updateCurrentPrices(geckoIds) {
  const prices = await fetchCurrentPrices(geckoIds);
  for (const [id, price] of prices) {
    const entry = _cache.get(id);
    if (entry) {
      entry.closes = [...entry.closes, price];
      // Keep max 200 closes to avoid unbounded growth
      if (entry.closes.length > 200) entry.closes = entry.closes.slice(-200);
    }
  }
  return prices;
}

/**
 * Get cached closes for a token.
 * Returns null if not yet loaded.
 * @param {string} geckoId
 * @returns {number[] | null}
 */
export function getCloses(geckoId) {
  return _cache.get(geckoId)?.closes ?? null;
}

/**
 * Check if a full history refresh is due.
 * @returns {boolean}
 */
export function isHistoryStale() {
  return Date.now() - _lastFullFetch > HISTORY_TTL_MS;
}
