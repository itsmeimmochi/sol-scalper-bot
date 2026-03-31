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

import 'dotenv/config';

import { Keypair, Connection } from '@solana/web3.js';

import { refreshHistory, updateCurrentPrices, getCloses, isHistoryStale } from './lib/market.js';
import { bollingerBands, rsi } from './lib/indicators.js';
import { shouldBuy, shouldSell, pnlPct } from './lib/signals.js';
import {
  loadPositions,
  hasPosition,
  getPosition,
  openPositionCount,
  getStats,
  persistSellCloseWithRetries,
  persistBuyOpenWithRetries,
} from './lib/positions.js';
import { buy, sell, keypairFromSecretKeyJson } from './lib/executor.js';
import { notify, buyMessage, sellMessage, errorMessage, scanSummaryMessage } from './lib/notify.js';
import { ensureSchema, loadConfig } from './lib/db.js';

// ── CLI: generate wallet ───────────────────────────────────────────────────────
if (process.argv.includes('--generate-wallet')) {
  const keypair = Keypair.generate();
  const secretJson = JSON.stringify(Array.from(keypair.secretKey));
  console.log('✅ Wallet generated!');
  console.log(`   Public key: ${keypair.publicKey.toBase58()}`);
  console.log('');
  console.log('   Add to .env or Coolify secrets:');
  console.log(`   WALLET_SECRET_KEY=${secretJson}`);
  console.log('');
  console.log('   ⚠️  Fund this wallet with SOL (for fees) and USDC before live trading.');
  process.exit(0);
}

// ── Main loop ──────────────────────────────────────────────────────────────────
async function main() {
  await ensureSchema();
  const config = await loadConfig();
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

  let wallet = null;
  if (!dryRun) {
    const secret = process.env.WALLET_SECRET_KEY;
    if (!secret) {
      console.error('❌ WALLET_SECRET_KEY is not set. Required for live trading.');
      console.error('   Generate one with: npm run wallet');
      process.exit(1);
    }
    wallet = keypairFromSecretKeyJson(secret);
    console.log(`[bot] Wallet: ${wallet.publicKey.toBase58()}`);
  }

  // ── Process a single token using cached closes ─────────────────────────────────
  async function scanToken(token, currentPrice) {
    const { symbol, mint } = token;
    const result = { symbol, price: currentPrice.toFixed(4), rsi: 0, signal: null };

    const closes = getCloses(token.geckoId);
    if (!closes) {
      console.warn(`[bot] No cached data for ${symbol} — skipping`);
      return result;
    }

    if (closes.length < bbPeriod + 1) {
      console.warn(`[bot] Not enough data for ${symbol} (${closes.length} candles, need ${bbPeriod + 1})`);
      return result;
    }

    const bb = bollingerBands(closes, bbPeriod, bbStdDev);
    const rsiValue = rsi(closes, rsiPeriod);
    result.rsi = rsiValue;

    console.log(
      `[bot] ${symbol} | price=$${currentPrice.toFixed(6)} | BB[${bb.lower.toFixed(4)}, ${bb.middle.toFixed(4)}, ${bb.upper.toFixed(4)}] | RSI=${rsiValue.toFixed(1)}`
    );

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
        result.signal = 'sell';
        console.log(`[bot] SELL signal for ${symbol} — reason: ${reason}`);
        try {
          await sell({
            symbol,
            mint,
            tokenAmount: position.tokenAmount,
            slippageBps,
            wallet,
            connection,
            dryRun,
            currentPrice,
          });
        } catch (e) {
          console.error(`[bot] Sell failed for ${symbol}: ${e.message}`);
          await notify(errorMessage(`sell:${symbol}`, e));
          return result;
        }

        const pnl = pnlPct(position.entryPrice, currentPrice);
        try {
          await persistSellCloseWithRetries(symbol, currentPrice, reason, position);
        } catch (e) {
          console.error(
            `[bot] CRITICAL: sell completed but position close could not be persisted for ${symbol}: ${e.message}`
          );
          await notify(errorMessage(`persist-close:${symbol}`, e));
          return result;
        }

        await notify(sellMessage({ symbol, entryPrice: position.entryPrice, exitPrice: currentPrice, pnl, reason, dryRun }));
      }
      return result;
    }

    const buySignal = shouldBuy({
      close: currentPrice,
      bb,
      rsiValue,
      hasOpenPosition: hasPosition(symbol),
      rsiBuyThreshold,
    });

    if (buySignal) {
      result.signal = 'buy';
      if (openPositionCount() >= maxOpenPositions) {
        console.log(`[bot] BUY signal for ${symbol} but max positions (${maxOpenPositions}) reached — skipping`);
        result.signal = null;
        return result;
      }
      console.log(`[bot] BUY signal for ${symbol} @ $${currentPrice.toFixed(6)}`);
      let buyResult;
      try {
        buyResult = await buy({
          symbol,
          mint,
          usdcAmount: positionSizeUsdc,
          slippageBps,
          wallet,
          connection,
          dryRun,
          currentPrice,
        });
      } catch (e) {
        console.error(`[bot] Buy failed for ${symbol}: ${e.message}`);
        await notify(errorMessage(`buy:${symbol}`, e));
        return result;
      }

      const persistBuy = await persistBuyOpenWithRetries({
        symbol,
        mint,
        entryPrice: buyResult.entryPrice,
        sizeUsdc: positionSizeUsdc,
        tokenAmount: buyResult.tokenAmount,
      });

      if (!persistBuy.ok) {
        await notify(errorMessage(`buy-persist:${symbol}`, persistBuy.error));
      }

      await notify(buyMessage({ symbol, entryPrice: buyResult.entryPrice, sizeUsdc: positionSizeUsdc, dryRun }));
    }

    return result;
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

    if (isHistoryStale()) {
      await refreshHistory(geckoIds);
    }

    let currentPrices;
    try {
      currentPrices = await updateCurrentPrices(geckoIds);
    } catch (e) {
      console.error(`[bot] Failed to fetch current prices: ${e.message}`);
      await notify(errorMessage('price-batch', e));
      return;
    }

    const results = [];
    for (const token of tokens) {
      const price = currentPrices.get(token.geckoId);
      if (price == null) {
        console.warn(`[bot] No price returned for ${token.symbol} — skipping`);
        continue;
      }
      const result = await scanToken(token, price);
      results.push(result);
    }

    await notify(
      scanSummaryMessage({
        results,
        openPositions: openPositionCount(),
        stats: getStats(),
        dryRun,
      })
    );
  }

  console.log('[bot] Sol Scalper Bot starting up...');
  console.log(`[bot] Strategy: BB(${bbPeriod}, ${bbStdDev}) + RSI(${rsiPeriod}) | Buy RSI<${rsiBuyThreshold} | Sell RSI>${rsiSellThreshold}`);
  console.log(`[bot] Risk: $${positionSizeUsdc}/trade | TP:+${takeProfitPct}% | SL:-${stopLossPct}% | Max:${maxOpenPositions}`);
  console.log(`[bot] Tokens: ${tokens.map(t => t.symbol).join(', ')}`);

  await loadPositions();
  await runOnce();

  const INTERVAL_MS = 30 * 60 * 1000;
  console.log(`\n[bot] Next scan in 30 minutes. Ctrl+C to stop.`);
  setInterval(runOnce, INTERVAL_MS);
}

main().catch(e => {
  console.error('[bot] Fatal error:', e);
  process.exit(1);
});
