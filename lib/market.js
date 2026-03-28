/**
 * market.js — CoinGecko data fetching + candle building.
 *
 * Uses the hourly endpoint (days=7, interval=hourly) which is more
 * rate-limit-friendly on CoinGecko's free tier and gives 168 candles —
 * plenty for BB(20) + RSI(14). We scan every 30 min to catch new candles
 * promptly; the signal logic handles duplicate checks via position guards.
 */

import fetch from 'node-fetch';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const RETRY_DELAYS   = [5000, 15000, 30000]; // backoff for 429s

/**
 * Fetch with exponential backoff on 429 rate-limit responses.
 * @param {string} url
 * @param {object} options
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options = {}) {
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;

    if (attempt < RETRY_DELAYS.length) {
      const delay = RETRY_DELAYS[attempt];
      console.warn(`[market] Rate limited (429). Retrying in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    } else {
      return res; // return the 429 so caller can throw
    }
  }
}

/**
 * Fetch 7 days of hourly closes from CoinGecko.
 * Returns ~168 hourly price points — oldest first.
 *
 * @param {string} geckoId  — e.g. "solana"
 * @returns {Promise<number[]>}
 */
export async function fetchCloses(geckoId) {
  const url = `${COINGECKO_BASE}/coins/${geckoId}/market_chart?vs_currency=usd&days=7&interval=hourly`;

  const res = await fetchWithRetry(url, { headers: { Accept: 'application/json' } });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CoinGecko fetch failed for ${geckoId}: ${res.status} ${text}`);
  }

  const data = await res.json();

  if (!data.prices || !Array.isArray(data.prices)) {
    throw new Error(`Unexpected CoinGecko response for ${geckoId}`);
  }

  // [[timestamp_ms, price], ...] — use price as hourly close
  return data.prices.map(([, price]) => price);
}

/**
 * Get the current (latest) price for a token.
 * @param {string} geckoId
 * @returns {Promise<number>}
 */
export async function fetchCurrentPrice(geckoId) {
  const closes = await fetchCloses(geckoId);
  return closes[closes.length - 1];
}
