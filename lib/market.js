/**
 * market.js — CoinGecko data fetching + 30-min candle building.
 *
 * CoinGecko's free API returns ~5-min data points when days=1.
 * We bucket those into 30-min candles and use the last price in
 * each bucket as the "close". This gives ~48 candles per day —
 * plenty for BB(20) + RSI(14).
 */

import fetch from 'node-fetch';

const COINGECKO_BASE  = 'https://api.coingecko.com/api/v3';
const CANDLE_MINUTES  = 30;
const CANDLE_MS       = CANDLE_MINUTES * 60 * 1000;

/**
 * Bucket raw [timestamp, price] pairs into N-minute candles.
 * Each bucket's close = last price in that bucket.
 *
 * @param {[number, number][]} prices  — [[timestamp_ms, price], ...]
 * @param {number} bucketMs            — bucket width in milliseconds
 * @returns {number[]}                 — array of close prices, oldest first
 */
export function bucketCloses(prices, bucketMs = CANDLE_MS) {
  if (!prices.length) return [];

  const buckets = new Map();

  for (const [ts, price] of prices) {
    const key = Math.floor(ts / bucketMs) * bucketMs;
    buckets.set(key, price); // last price in bucket wins (close)
  }

  return [...buckets.keys()]
    .sort((a, b) => a - b)
    .map(k => buckets.get(k));
}

/**
 * Fetch ~5-min price data from CoinGecko and return 30-min candle closes.
 * Uses days=1 to get the fine-grained data CoinGecko auto-returns.
 *
 * @param {string} geckoId  — e.g. "solana"
 * @param {number} days     — days of data (default 2 gives ~2 days of 5-min points)
 * @returns {Promise<number[]>}  array of 30-min close prices, oldest first
 */
export async function fetchCloses(geckoId, days = 2) {
  // No `interval` param — CoinGecko auto-returns ~5-min granularity for days≤1,
  // and ~hourly for days 2–90. We fetch 1 day to get granular points.
  const url = `${COINGECKO_BASE}/coins/${geckoId}/market_chart?vs_currency=usd&days=1`;

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

  return bucketCloses(data.prices, CANDLE_MS);
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
