/**
 * replay-decision.mjs — DB-free signal replay helper.
 *
 * Usage:
 *   node scripts/replay-decision.mjs --closes closes.json --close 123.45 --entry 120.00
 * Optional: --bbMiddleSellPosition 0 --bbMiddleMinPnlPct 0
 *
 * closes.json must be a JSON array of numbers (oldest → newest).
 */

import { readFileSync } from 'node:fs';
import { bollingerBands, rsi } from '../lib/indicators.js';
import { shouldBuy, shouldSell } from '../lib/signals.js';

function readArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) {
    return null;
  }
  return process.argv[idx + 1] ?? null;
}

function must(v, label) {
  if (v == null || v === '') {
    throw new Error(`Missing ${label}`);
  }
  return v;
}

function toNum(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid number for ${label}`);
  }
  return n;
}

function main() {
  const closesPath = must(readArg('--closes'), '--closes <path>');
  const close = toNum(must(readArg('--close'), '--close <number>'), '--close');

  const entry = readArg('--entry');
  const entryPrice = entry == null ? null : toNum(entry, '--entry');

  const bbPeriod = toNum(readArg('--bbPeriod') ?? 20, '--bbPeriod');
  const bbStdDev = toNum(readArg('--bbStdDev') ?? 2, '--bbStdDev');
  const rsiPeriod = toNum(readArg('--rsiPeriod') ?? 14, '--rsiPeriod');
  const rsiBuyThreshold = toNum(readArg('--rsiBuyThreshold') ?? 30, '--rsiBuyThreshold');
  const rsiSellThreshold = toNum(readArg('--rsiSellThreshold') ?? 70, '--rsiSellThreshold');
  const takeProfitPct = toNum(readArg('--takeProfitPct') ?? 1.0, '--takeProfitPct');
  const stopLossPct = toNum(readArg('--stopLossPct') ?? 0.8, '--stopLossPct');
  const bbMiddleSellPosition = toNum(readArg('--bbMiddleSellPosition') ?? 0, '--bbMiddleSellPosition');
  const bbMiddleMinPnlPct = toNum(readArg('--bbMiddleMinPnlPct') ?? 0, '--bbMiddleMinPnlPct');

  const closes = JSON.parse(readFileSync(closesPath, 'utf8'));
  if (!Array.isArray(closes) || closes.some((n) => !Number.isFinite(Number(n)))) {
    throw new Error('closes.json must be a JSON array of numbers');
  }

  const series = [...closes.map(Number), close];
  const bb = bollingerBands(series, bbPeriod, bbStdDev);
  const rsiValue = rsi(series, rsiPeriod);

  const buy = shouldBuy({
    close,
    bb,
    rsiValue,
    hasOpenPosition: entryPrice != null,
    rsiBuyThreshold,
  });

  const sell =
    entryPrice == null
      ? { sell: false, reason: null }
      : shouldSell({
          close,
          bb,
          rsiValue,
          entryPrice,
          takeProfitPct,
          stopLossPct,
          rsiSellThreshold,
          bbMiddleSellPosition,
          bbMiddleMinPnlPct,
        });

  console.log(
    JSON.stringify(
      {
        close,
        bb,
        rsi: Number(rsiValue.toFixed(4)),
        buy,
        sell,
      },
      null,
      2
    )
  );
}

main();

