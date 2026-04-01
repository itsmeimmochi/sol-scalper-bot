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
import { buy, sell, keypairFromSecretKeyJson, getWalletBalances } from './lib/executor.js';
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
  const initialConfig = await loadConfig();
  const {
    tokens,
    rpc,
  } = initialConfig;

  const geckoIds = tokens.map(t => t.geckoId);
  const connection = new Connection(rpc, 'confirmed');

  let wallet = null;
  if (!initialConfig.dryRun) {
    const secret = process.env.WALLET_SECRET_KEY;
    if (!secret) {
      console.error('❌ WALLET_SECRET_KEY is not set. Required for live trading.');
      console.error('   Generate one with: npm run wallet');
      process.exit(1);
    }
    wallet = keypairFromSecretKeyJson(secret);
    console.log(`[bot] Wallet: ${wallet.publicKey.toBase58()}`);
  }

  function normalizeScanIntervalMs(config) {
    const minutes = Number(config.scanIntervalMinutes ?? 30);
    const fallback = 30 * 60 * 1000;
    const clamp = (n, min, max) => Math.min(Math.max(n, min), max);
    if (!Number.isFinite(minutes)) {
      return fallback;
    }
    return clamp(minutes, 1, 24 * 60) * 60 * 1000;
  }

  function summarizeConfig(config) {
    const intervalMs = normalizeScanIntervalMs(config);
    return {
      tokens: config.tokens,
      geckoIds: config.tokens.map(t => t.geckoId),
      bbPeriod: config.strategy.bbPeriod,
      bbStdDev: config.strategy.bbStdDev,
      rsiPeriod: config.strategy.rsiPeriod,
      rsiBuyThreshold: config.strategy.rsiBuyThreshold,
      rsiSellThreshold: config.strategy.rsiSellThreshold,
      positionSizeUsdc: config.risk.positionSizeUsdc,
      takeProfitPct: config.risk.takeProfitPct,
      stopLossPct: config.risk.stopLossPct,
      maxOpenPositions: config.risk.maxOpenPositions,
      slippageBps: config.slippageBps,
      dryRun: config.dryRun,
      intervalMs,
    };
  }

  let runtime = summarizeConfig(initialConfig);

  // ── Process a single token using cached closes ─────────────────────────────────
  async function scanToken(token, currentPrice) {
    const {
      bbPeriod,
      bbStdDev,
      rsiPeriod,
      rsiBuyThreshold,
      rsiSellThreshold,
      takeProfitPct,
      stopLossPct,
      maxOpenPositions,
      slippageBps,
      dryRun,
    } = runtime;
    const { symbol, mint } = token;
    const result = { symbol, price: currentPrice.toFixed(4), rsi: null, signal: null };

    const closes = getCloses(token.geckoId);
    if (!closes) {
      console.warn(`[bot] No cached data for ${symbol} — skipping`);
      return result;
    }

    const minForRsi = rsiPeriod + 1;
    if (closes.length < minForRsi) {
      console.warn(
        `[bot] Not enough data for ${symbol} (${closes.length} closes, need ${minForRsi} for RSI / ${bbPeriod + 1} for BB)`
      );
      return result;
    }

    const rsiValue = rsi(closes, rsiPeriod);
    result.rsi = rsiValue;

    if (closes.length < bbPeriod + 1) {
      console.warn(
        `[bot] ${symbol} | RSI=${rsiValue.toFixed(1)} | need ${bbPeriod + 1} hourly closes for Bollinger/trading (have ${closes.length})`
      );
      return result;
    }

    const bb = bollingerBands(closes, bbPeriod, bbStdDev);

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
    try {
      const latestConfig = await loadConfig();
      runtime = summarizeConfig(latestConfig);
    } catch (e) {
      console.error(`[bot] Failed to reload config from DB (using previous): ${e.message}`);
    }

    const {
      tokens,
      geckoIds,
      bbPeriod,
      bbStdDev,
      rsiPeriod,
      rsiBuyThreshold,
      rsiSellThreshold,
      positionSizeUsdc,
      takeProfitPct,
      stopLossPct,
      maxOpenPositions,
      dryRun,
      intervalMs,
    } = runtime;

    console.log(`\n[bot] === Scan at ${new Date().toISOString()} ===`);
    console.log(`[bot] Mode: ${dryRun ? 'DRY RUN' : 'LIVE'} | Open positions: ${openPositionCount()}/${maxOpenPositions}`);
    printStats();

    if (!dryRun && wallet) {
      try {
        const balances = await getWalletBalances({ connection, wallet });
        console.log(`[bot] Wallet balances: ${balances.sol.toFixed(4)} SOL | $${balances.usdc.toFixed(2)} USDC`);
      } catch (e) {
        console.error(`[bot] Failed to fetch wallet balances: ${e.message}`);
      }
    }

    const minClosesForIndicators = Math.max(bbPeriod + 1, rsiPeriod + 1);
    if (isHistoryStale(geckoIds, minClosesForIndicators)) {
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

    const minutes = Math.round(intervalMs / 60000);
    console.log(`\n[bot] Next scan in ${minutes} minute(s). Ctrl+C to stop.`);
  }

  function scheduleNextRun() {
    const intervalMs = runtime.intervalMs ?? 30 * 60 * 1000;
    setTimeout(async () => {
      await runOnce();
      scheduleNextRun();
    }, intervalMs);
  }

  console.log('[bot] Sol Scalper Bot starting up...');
  console.log(`[bot] Strategy: BB(${runtime.bbPeriod}, ${runtime.bbStdDev}) + RSI(${runtime.rsiPeriod}) | Buy RSI<${runtime.rsiBuyThreshold} | Sell RSI>${runtime.rsiSellThreshold}`);
  console.log(`[bot] Risk: $${runtime.positionSizeUsdc}/trade | TP:+${runtime.takeProfitPct}% | SL:-${runtime.stopLossPct}% | Max:${runtime.maxOpenPositions}`);
  console.log(`[bot] Tokens: ${runtime.tokens.map(t => t.symbol).join(', ')}`);
  console.log(`[bot] Scan interval: ${Math.round(runtime.intervalMs / 60000)} minute(s) (config key: scanIntervalMinutes)`);

  await loadPositions();
  await runOnce();
  scheduleNextRun();
}

main().catch(e => {
  console.error('[bot] Fatal error:', e);
  process.exit(1);
});
