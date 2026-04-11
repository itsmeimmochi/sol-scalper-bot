/**
 * Summarize exported `trades` CSV (same column order as Postgres `trades` table).
 *
 * Usage:
 *   node scripts/analyze-trades-csv.mjs
 *   node scripts/analyze-trades-csv.mjs path/to/trades.csv
 *
 * Default input: docs/trades.csv (repo root relative to this script).
 *
 * Optional header row: if the first column of line 1 is not an integer id, that line is skipped.
 *
 * ---
 * Equivalent aggregates in Postgres (replace lane filter as needed):
 *
 * -- Totals + win rate + PnL (simulated paper trades)
 * SELECT
 *   COUNT(*) AS trades,
 *   COUNT(*) FILTER (WHERE won) AS wins,
 *   ROUND(100.0 * COUNT(*) FILTER (WHERE won) / NULLIF(COUNT(*), 0), 2) AS win_rate_pct,
 *   ROUND(SUM(pnl_usdc)::numeric, 4) AS total_pnl_usdc
 * FROM trades
 * WHERE is_simulated = true;
 *
 * -- By exit reason
 * SELECT reason, COUNT(*) AS n,
 *   COUNT(*) FILTER (WHERE won) AS wins
 * FROM trades
 * WHERE is_simulated = true
 * GROUP BY reason
 * ORDER BY n DESC;
 *
 * -- By symbol
 * SELECT symbol, COUNT(*) AS n,
 *   COUNT(*) FILTER (WHERE won) AS wins,
 *   ROUND(SUM(pnl_usdc)::numeric, 4) AS pnl_usdc
 * FROM trades
 * WHERE is_simulated = true
 * GROUP BY symbol
 * ORDER BY n DESC;
 *
 * -- By ISO week of closed_at (UTC)
 * SELECT to_char(date_trunc('week', closed_at AT TIME ZONE 'UTC'), 'IYYY-"W"IW') AS iso_week,
 *   COUNT(*) AS n,
 *   COUNT(*) FILTER (WHERE won) AS wins,
 *   ROUND(SUM(pnl_usdc)::numeric, 4) AS pnl_usdc
 * FROM trades
 * WHERE is_simulated = true
 * GROUP BY 1
 * ORDER BY 1;
 * ---
 */

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const EXPECTED_COLS = 12;

function parseBool(raw) {
  const s = String(raw).trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return null;
}

function mondayWeekKeyUtc(closedRaw) {
  const normalized = String(closedRaw).trim().replace(' +00:00', 'Z').replace(' ', 'T');
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) {
    return 'unknown';
  }
  const day = d.getUTCDay();
  const daysFromMonday = (day + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - daysFromMonday);
  return monday.toISOString().slice(0, 10);
}

function parseTradeLine(line, lineNo) {
  const trimmed = line.trim();
  if (!trimmed) {
    return { skip: true };
  }

  const parts = trimmed.split(',');
  if (parts.length < EXPECTED_COLS) {
    return { error: `line ${lineNo}: expected at least ${EXPECTED_COLS} columns, got ${parts.length}` };
  }

  const idStr = parts[0].trim();
  const id = Number(idStr);
  if (!Number.isInteger(id)) {
    return { skip: true };
  }

  const won = parseBool(parts[10]);
  const isSimulated = parseBool(parts[11]);
  if (won === null || isSimulated === null) {
    return { error: `line ${lineNo}: invalid boolean in won/is_simulated` };
  }

  const pnlUsdc = Number(parts[6]);
  if (!Number.isFinite(pnlUsdc)) {
    return { error: `line ${lineNo}: invalid pnl_usdc` };
  }

  return {
    skip: false,
    trade: {
      id,
      symbol: parts[1].trim(),
      reason: parts[7].trim(),
      pnlUsdc,
      won,
      isSimulated,
      closedAt: parts[9].trim(),
    },
  };
}

function increment(map, key, delta = 1) {
  map.set(key, (map.get(key) ?? 0) + delta);
}

function main() {
  const argPath = process.argv[2];
  const csvPath = resolve(argPath ?? resolve(root, 'docs/trades.csv'));

  let raw;
  try {
    raw = readFileSync(csvPath, 'utf8');
  } catch (e) {
    console.error(`[analyze-trades-csv] Cannot read file: ${csvPath}`);
    console.error(`  ${e.message}`);
    process.exit(1);
  }

  const lines = raw.split(/\r?\n/);
  const trades = [];

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const parsed = parseTradeLine(lines[i], lineNo);
    if (parsed.error) {
      console.error(`[analyze-trades-csv] ${parsed.error}`);
      process.exit(1);
    }
    if (parsed.skip) {
      continue;
    }
    trades.push(parsed.trade);
  }

  if (trades.length === 0) {
    console.log(`[analyze-trades-csv] No data rows in ${csvPath}`);
    process.exit(0);
  }

  const simOnly = trades.filter((t) => t.isSimulated);
  const liveMixed = trades.filter((t) => !t.isSimulated);
  if (liveMixed.length > 0) {
    console.log(`[analyze-trades-csv] Note: ${liveMixed.length} row(s) have is_simulated=false (live); totals below include all rows.`);
  }

  const ids = trades.map((t) => t.id);
  const minId = Math.min(...ids);
  const maxId = Math.max(...ids);

  const wins = trades.filter((t) => t.won);
  const totalPnl = trades.reduce((s, t) => s + t.pnlUsdc, 0);
  const winRatePct = (100 * wins.length) / trades.length;

  const byReason = new Map();
  const reasonWins = new Map();
  for (const t of trades) {
    increment(byReason, t.reason);
    if (t.won) {
      increment(reasonWins, t.reason);
    }
  }

  const bySymbol = new Map();
  for (const t of trades) {
    if (!bySymbol.has(t.symbol)) {
      bySymbol.set(t.symbol, { n: 0, wins: 0, pnl: 0 });
    }
    const row = bySymbol.get(t.symbol);
    row.n += 1;
    row.pnl += t.pnlUsdc;
    if (t.won) {
      row.wins += 1;
    }
  }

  const byWeek = new Map();
  for (const t of trades) {
    const wk = mondayWeekKeyUtc(t.closedAt);
    if (!byWeek.has(wk)) {
      byWeek.set(wk, { n: 0, wins: 0, pnl: 0 });
    }
    const row = byWeek.get(wk);
    row.n += 1;
    row.pnl += t.pnlUsdc;
    if (t.won) {
      row.wins += 1;
    }
  }

  console.log(`[analyze-trades-csv] File: ${csvPath}`);
  console.log(`  Rows: ${trades.length} | id range: ${minId}–${maxId}${minId > 1 ? '  (WARNING: export may be partial — missing lower ids)' : ''}`);
  if (simOnly.length === trades.length) {
    console.log('  Lane: all rows is_simulated=true (paper)');
  }

  console.log('');
  console.log('Totals');
  console.log(`  Trades:     ${trades.length}`);
  console.log(`  Wins:       ${wins.length}`);
  console.log(`  Win rate:   ${winRatePct.toFixed(2)}%`);
  console.log(`  Sum pnl_usdc: ${totalPnl.toFixed(4)}`);

  console.log('');
  console.log('By reason');
  const reasons = [...byReason.entries()].sort((a, b) => b[1] - a[1]);
  for (const [reason, n] of reasons) {
    const rw = reasonWins.get(reason) ?? 0;
    console.log(`  ${reason}: ${n} (${rw} wins)`);
  }

  console.log('');
  console.log('By symbol (sorted by trade count)');
  const symbols = [...bySymbol.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [sym, { n, wins: wn, pnl }] of symbols) {
    const wr = n ? ((100 * wn) / n).toFixed(1) : '0.0';
    console.log(`  ${sym}: n=${n} wins=${wn} (${wr}%) pnl_usdc=${pnl.toFixed(4)}`);
  }

  console.log('');
  console.log('By week (UTC, week starts Monday)');
  const weeks = [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [wk, { n, wins: wn, pnl }] of weeks) {
    const wr = n ? ((100 * wn) / n).toFixed(1) : '0.0';
    console.log(`  week ${wk}: n=${n} wins=${wn} (${wr}%) pnl_usdc=${pnl.toFixed(4)}`);
  }

  console.log('');
  console.log('Iteration: re-export trades from Postgres after parameter changes, then re-run this script weekly.');
}

main();
