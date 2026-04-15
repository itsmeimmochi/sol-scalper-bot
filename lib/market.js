/**
 * market.js — CoinGecko data fetching with DB-backed caching.
 *
 * Data strategy:
 *   - Primary cache: PostgreSQL table `market_candles_hourly`
 *   - Startup / periodic: ensure DB has enough recent hourly candles per token;
 *     only call CoinGecko for tokens that are missing/stale.
 *   - Every scan: chunked /simple/price calls for all tokens; upsert the
 *     current-hour candle and append to in-memory closes cache.
 */

import fetch from 'node-fetch';
import { getPool } from './db.js';

function coingeckoApiBase() {
  const proKey = process.env.COINGECKO_PRO_API_KEY;
  if (typeof proKey === 'string' && proKey.length > 0) {
    return 'https://pro-api.coingecko.com/api/v3';
  }
  return 'https://api.coingecko.com/api/v3';
}
const HISTORY_TTL_MS     = 2 * 60 * 60 * 1000; // refresh full history every 2h
const INTER_REQUEST_MS   = 10_000;              // 10s between individual history fetches
/** Keeps /simple/price URLs small and spreads calls across CoinGecko rate limits when tracking many tokens. */
const SIMPLE_PRICE_CHUNK_SIZE = 45;
const SIMPLE_PRICE_CHUNK_GAP_MS = 400;
const HOURS_7D = 7 * 24;
const EXPECTED_7D_POINTS = HOURS_7D + 1; // CoinGecko often returns 169 points for 7d hourly
const DB_CLOSES_LIMIT = 200;

// In-memory cache (per-process): geckoId → { closes: number[], fetchedAt: number }
const _cache = new Map();
let _lastFullFetch = 0;

/** Sleep helper */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function coinGeckoFetchHeaders() {
  const headers = { Accept: 'application/json' };
  const proKey = process.env.COINGECKO_PRO_API_KEY;
  const demoKey = process.env.COINGECKO_DEMO_API_KEY;
  if (typeof proKey === 'string' && proKey.length > 0) {
    headers['x-cg-pro-api-key'] = proKey;
  } else if (typeof demoKey === 'string' && demoKey.length > 0) {
    headers['x-cg-demo-api-key'] = demoKey;
  }
  return headers;
}

function floorToHourUtc(date) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/**
 * Fetch with basic retry on 429.
 * Waits 60s on rate limit (one clean retry only — if history TTL is 2h, this is rare).
 */
async function safeFetch(url) {
  const headers = coinGeckoFetchHeaders();
  const res = await fetch(url, { headers });
  if (res.status === 429) {
    console.warn('[market] Rate limited (429) — waiting 60s before retry...');
    await sleep(60_000);
    const retry = await fetch(url, { headers });
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
 * Fetch 7-day hourly history for a single token from CoinGecko.
 * @param {string} geckoId
 * @returns {Promise<Array<{ ts: Date, close: number, volume: number | null }>>} oldest first
 */
async function fetchHistory(geckoId) {
  const url = `${coingeckoApiBase()}/coins/${encodeURIComponent(geckoId)}/market_chart?vs_currency=usd&days=7&interval=hourly`;
  const res  = await safeFetch(url);
  const data = await res.json();

  if (!data.prices || !Array.isArray(data.prices)) {
    throw new Error(`Unexpected CoinGecko response for ${geckoId}`);
  }

  const volumes = Array.isArray(data.total_volumes) ? data.total_volumes : [];

  return data.prices.map(([tsMs, price], idx) => {
    const volPair = volumes[idx];
    const volume = Array.isArray(volPair) ? Number(volPair[1]) : null;
    return {
      ts: floorToHourUtc(new Date(tsMs)),
      close: Number(price),
      volume: Number.isFinite(volume) ? volume : null,
    };
  });
}

async function getDbHistoryStatus(geckoId) {
  const pool = getPool();
  const res = await pool.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE ts >= now() - interval '7 days')::int AS cnt_7d,
      COUNT(*) FILTER (WHERE ts >= now() - interval '48 hours')::int AS cnt_48h,
      MAX(ts) AS max_ts
    FROM market_candles_hourly
    WHERE gecko_id = $1
  `,
    [geckoId]
  );

  const row = res.rows[0] ?? { cnt_7d: 0, cnt_48h: 0, max_ts: null };
  const cnt7d = Number(row.cnt_7d ?? 0);
  const cnt48h = Number(row.cnt_48h ?? 0);
  const maxTs = row.max_ts ? new Date(row.max_ts) : null;
  return { cnt7d, cnt48h, maxTs };
}

async function loadClosesFromDb(geckoId, limit = DB_CLOSES_LIMIT) {
  const pool = getPool();
  const res = await pool.query(
    `
    SELECT close
    FROM market_candles_hourly
    WHERE gecko_id = $1
    ORDER BY ts DESC
    LIMIT $2
  `,
    [geckoId, limit]
  );

  const closesNewestFirst = res.rows.map((r) => Number(r.close)).filter((n) => Number.isFinite(n));
  return closesNewestFirst.reverse();
}

async function upsertHistoryCandles(geckoId, points) {
  const candles = points
    .map((p) => {
      const close = Number(p.close);
      return {
        geckoId,
        ts: p.ts,
        open: close,
        high: close,
        low: close,
        close,
        volume: p.volume,
      };
    })
    .filter((c) => {
      return c.ts instanceof Date && Number.isFinite(c.close);
    });

  if (candles.length === 0) {
    return 0;
  }

  const pool = getPool();
  const values = [];
  const placeholders = candles.map((c, i) => {
    const base = i * 8;
    values.push(c.geckoId, c.ts.toISOString(), c.open, c.high, c.low, c.close, c.volume, 'coingecko');
    return `($${base + 1}, $${base + 2}::timestamptz, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
  });

  const sql = `
    INSERT INTO market_candles_hourly (gecko_id, ts, open, high, low, close, volume, source)
    VALUES ${placeholders.join(',')}
    ON CONFLICT (gecko_id, ts) DO UPDATE SET
      open = EXCLUDED.open,
      high = EXCLUDED.high,
      low = EXCLUDED.low,
      close = EXCLUDED.close,
      volume = COALESCE(EXCLUDED.volume, market_candles_hourly.volume),
      source = EXCLUDED.source,
      updated_at = now()
  `;

  const res = await pool.query(sql, values);
  return res.rowCount ?? candles.length;
}

async function upsertCurrentHourFromPrice(geckoId, price) {
  const close = Number(price);
  if (!Number.isFinite(close)) {
    return;
  }

  const ts = floorToHourUtc(new Date());
  const pool = getPool();
  await pool.query(
    `
    INSERT INTO market_candles_hourly (gecko_id, ts, open, high, low, close, volume, source)
    VALUES ($1, $2::timestamptz, $3, $3, $3, $3, NULL, 'coingecko_simple_price')
    ON CONFLICT (gecko_id, ts) DO UPDATE SET
      high = GREATEST(market_candles_hourly.high, EXCLUDED.high),
      low = LEAST(market_candles_hourly.low, EXCLUDED.low),
      close = EXCLUDED.close,
      updated_at = now()
  `,
    [geckoId, ts.toISOString(), close]
  );
}

/**
 * Batch-fetch current prices: several smaller /simple/price calls (chunked) instead of one huge URL.
 * Failed chunks are logged; other chunks still merge into the result map.
 * @param {string[]} geckoIds
 * @returns {Promise<Map<string, number>>} geckoId → current price
 */
async function fetchCurrentPrices(geckoIds) {
  const uniqueIds = [...new Set(geckoIds.filter((id) => typeof id === 'string' && id.length > 0))];
  const result = new Map();

  for (let start = 0; start < uniqueIds.length; start += SIMPLE_PRICE_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(start, start + SIMPLE_PRICE_CHUNK_SIZE);
    const idsParam = chunk.map(encodeURIComponent).join(',');
    const url = `${coingeckoApiBase()}/simple/price?ids=${idsParam}&vs_currencies=usd`;
    try {
      const res = await safeFetch(url);
      const data = await res.json();
      for (const id of chunk) {
        if (data[id]?.usd != null) {
          result.set(id, data[id].usd);
        }
      }
    } catch (e) {
      console.error(`[market] simple/price chunk failed (${chunk.length} id(s)): ${e.message}`);
    }

    const hasMore = start + SIMPLE_PRICE_CHUNK_SIZE < uniqueIds.length;
    if (hasMore) {
      await sleep(SIMPLE_PRICE_CHUNK_GAP_MS);
    }
  }

  return result;
}

/**
 * Ensure history is available in DB and hydrate in-memory closes cache.
 * Calls CoinGecko only for tokens that are missing/stale in Postgres.
 * @param {string[]} geckoIds
 */
export async function refreshHistory(geckoIds) {
  console.log(`[market] Ensuring candle history for ${geckoIds.length} tokens (DB-backed)...`);
  const now = Date.now();
  const interRequestMs = geckoIds.length > 30 ? 15_000 : INTER_REQUEST_MS;
  for (let i = 0; i < geckoIds.length; i++) {
    const id = geckoIds[i];
    let didFetchFromApi = false;
    try {
      const status = await getDbHistoryStatus(id);
      const tooFew = status.cnt7d < EXPECTED_7D_POINTS - 2;
      const expected48h = 48 + 1;
      const gapRecent = status.cnt48h < expected48h - 2;
      const tooOld = !status.maxTs || status.maxTs.getTime() < now - 2 * 60 * 60 * 1000;
      const needsBackfill = tooFew || gapRecent || tooOld;

      if (needsBackfill) {
        const points = await fetchHistory(id);
        if (points.length > 0 && points.length < 48) {
          console.warn(
            `[market] CoinGecko returned only ${points.length} hourly point(s) for ${id} — expected ~${EXPECTED_7D_POINTS}; data may be incomplete`
          );
        }
        didFetchFromApi = true;
        await upsertHistoryCandles(id, points);
      }

      const closes = await loadClosesFromDb(id, DB_CLOSES_LIMIT);
      _cache.set(id, { closes, fetchedAt: Date.now() });
      console.log(`[market] History ready: ${id} (${closes.length} closes)${needsBackfill ? ' (backfilled)' : ''}`);
    } catch (e) {
      console.error(`[market] Failed to fetch history for ${id}: ${e.message}`);
      try {
        const closes = await loadClosesFromDb(id, DB_CLOSES_LIMIT);
        _cache.set(id, { closes, fetchedAt: Date.now() });
        console.warn(`[market] Loaded ${closes.length} close(s) from DB for ${id} after API error (will retry backfill while data stays short)`);
      } catch (e2) {
        console.error(`[market] Could not load DB candles for ${id}: ${e2.message}`);
      }
    }

    if (didFetchFromApi && i < geckoIds.length - 1) {
      await sleep(interRequestMs);
    }
  }
  _lastFullFetch = Date.now();
}

/**
 * Update cached closes with fresh current prices (1 API call total).
 * Persists the current hour candle in Postgres.
 * @param {string[]} geckoIds
 * @returns {Promise<Map<string, number>>} geckoId → current price
 */
export async function updateCurrentPrices(geckoIds) {
  const prices = await fetchCurrentPrices(geckoIds);
  const upserts = [];
  for (const [id, price] of prices) {
    upserts.push(upsertCurrentHourFromPrice(id, price));

    const entry = _cache.get(id);
    const prev = entry?.closes ?? [];
    const next = [...prev, price];
    const trimmed = next.length > DB_CLOSES_LIMIT ? next.slice(-DB_CLOSES_LIMIT) : next;
    _cache.set(id, { closes: trimmed, fetchedAt: Date.now() });
  }
  await Promise.all(upserts);
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
 * When `geckoIds` and `minCloses` are provided, also returns true if any token has fewer than
 * `minCloses` samples in the in-memory cache (e.g. CoinGecko history failed but spot prices still
 * appended once per scan — otherwise you only see 1, 2, 3… "candles" until the 2h TTL elapses).
 *
 * @param {string[] | null} [geckoIds]
 * @param {number | null} [minCloses]
 * @returns {boolean}
 */
export function isHistoryStale(geckoIds = null, minCloses = null) {
  const ttlExpired = Date.now() - _lastFullFetch > HISTORY_TTL_MS;
  if (geckoIds == null || minCloses == null) {
    return ttlExpired;
  }
  const insufficient = geckoIds.some((gid) => {
    const closes = _cache.get(gid)?.closes;
    return !closes || closes.length < minCloses;
  });
  return ttlExpired || insufficient;
}
