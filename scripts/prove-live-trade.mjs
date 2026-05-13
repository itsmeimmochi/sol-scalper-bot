/**
 * One-time live trading proof script (local).
 *
 * Goals:
 * - Make it trivial to generate/print a dedicated test wallet address (so you know where to send SOL/USDC).
 * - Exercise the existing Jupiter execution path (quote -> swap -> sign -> send -> confirm) in a controlled way.
 *
 * Safety:
 * - Defaults to quote-only. You must pass --execute to actually swap.
 * - Defaults to a very small USDC amount.
 */
import 'dotenv/config';
import { Connection, Keypair } from '@solana/web3.js';
import { ensureSchema, loadConfig } from '../lib/db.js';
import { buy, sell, keypairFromSecretKeyJson, getWalletBalances, getQuote, getSellQuote } from '../lib/executor.js';
import { loadPositions, persistBuyOpenWithRetries, persistSellCloseWithRetries } from '../lib/positions.js';

function parseArgs(argv) {
  const raw = argv.slice(2);
  const flags = new Set(raw.filter((a) => a.startsWith('--')));

  const valueOf = (name) => {
    const idx = raw.indexOf(name);
    if (idx === -1) {
      return null;
    }
    const next = raw[idx + 1];
    if (!next || next.startsWith('--')) {
      return null;
    }
    return next;
  };

  const symbol = valueOf('--symbol');
  const mint = valueOf('--mint');
  const usdcAmountStr = valueOf('--usdc');
  const bootstrapSolStr = valueOf('--bootstrap-sol');
  const slippageBpsStr = valueOf('--slippage-bps');
  const execute = flags.has('--execute');
  const persist = flags.has('--persist');
  const skipSell = flags.has('--skip-sell');
  const bootstrapUsdc = flags.has('--bootstrap-usdc');
  const help = flags.has('--help') || flags.has('-h');

  return {
    help,
    execute,
    persist,
    skipSell,
    bootstrapUsdc,
    symbol: typeof symbol === 'string' ? symbol.trim().toUpperCase() : null,
    mint: typeof mint === 'string' ? mint.trim() : null,
    usdcAmount: usdcAmountStr == null ? null : Number(usdcAmountStr),
    bootstrapSol: bootstrapSolStr == null ? null : Number(bootstrapSolStr),
    slippageBps: slippageBpsStr == null ? null : Number(slippageBpsStr),
  };
}

function printHelp() {
  console.log(`
Usage:
  node scripts/prove-live-trade.mjs [--symbol SOL] [--usdc 1] [--slippage-bps 50] [--execute] [--persist]

What it does:
  - If WALLET_SECRET_KEY is missing, prints a brand-new wallet address + secret to export, then exits.
  - Otherwise loads config from Postgres, picks a token (by --symbol/--mint or first enabled token),
    and runs a small buy->sell roundtrip.

Safety:
  - Default is quote-only. Add --execute to broadcast real swaps.
  - Add --persist to write open/close rows into Postgres using the same persistence helpers as the bot.

Flags:
  --symbol <SYMBOL>       Token symbol from DB config (e.g. SOL)
  --mint <MINT>           Token mint (overrides --symbol if both provided)
  --usdc <AMOUNT>         USDC size for buy (default: 1)
  --bootstrap-usdc        If wallet USDC is insufficient, swap SOL->USDC first (requires --execute)
  --bootstrap-sol <SOL>   SOL amount to swap when bootstrapping USDC (default: 0.02)
  --slippage-bps <BPS>    Slippage in bps (default: config slippageBps)
  --execute               Actually execute swaps (otherwise quote-only)
  --persist               Persist open_position + trade in DB (requires --execute)
  --skip-sell             Only do the buy step
  --help, -h              Show help

Env:
  DATABASE_URL            Required (Postgres)
  WALLET_SECRET_KEY       Required to execute swaps (JSON secret key bytes)
`);
}

function generateWalletAndExit() {
  const keypair = Keypair.generate();
  const secretJson = JSON.stringify(Array.from(keypair.secretKey));
  console.log('✅ Generated dedicated test wallet.');
  console.log(`   Public key: ${keypair.publicKey.toBase58()}`);
  console.log('');
  console.log('   Export this for the script/bot:');
  console.log(`   WALLET_SECRET_KEY=${secretJson}`);
  console.log('');
  console.log('Send SOL/USDC to:');
  console.log(`   ${keypair.publicKey.toBase58()}`);
  process.exit(0);
}

function pickToken({ tokens, symbol, mint }) {
  if (mint) {
    const byMint = tokens.find((t) => t.mint === mint);
    if (byMint) {
      return byMint;
    }
    throw new Error(`No enabled token in DB config has mint ${mint}`);
  }

  if (symbol) {
    const bySymbol = tokens.find((t) => t.symbol === symbol);
    if (bySymbol) {
      return bySymbol;
    }
    throw new Error(`No enabled token in DB config has symbol ${symbol}`);
  }

  const first = tokens[0];
  if (!first) {
    throw new Error('No enabled tokens in config');
  }
  return first;
}

function requireFinitePositiveNumber(n, label) {
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${label}: ${n}`);
  }
  return n;
}

async function bootstrapUsdcIfNeeded({ connection, wallet, slippageBps, targetUsdc, bootstrapSol }) {
  const balances = await getWalletBalances({ connection, wallet });
  const hasEnough = balances.usdc >= targetUsdc;
  if (hasEnough) {
    return { didBootstrap: false, balances };
  }

  const solToSwap = requireFinitePositiveNumber(bootstrapSol ?? 0.02, '--bootstrap-sol');
  console.log(
    `[prove-live] Bootstrapping USDC: wallet has $${balances.usdc.toFixed(2)} USDC (< $${targetUsdc.toFixed(
      2
    )}); swapping ${solToSwap.toFixed(6)} SOL -> USDC first`
  );

  const res = await sell({
    symbol: 'SOL',
    mint: 'So11111111111111111111111111111111111111112',
    tokenAmount: solToSwap,
    slippageBps,
    wallet,
    connection,
    dryRun: false,
    currentPrice: 0,
  });

  console.log(`[prove-live] Bootstrap swap done: tx=${res.txid} | received≈$${res.usdcReceived.toFixed(2)} USDC`);
  const after = await getWalletBalances({ connection, wallet });
  return { didBootstrap: true, balances: after };
}

async function quoteOnlyRoundtrip({ token, usdcAmount, slippageBps }) {
  console.log(`[prove-live] Quote-only mode.`);
  const buyQuote = await getQuote({ outputMint: token.mint, usdcAmount, slippageBps });
  console.log(
    `[prove-live] BUY quote ok: in=$${usdcAmount.toFixed(2)} USDC -> out=${buyQuote.outAmount} (raw units), route=${buyQuote.routePlan?.length ?? 0} hop(s)`
  );

  const outDecimals = buyQuote.outDecimals ?? 9;
  const tokenUi = Number(buyQuote.outAmount) / Math.pow(10, outDecimals);
  const inputAmountRaw = BigInt(buyQuote.outAmount);
  const sellQuote = await getSellQuote({ inputMint: token.mint, inputAmountRaw, slippageBps });
  console.log(
    `[prove-live] SELL quote ok: in≈${tokenUi.toFixed(8)} ${token.symbol} -> out=${sellQuote.outAmount} (raw USDC), route=${sellQuote.routePlan?.length ?? 0} hop(s)`
  );
}

async function executeRoundtrip({ token, usdcAmount, slippageBps, wallet, connection, persist, skipSell }) {
  const before = await getWalletBalances({ connection, wallet });
  console.log(
    `[prove-live] Wallet before: ${before.sol.toFixed(4)} SOL | $${before.usdc.toFixed(2)} USDC | owner=${wallet.publicKey.toBase58()}`
  );

  const buyResult = await buy({
    symbol: token.symbol,
    mint: token.mint,
    usdcAmount,
    slippageBps,
    wallet,
    connection,
    dryRun: false,
    currentPrice: 0,
  });

  console.log(
    `[prove-live] BUY done: tx=${buyResult.txid} | tokens=${buyResult.tokenAmount.toFixed(8)} | entry≈$${buyResult.entryPrice.toFixed(6)}`
  );

  if (persist) {
    const openedAt = buyResult.openedAt;
    await persistBuyOpenWithRetries({
      symbol: token.symbol,
      mint: token.mint,
      entryPrice: buyResult.entryPrice,
      sizeUsdc: usdcAmount,
      tokenAmount: buyResult.tokenAmount,
      isSimulated: false,
      openedAt,
    });
    console.log('[prove-live] Persisted open_position (live lane).');
  }

  if (skipSell) {
    const afterBuy = await getWalletBalances({ connection, wallet });
    console.log(`[prove-live] Wallet after buy: ${afterBuy.sol.toFixed(4)} SOL | $${afterBuy.usdc.toFixed(2)} USDC`);
    return;
  }

  const sellResult = await sell({
    symbol: token.symbol,
    mint: token.mint,
    tokenAmount: buyResult.tokenAmount,
    slippageBps,
    wallet,
    connection,
    dryRun: false,
    currentPrice: 0,
  });

  console.log(`[prove-live] SELL done: tx=${sellResult.txid} | received≈$${sellResult.usdcReceived.toFixed(2)} USDC`);

  if (persist) {
    await persistSellCloseWithRetries(token.symbol, sellResult.exitPrice, 'prove-live-script', {
      symbol: token.symbol,
      mint: token.mint,
      entryPrice: buyResult.entryPrice,
      sizeUsdc: usdcAmount,
      tokenAmount: buyResult.tokenAmount,
      openedAt: buyResult.openedAt,
      isSimulated: false,
    }, false);
    console.log('[prove-live] Persisted close trade (live lane).');
  }

  const after = await getWalletBalances({ connection, wallet });
  console.log(`[prove-live] Wallet after: ${after.sol.toFixed(4)} SOL | $${after.usdc.toFixed(2)} USDC`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const secret = process.env.WALLET_SECRET_KEY;
  if (!secret) {
    generateWalletAndExit();
    return;
  }

  await ensureSchema();
  const config = await loadConfig();
  const token = pickToken({ tokens: config.tokens, symbol: args.symbol, mint: args.mint });

  const usdcAmount = requireFinitePositiveNumber(args.usdcAmount ?? 1, '--usdc');
  const slippageBps = requireFinitePositiveNumber(args.slippageBps ?? config.slippageBps, '--slippage-bps');

  console.log(`[prove-live] Selected: ${token.symbol} mint=${token.mint}`);
  console.log(`[prove-live] RPC: ${config.rpc}`);
  console.log(`[prove-live] Size: $${usdcAmount.toFixed(2)} USDC | Slippage: ${slippageBps} bps`);

  const wallet = keypairFromSecretKeyJson(secret);
  const connection = new Connection(config.rpc, 'confirmed');

  if (!args.execute) {
    await quoteOnlyRoundtrip({ token, usdcAmount, slippageBps });
    console.log('');
    console.log('[prove-live] To execute real swaps, re-run with --execute.');
    console.log(`[prove-live] Wallet address: ${wallet.publicKey.toBase58()}`);
    return;
  }

  const preBalances = await getWalletBalances({ connection, wallet });
  const needsUsdc = preBalances.usdc < usdcAmount;
  if (needsUsdc && !args.bootstrapUsdc) {
    console.error(
      `[prove-live] Fatal: wallet has $${preBalances.usdc.toFixed(2)} USDC, need $${usdcAmount.toFixed(
        2
      )} USDC to run the USDC-based test buy.`
    );
    console.error(
      `[prove-live] Re-run with SOL->USDC bootstrapping:\n` +
        `  npm run prove:live -- --symbol ${token.symbol} --usdc ${usdcAmount} --execute --bootstrap-usdc --bootstrap-sol 0.02`
    );
    process.exit(1);
  }

  if (args.persist) {
    await loadPositions();
  }

  if (args.persist && args.skipSell) {
    console.warn('[prove-live] Note: --persist + --skip-sell will leave an open_position row behind.');
  }

  if (args.bootstrapUsdc) {
    const boot = await bootstrapUsdcIfNeeded({
      connection,
      wallet,
      slippageBps,
      targetUsdc: usdcAmount,
      bootstrapSol: args.bootstrapSol,
    });
    console.log(
      `[prove-live] Wallet after bootstrap: ${boot.balances.sol.toFixed(4)} SOL | $${boot.balances.usdc.toFixed(
        2
      )} USDC`
    );
  }

  await executeRoundtrip({
    token,
    usdcAmount,
    slippageBps,
    wallet,
    connection,
    persist: args.persist,
    skipSell: args.skipSell,
  });
}

main().catch((e) => {
  const msg = String(e?.message ?? e ?? '');
  const stack = e?.stack || msg;

  const isDbConnRefused =
    msg.includes('ECONNREFUSED') && (msg.includes('127.0.0.1:5432') || msg.includes('localhost:5432'));
  if (isDbConnRefused) {
    console.error('[prove-live] Fatal: could not connect to Postgres.');
    console.error('  - Start the DB: docker compose up -d db');
    console.error('  - Ensure DATABASE_URL is set (see AGENTS.md for the default local URL).');
    process.exit(1);
  }

  const isJupiterDns =
    msg.includes('ENOTFOUND') && (msg.includes('quote-api.jup.ag') || msg.includes('jup.ag'));
  if (isJupiterDns) {
    console.error('[prove-live] Fatal: cannot resolve Jupiter Quote API hostname (DNS).');
    console.error('  - Check that your machine has internet access and DNS is working.');
    console.error('  - Quick check: nslookup quote-api.jup.ag');
    console.error('  - If you are on a restricted network/VPN, try switching networks or DNS (e.g. 1.1.1.1 / 8.8.8.8).');
    process.exit(1);
  }

  console.error('[prove-live] Fatal:', stack);
  process.exit(1);
});
