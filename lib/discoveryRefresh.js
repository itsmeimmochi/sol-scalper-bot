/**
 * discoveryRefresh.js — orchestrates universe refresh (CoinGecko ranking → Jupiter mint resolution → DB upsert).
 */
import { discoverTopPerformingBy7dPct } from './discovery.js';
import {
  DEFAULT_JUPITER_TOKEN_LIST_URL,
  fetchJupiterTokenList,
  resolveMintFromJupiterTokenList,
} from './jupiterTokens.js';
import { markDiscoveryRunNow, upsertDiscoveredTradingTokens } from './db.js';

function minutesToMs(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) {
    return null;
  }
  return v * 60 * 1000;
}

function parseIsoOrNull(s) {
  if (typeof s !== 'string' || !s.trim()) {
    return null;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d;
}

function shouldRunDiscoveryNow(discovery) {
  if (!discovery?.enabled) {
    return { ok: false, reason: 'disabled' };
  }

  const refreshMs = minutesToMs(discovery.refreshMinutes ?? 360) ?? 6 * 60 * 60 * 1000;
  const cooldownMs = minutesToMs(discovery.cooldownMinutes ?? discovery.refreshMinutes ?? 360) ?? refreshMs;

  const last = parseIsoOrNull(discovery.lastRunAt);
  if (!last) {
    return { ok: true, reason: 'never-ran' };
  }

  const since = Date.now() - last.getTime();
  if (since < cooldownMs) {
    return { ok: false, reason: 'cooldown' };
  }
  if (since < refreshMs) {
    return { ok: false, reason: 'refresh-not-due' };
  }
  return { ok: true, reason: 'due' };
}

function buildResolvedUniverse({ discovered, tokenList }) {
  const resolved = [];
  const skipped = [];

  for (const c of discovered) {
    const mint = resolveMintFromJupiterTokenList({ symbol: c.symbol, name: c.name }, tokenList);
    if (!mint) {
      skipped.push({ symbol: c.symbol, geckoId: c.geckoId, reason: 'mint-not-resolved' });
      continue;
    }
    resolved.push({ symbol: c.symbol, geckoId: c.geckoId, mint: mint.mint });
  }

  return { resolved, skipped };
}

/**
 * Refresh discovered universe if due.
 * @param {{ discovery: any }} params
 * @returns {Promise<{ ran: boolean, resolvedCount: number, skippedCount: number }>}
 */
export async function refreshDiscoveryIfDue({ discovery }) {
  const check = shouldRunDiscoveryNow(discovery);
  if (!check.ok) {
    return { ran: false, resolvedCount: 0, skippedCount: 0 };
  }

  const tokenListUrl = discovery.jupiterTokenListUrl ?? DEFAULT_JUPITER_TOKEN_LIST_URL;
  const tokenList = await fetchJupiterTokenList(tokenListUrl);

  const discovered = await discoverTopPerformingBy7dPct({
    category: discovery.category ?? 'solana-ecosystem',
    minMarketCapUsd: discovery.minMarketCapUsd ?? 100_000_000,
    targetTokenCount: discovery.targetTokenCount ?? 50,
    excludeWrapped: discovery.excludeWrapped !== false,
  });

  const { resolved, skipped } = buildResolvedUniverse({ discovered, tokenList });
  await upsertDiscoveredTradingTokens(resolved);
  await markDiscoveryRunNow();

  if (skipped.length > 0) {
    const preview = skipped.slice(0, 8).map((s) => s.symbol).join(', ');
    console.warn(
      `[discovery] Skipped ${skipped.length} token(s) due to unresolved mint. Example: ${preview}${skipped.length > 8 ? ', …' : ''}`
    );
  }

  console.log(`[discovery] Universe refreshed: ${resolved.length} token(s) enabled.`);
  return { ran: true, resolvedCount: resolved.length, skippedCount: skipped.length };
}

