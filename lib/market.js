/**
 * market.js — CoinGecko data fetching + candle building.
 */

import fetch from 'node-fetch';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

/**
 * Fetch hourly price data from CoinGecko for a token.
 * Returns the last `days` days of hourly closes.
 *
 * @param {string} geckoId  — e.g. "solana"
 * @param {number} days     — how many days of data to fetch (default 7)
 * @returns {Promise<number[]>}  array of close prices, oldest first
 */
export async function fetchCloses(geckoId, days = 7) {
  const url = `${COINGECKO_BASE}/coins/${geckoId}/market_chart?vs_currency=usd&days=${days}&interval=hourly`;

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CoinGecko fetch failed for ${geckoId}: ${res.status} ${text}`);
  }

  const data = await res.json();

  if (!data.prices || !Array.isArray(data.prices)) {
    throw new Error(`Unexpected CoinGecko response for ${geckoId}`);
  }

  // data.prices is [[timestamp_ms, price], ...]
  // Use the price as the "close" for each hourly candle
  return data.prices.map(([, price]) => price);
}

/**
 * Get the current (latest) price for a token.
 * @param {string} geckoId
 * @returns {Promise<number>}
 */
export async function fetchCurrentPrice(geckoId) {
  const closes = await fetchCloses(geckoId, 1);
  return closes[closes.length - 1];
}
