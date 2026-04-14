/**
 * discovery.js — discover a dynamic trading universe.
 *
 * Current strategy:
 * - Discover top performers from CoinGecko `/coins/markets` within a category (default solana-ecosystem)
 * - Sort by 7d % change (client-side)
 * - Filter by min market cap and wrapped/bridged heuristics
 *
 * Mint resolution + DB persistence are handled in separate steps.
 */
import fetch from 'node-fetch';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

function toFiniteNumberOrNull(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    return null;
  }
  return n;
}

function normalizeText(s) {
  if (typeof s !== 'string') {
    return '';
  }
  return s.trim().toLowerCase();
}

export function isLikelyWrappedAsset({ id, symbol, name }) {
  const sym = normalizeText(symbol);
  const nm = normalizeText(name);
  const cid = normalizeText(id);

  const byName =
    nm.includes('wrapped ') ||
    nm.includes('bridged ') ||
    nm.includes('wormhole') ||
    nm.includes('portal') ||
    nm.includes('weth') ||
    nm.includes('wbtc');

  const bySymbol =
    sym.startsWith('w') ||
    sym.endsWith('.e') ||
    sym.endsWith('.w') ||
    sym.includes('weth') ||
    sym.includes('wbtc');

  const byId = cid.includes('wormhole') || cid.includes('wrapped') || cid.includes('bridged');

  return byName || bySymbol || byId;
}

function get7dPctChange(row) {
  const candidates = [
    row?.price_change_percentage_7d_in_currency,
    row?.price_change_percentage_7d,
    row?.price_change_percentage_7d_in_usd,
  ];
  for (const v of candidates) {
    const n = toFiniteNumberOrNull(v);
    if (n !== null) {
      return n;
    }
  }
  return null;
}

async function safeFetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fetch failed: ${res.status} ${text}`);
  }
  return await res.json();
}

function buildCoinsMarketsUrl({
  vsCurrency,
  category,
  page,
  perPage,
  priceChangePercentage,
}) {
  const params = new URLSearchParams();
  params.set('vs_currency', vsCurrency);
  params.set('category', category);
  params.set('page', String(page));
  params.set('per_page', String(perPage));
  if (priceChangePercentage) {
    params.set('price_change_percentage', priceChangePercentage);
  }
  return `${COINGECKO_BASE}/coins/markets?${params.toString()}`;
}

/**
 * Fetch candidates from CoinGecko and apply baseline filtering/sorting.
 * @param {{
 *   category?: string,
 *   vsCurrency?: string,
 *   minMarketCapUsd?: number,
 *   targetTokenCount?: number,
 *   excludeWrapped?: boolean,
 *   maxPages?: number,
 *   perPage?: number,
 * }} opts
 * @returns {Promise<Array<{ geckoId: string, symbol: string, name: string, marketCapUsd: number, pctChange7d: number }>>}
 */
export async function discoverTopPerformingBy7dPct(opts = {}) {
  const {
    category = 'solana-ecosystem',
    vsCurrency = 'usd',
    minMarketCapUsd = 100_000_000,
    targetTokenCount = 50,
    excludeWrapped = true,
    maxPages = 4,
    perPage = 250,
  } = opts;

  const requested = Math.max(1, Number(targetTokenCount) || 50);
  const effectiveMaxPages = Math.max(1, Number(maxPages) || 1);
  const effectivePerPage = Math.min(250, Math.max(1, Number(perPage) || 100));

  const rows = [];
  for (let page = 1; page <= effectiveMaxPages; page++) {
    const url = buildCoinsMarketsUrl({
      vsCurrency,
      category,
      page,
      perPage: effectivePerPage,
      priceChangePercentage: '7d',
    });
    // eslint-disable-next-line no-await-in-loop
    const pageRows = await safeFetchJson(url);
    if (!Array.isArray(pageRows) || pageRows.length === 0) {
      break;
    }
    rows.push(...pageRows);
    if (rows.length >= requested * 3) {
      break;
    }
  }

  const filtered = rows
    .map((r) => {
      const pctChange7d = get7dPctChange(r);
      const marketCapUsd = toFiniteNumberOrNull(r?.market_cap);
      return {
        geckoId: typeof r?.id === 'string' ? r.id : '',
        symbol: typeof r?.symbol === 'string' ? r.symbol.toUpperCase() : '',
        name: typeof r?.name === 'string' ? r.name : '',
        marketCapUsd,
        pctChange7d,
      };
    })
    .filter((r) => Boolean(r.geckoId && r.symbol))
    .filter((r) => r.pctChange7d !== null)
    .filter((r) => r.marketCapUsd !== null && r.marketCapUsd >= minMarketCapUsd)
    .filter((r) => {
      if (!excludeWrapped) {
        return true;
      }
      return !isLikelyWrappedAsset({ id: r.geckoId, symbol: r.symbol, name: r.name });
    })
    .sort((a, b) => b.pctChange7d - a.pctChange7d);

  return filtered.slice(0, requested);
}

