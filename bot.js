/**
 * bot.js — Main entry point.
 *
 * Usage:
 *   node bot.js                  — start the trading loop
 *   node bot.js --generate-wallet — generate a new keypair and exit
 *
 * API call budget:
 *   - Startup + every 2h: 8 calls (one per token, 10s apart) for full history
 *   - Every 30-min scan: 1 batch call for all current prices
 */

import { Keypair, Connection } from '@solana/web3.js';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { refreshHistory, updateCurrentPrices, getCloses, isHistoryStale } from './lib/market.js';
import { bollingerBands, rsi } from './lib/indicators.js';
import { shouldBuy, shouldSell, pnlPct } from './lib/signals.js';
import { loadPositions, hasPosition, getPosition, openPosition, closePosition, openPositionCount, getStats } from './lib/positions.js';
import { buy, sell, loadWallet } from './lib/executor.js';
import { notify, buyMessage, sellMessage, errorMessage } from './lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, 'config.json');
const WALLET_PATH = resolve(__dirname, 'wallet.json');

// ── CLI: generate wallet ───────────────────────────────────────────────────────
if (process.argv.includes('--generate-wallet')) {
  const keypair = Keypair.generate();
  writeFileSync(WALLET_PATH, JSON.stringify(Array.from(keypair.secretKey)));
  console.log('✅ Wallet generated!');
  console.log(`   Public key : ${keypair.publicKey.toBase58()}`);
  console.log(`   Saved to   : ${WALLET_PATH}`);
  console.log('   ⚠️  Fund this wallet with SOL (for fees) and USDC before running the bot.');
  process.exit(0);
}

// ── Load config ────────────────────────────────────────────────────────────────
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const {
  tokens,
  strategy: { bbPeriod, bbStdDev, rsiPeriod, rsiBuyThreshold, rsiSellThreshold },
  risk: { positionSizeUsdc, takeProfitPct, stopLossPct, maxOpenPositions },
  rpc,
  slippageBps,
  dryRun,
} = config;

const geckoIds = tokens.map(t => t.geckoId);
const connection = new Connection(rpc, 'confirmed');

// Load wallet (only needed for live trading)
let wallet = null;
if (!dryRun) {
  if (!existsSync(WALLET_PATH)) {
    console.error('❌ wallet.json not found. Run: node bot.js --generate-wallet');
    process.exit(1);
  }
  wallet = loadWallet('wallet.json');
  console.log(`[bot] Wallet: ${wallet.publicKey.toBase58()}`);
}

// ── Process a single token using cached closes ─────────────────────────────────
async function scanToken(token, currentPrice) {
  const { symbol, mint } = token;

  const closes = getCloses(token.geckoId);
  if (!closes) {
    console.warn(`[bot] No cached data for ${symbol} — skipping`);
    return;
  }

  if (closes.length < bbPeriod + 1) {
    console.warn(`[bot] Not enough data for ${symbol} (${closes.length} candles, need ${bbPeriod + 1})`);
    return;
  }

  const bb       = bollingerBands(closes, bbPeriod, bbStdDev);
  const rsiValue = rsi(closes, rsiPeriod);

  console.log(`[bot] ${symbol} | price=$${currentPrice.toFixed(6)} | BB[${bb.lower.toFixed(4)}, ${bb.middle.toFixed(4)}, ${bb.upper.toFixed(4)}] | RSI=${rsiValue.toFixed(1)}`);

  // ── Sell check ──
  const position = getPosition(symbol);
  if (position) {
    const { sell: doSell, reason } = shouldSell({
      close: currentPrice,
      bb,
      rsiValue,
      entryPrice: position.entryPrice,
      takeProfitPct,
      stopLossPct,
      rsiSellThreshold,
    });

    if (doSell) {
      console.log(`[bot] SELL signal for ${symbol} — reason: ${reason}`);
      try {
        await sell({ symbol, mint, tokenAmount: position.tokenAmount, slippageBps, wallet, connection, dryRun, currentPrice });
        const pnl = pnlPct(position.entryPrice, currentPrice);
        closePosition(symbol, currentPrice, reason);
        await notify(sellMessage({ symbol, entryPrice: position.entryPrice, exitPrice: currentPrice, pnl, reason, dryRun }));
      } catch (e) {
        console.error(`[bot] Sell failed for ${symbol}: ${e.message}`);
        await notify(errorMessage(`sell:${symbol}`, e));
      }
    }
    return;
  }

  // ── Buy check ──
  const buySignal = shouldBuy({ close: currentPrice, bb, rsiValue, hasOpenPosition: hasPosition(symbol), rsiBuyThreshold });

  if (buySignal) {
    if (openPositionCount() >= maxOpenPositions) {
      console.log(`[bot] BUY signal for ${symbol} but max positions (${maxOpenPositions}) reached — skipping`);
      return;
    }
    console.log(`[bot] BUY signal for ${symbol} @ $${currentPrice.toFixed(6)}`);
    try {
      const { txid, tokenAmount, entryPrice } = await buy({ symbol, mint, usdcAmount: positionSizeUsdc, slippageBps, wallet, connection, dryRun, currentPrice });
      openPosition({ symbol, mint, entryPrice, sizeUsdc: positionSizeUsdc, tokenAmount });
      await notify(buyMessage({ symbol, entryPrice, sizeUsdc: positionSizeUsdc, dryRun }));
    } catch (e) {
      console.error(`[bot] Buy failed for ${symbol}: ${e.message}`);
      await notify(errorMessage(`buy:${symbol}`, e));
    }
  }
}

function printStats() {
  const s = getStats();
  if (s.total === 0) {
    console.log('[bot] Stats: no closed trades yet');
    return;
  }
  const sign = s.totalPnlUsdc >= 0 ? '+' : '';
  console.log(
    `[bot] Stats: ${s.total} trades | Win rate: ${s.winRate}% (${s.wins}W/${s.losses}L) | ` +
    `PnL: ${sign}$${s.totalPnlUsdc.toFixed(2)} | Avg: +${s.avgWinPct.toFixed(2)}% win / ${s.avgLossPct.toFixed(2)}% loss`
  );
}

async function runOnce() {
  console.log(`\n[bot] === Scan at ${new Date().toISOString()} ===`);
  console.log(`[bot] Mode: ${dryRun ? 'DRY RUN' : 'LIVE'} | Open positions: ${openPositionCount()}/${maxOpenPositions}`);
  printStats();

  // Refresh full history if stale (startup or every 2h) — 8 calls, 10s apart
  if (isHistoryStale()) {
    await refreshHistory(geckoIds);
  }

  // ONE batch call for all current prices, append to cache
  let currentPrices;
  try {
    currentPrices = await updateCurrentPrices(geckoIds);
  } catch (e) {
    console.error(`[bot] Failed to fetch current prices: ${e.message}`);
    await notify(errorMessage('price-batch', e));
    return;
  }

  // Process each token using cached data — no more API calls
  for (const token of tokens) {
    const price = currentPrices.get(token.geckoId);
    if (price == null) {
      console.warn(`[bot] No price returned for ${token.symbol} — skipping`);
      continue;
    }
    await scanToken(token, price);
  }
}

// ── Main loop ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('[bot] Sol Scalper Bot starting up...');
  console.log(`[bot] Strategy: BB(${bbPeriod}, ${bbStdDev}) + RSI(${rsiPeriod}) | Buy RSI<${rsiBuyThreshold} | Sell RSI>${rsiSellThreshold}`);
  console.log(`[bot] Risk: $${positionSizeUsdc}/trade | TP:+${takeProfitPct}% | SL:-${stopLossPct}% | Max:${maxOpenPositions}`);
  console.log(`[bot] Tokens: ${tokens.map(t => t.symbol).join(', ')}`);

  loadPositions();
  await runOnce();

  const INTERVAL_MS = 30 * 60 * 1000;
  console.log(`\n[bot] Next scan in 30 minutes. Ctrl+C to stop.`);
  setInterval(runOnce, INTERVAL_MS);
}

main().catch(e => {
  console.error('[bot] Fatal error:', e);
  process.exit(1);
});
