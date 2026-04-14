/**
 * jupiterTokens.js — fetch and resolve Solana mints using a Jupiter token list.
 *
 * This module intentionally supports multiple token list shapes because Jupiter endpoints
 * and hosting vary over time. The URL should be configurable; we provide a conservative
 * default pointing at a public GitHub raw CSV.
 */
import fetch from 'node-fetch';

function normalizeText(s) {
  if (typeof s !== 'string') {
    return '';
  }
  return s.trim();
}

function normalizeSymbol(symbol) {
  return normalizeText(symbol).toUpperCase();
}

function safeSplitCsvLine(line) {
  // Minimal CSV parser supporting quoted commas.
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        cur += '"';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseValidatedTokensCsv(csvText) {
  const lines = csvText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) {
    return [];
  }

  const header = safeSplitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  const nameIdx = idx('name');
  const symbolIdx = idx('symbol');
  const mintIdx = idx('mint');
  const decimalsIdx = idx('decimals');

  return lines.slice(1).map((line) => {
    const cols = safeSplitCsvLine(line);
    const name = nameIdx >= 0 ? normalizeText(cols[nameIdx]) : '';
    const symbol = symbolIdx >= 0 ? normalizeSymbol(cols[symbolIdx]) : '';
    const mint = mintIdx >= 0 ? normalizeText(cols[mintIdx]) : '';
    const decimalsRaw = decimalsIdx >= 0 ? Number(cols[decimalsIdx]) : null;
    const decimals = Number.isInteger(decimalsRaw) ? decimalsRaw : null;
    return {
      name,
      symbol,
      address: mint,
      decimals,
      tags: [],
      extensions: {},
    };
  });
}

function normalizeTokenRow(row) {
  // Supports common Jupiter shapes:
  // - { address, symbol, name, decimals, tags?, extensions? }
  // - { mint, symbol, name, decimals, ... }
  const address = normalizeText(row?.address ?? row?.mint ?? row?.tokenMint ?? '');
  const symbol = normalizeSymbol(row?.symbol ?? '');
  const name = normalizeText(row?.name ?? '');
  const decimalsRaw = Number(row?.decimals);
  const decimals = Number.isInteger(decimalsRaw) ? decimalsRaw : null;
  const tags = Array.isArray(row?.tags) ? row.tags.map((t) => String(t)) : [];
  const extensions = row?.extensions && typeof row.extensions === 'object' ? row.extensions : {};

  return { address, symbol, name, decimals, tags, extensions };
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json,text/plain,*/*' } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jupiter token list fetch failed: ${res.status} ${text}`);
  }
  return await res.text();
}

function looksLikeJson(text) {
  const t = text.trim();
  return t.startsWith('{') || t.startsWith('[');
}

/**
 * @param {string} url
 * @returns {Promise<Array<{ address: string, symbol: string, name: string, decimals: number|null, tags: string[], extensions: object }>>}
 */
export async function fetchJupiterTokenList(url) {
  const body = await fetchText(url);

  if (!looksLikeJson(body)) {
    return parseValidatedTokensCsv(body)
      .map(normalizeTokenRow)
      .filter((t) => Boolean(t.address && t.symbol));
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(`Jupiter token list returned invalid JSON: ${e.message}`);
  }

  const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tokens) ? parsed.tokens : [];
  if (!Array.isArray(arr)) {
    return [];
  }

  return arr
    .map(normalizeTokenRow)
    .filter((t) => Boolean(t.address && t.symbol));
}

function scoreTokenForSelection(token, { discoveredName }) {
  const tags = new Set(token.tags.map((t) => String(t).toLowerCase()));
  const name = token.name.toLowerCase();
  const targetName = (discoveredName ?? '').toLowerCase();

  const isStrict = tags.has('strict') ? 1 : 0;
  const isVerified = tags.has('verified') ? 1 : 0;
  const nameExact = targetName && name === targetName ? 1 : 0;
  const nameContains = targetName && name.includes(targetName) ? 1 : 0;
  const hasDecimals = token.decimals !== null ? 1 : 0;

  return (
    isStrict * 1000 +
    isVerified * 100 +
    nameExact * 10 +
    nameContains * 2 +
    hasDecimals
  );
}

/**
 * Deterministically resolve a discovered CoinGecko candidate to a single Solana mint.
 *
 * Strategy:
 * - Match by exact symbol (case-insensitive).
 * - If multiple matches, prefer tokens with tags `strict` then `verified`.
 * - If still multiple, prefer name similarity.
 * - If still ambiguous, return null (skip) rather than guess.
 *
 * @param {{ symbol: string, name?: string }} candidate
 * @param {Array<{ address: string, symbol: string, name: string, tags: string[], decimals: number|null }>} tokenList
 * @returns {{ mint: string } | null}
 */
export function resolveMintFromJupiterTokenList(candidate, tokenList) {
  const sym = normalizeSymbol(candidate?.symbol ?? '');
  if (!sym) {
    return null;
  }

  const matches = tokenList.filter((t) => normalizeSymbol(t.symbol) === sym);
  if (matches.length === 0) {
    return null;
  }
  if (matches.length === 1) {
    return { mint: matches[0].address };
  }

  const ranked = matches
    .map((t) => ({ t, score: scoreTokenForSelection(t, { discoveredName: candidate?.name }) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  const second = ranked[1];
  if (!best || !second) {
    return null;
  }
  if (best.score === second.score) {
    return null;
  }
  return { mint: best.t.address };
}

export const DEFAULT_JUPITER_TOKEN_LIST_URL =
  'https://raw.githubusercontent.com/jup-ag/token-list/main/validated-tokens.csv';

