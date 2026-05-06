/**
 * executor.js — Jupiter swap execution.
 * Handles quote → swap → sign → broadcast.
 */

import fetch from 'node-fetch';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';

import { uiAmountToRawFloorBigInt } from './tokenAmount.js';

/** Classic SPL Token program — fetch all parsed token accounts for an owner in one RPC. */
const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

// Jupiter deprecated quote-api.jup.ag/v6/*; Swap API V2 lives on api.jup.ag.
const JUPITER_BASE = 'https://api.jup.ag/swap/v2';
const USDC_MINT     = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;
const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Build a keypair from WALLET_SECRET_KEY env value: JSON array of secret key bytes.
 * @param {string} jsonString
 * @returns {Keypair}
 */
export function keypairFromSecretKeyJson(jsonString) {
  const raw = JSON.parse(jsonString);
  if (!Array.isArray(raw)) {
    throw new Error('Wallet secret must be a JSON array of numbers (secret key bytes)');
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function getSolBalanceLamports({ connection, wallet }) {
  return connection.getBalance(wallet.publicKey, 'confirmed');
}

async function getUsdcBalanceUi({ connection, wallet }) {
  const mint = new PublicKey(USDC_MINT);
  const res = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint }, 'confirmed');
  const uiAmounts = res.value
    .map((acc) => {
      const tokenAmount = acc.account.data?.parsed?.info?.tokenAmount;
      const ui = tokenAmount?.uiAmount;
      return typeof ui === 'number' ? ui : 0;
    });
  return uiAmounts.reduce((sum, n) => sum + n, 0);
}

/**
 * Fetch wallet balances via Solana RPC.
 * @param {{ connection: Connection, wallet: Keypair }} params
 * @returns {Promise<{ sol: number, usdc: number }>}
 */
export async function getWalletBalances({ connection, wallet }) {
  const [lamports, usdc] = await Promise.all([
    getSolBalanceLamports({ connection, wallet }),
    getUsdcBalanceUi({ connection, wallet }),
  ]);

  return {
    sol: lamports / LAMPORTS_PER_SOL,
    usdc,
  };
}

/**
 * Sum UI token amounts per mint for the given mint list (one RPC over all SPL token accounts).
 * @param {{ connection: Connection, wallet: Keypair, mints: string[] }} params
 * @returns {Promise<Map<string, number>>} mint address → summed ui amount
 */
export async function getTrackedTokenBalances({ connection, wallet, mints }) {
  const mintSet = new Set(mints);
  const balances = new Map(mints.map((m) => [m, 0]));
  const res = await connection.getParsedTokenAccountsByOwner(
    wallet.publicKey,
    { programId: SPL_TOKEN_PROGRAM_ID },
    'confirmed'
  );

  for (const { account } of res.value) {
    const info = account.data?.parsed?.info;
    const mintStr = info?.mint;
    if (!mintStr || !mintSet.has(mintStr)) {
      continue;
    }
    const ui = info?.tokenAmount?.uiAmount;
    const n = typeof ui === 'number' && !Number.isNaN(ui) ? ui : 0;
    balances.set(mintStr, (balances.get(mintStr) ?? 0) + n);
  }

  return balances;
}

/**
 * Read SPL mint decimals from chain (classic spl-token mint layout).
 * @param {Connection} connection
 * @param {string} mintBase58
 * @returns {Promise<number>}
 */
async function getMintDecimals(connection, mintBase58) {
  const mint = new PublicKey(mintBase58);
  const res = await connection.getParsedAccountInfo(mint, 'confirmed');
  const parsed = res.value?.data;
  if (!parsed || typeof parsed !== 'object' || !('parsed' in parsed)) {
    throw new Error(`Could not parse mint account for ${mintBase58}`);
  }
  const info = parsed.parsed?.info;
  const d = info?.decimals;
  if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 18) {
    throw new Error(`Invalid or missing decimals on mint ${mintBase58}`);
  }
  return d;
}

/**
 * Get a Jupiter quote for buying `outputMint` with USDC.
 * @param {string} outputMint
 * @param {number} usdcAmount  — in whole USDC (e.g. 25)
 * @param {number} slippageBps
 * @returns {Promise<object>} Jupiter quote response
 */
export async function getQuote({ outputMint, usdcAmount, slippageBps }) {
  const amountIn = Math.floor(usdcAmount * Math.pow(10, USDC_DECIMALS));
  const url = new URL(`${JUPITER_BASE}/order`);
  url.searchParams.set('inputMint', USDC_MINT);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', amountIn.toString());

  // Optional: setting slippage may restrict routing mode, but we want explicit behavior.
  url.searchParams.set('slippageBps', slippageBps.toString());

  const headers = {};
  if (process.env.JUPITER_API_KEY) {
    headers['x-api-key'] = process.env.JUPITER_API_KEY;
  }

  const res = await fetch(url.toString(), { headers });
  if (!res.ok) throw new Error(`Jupiter /order failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Get a Jupiter quote for selling `inputMint` back to USDC (ExactIn).
 * @param {string} inputMint
 * @param {bigint} inputAmountRaw  — atomic amount (smallest units), per Jupiter API
 * @param {number} slippageBps
 * @returns {Promise<object>}
 */
export async function getSellQuote({ inputMint, inputAmountRaw, slippageBps }) {
  const url = new URL(`${JUPITER_BASE}/order`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', USDC_MINT);
  url.searchParams.set('amount', inputAmountRaw.toString());
  url.searchParams.set('slippageBps', slippageBps.toString());

  const headers = {};
  if (process.env.JUPITER_API_KEY) {
    headers['x-api-key'] = process.env.JUPITER_API_KEY;
  }

  const res = await fetch(url.toString(), { headers });
  if (!res.ok) throw new Error(`Jupiter /order failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Execute a Jupiter swap (buy or sell) using Swap API V2 Order+Execute.
 * @param {object} params
 * @param {object} params.order        — Jupiter order object (must include transaction + requestId)
 * @param {Keypair} params.wallet
 * @param {Connection} params.connection
 * @returns {Promise<{ txid: string, outputAmount: number }>}
 */
export async function executeSwap({ order, wallet, connection }) {
  if (!order?.transaction || !order?.requestId) {
    throw new Error('Jupiter order is missing transaction/requestId (did you pass taker?)');
  }

  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
  tx.sign([wallet]);
  const signedTransaction = Buffer.from(tx.serialize()).toString('base64');

  const headers = { 'Content-Type': 'application/json' };
  if (process.env.JUPITER_API_KEY) {
    headers['x-api-key'] = process.env.JUPITER_API_KEY;
  }

  const execRes = await fetch(`${JUPITER_BASE}/execute`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      signedTransaction,
      requestId: order.requestId,
    }),
  });
  if (!execRes.ok) {
    throw new Error(`Jupiter /execute failed: ${execRes.status} ${await execRes.text()}`);
  }

  const result = await execRes.json();
  const txid = result.signature;
  if (!txid) {
    throw new Error(`Jupiter /execute returned no signature: ${JSON.stringify(result)}`);
  }

  // Confirm via our RPC as an extra safety check (execute does its own landing/confirm, but this verifies visibility).
  try {
    await connection.confirmTransaction(txid, 'confirmed');
  } catch (_) {
    // ignore: the tx may already be confirmed or RPC may lag; callers rely on /execute response anyway.
  }

  return {
    txid,
    outputAmount: Number(result.outputAmountResult ?? order.outAmount ?? 0),
  };
}

/**
 * High-level buy: USDC → token.
 * In dryRun mode, logs the intent and returns a mock result.
 *
 * @param {object} params
 * @param {string} params.symbol
 * @param {string} params.mint
 * @param {number} params.usdcAmount
 * @param {number} params.slippageBps
 * @param {Keypair} params.wallet
 * @param {Connection} params.connection
 * @param {boolean} params.dryRun
 * @param {number} params.currentPrice   — used for dry-run token amount estimate
 * @returns {Promise<{ txid: string | null, tokenAmount: number, entryPrice: number, openedAt: string }>}
 */
export async function buy({ symbol, mint, usdcAmount, slippageBps, wallet, connection, dryRun, currentPrice }) {
  if (dryRun) {
    const tokenAmount = usdcAmount / currentPrice;
    const openedAt = new Date().toISOString();
    console.log(`[executor] DRY RUN BUY ${symbol}: $${usdcAmount} USDC @ $${currentPrice.toFixed(6)} = ${tokenAmount.toFixed(6)} tokens`);
    return { txid: null, tokenAmount, entryPrice: currentPrice, openedAt };
  }

  if (!wallet) {
    throw new Error('Wallet is required for live trading');
  }
  if (!connection) {
    throw new Error('Connection is required for live trading');
  }

  const balances = await getWalletBalances({ connection, wallet });
  const minSolForFees = 0.005;
  if (balances.sol < minSolForFees) {
    throw new Error(`Insufficient SOL for fees: have ${balances.sol.toFixed(4)} SOL, need >= ${minSolForFees} SOL`);
  }
  if (balances.usdc < usdcAmount) {
    throw new Error(`Insufficient USDC: have $${balances.usdc.toFixed(2)}, need $${usdcAmount.toFixed(2)}`);
  }

  const orderUrl = new URL(`${JUPITER_BASE}/order`);
  orderUrl.searchParams.set('inputMint', USDC_MINT);
  orderUrl.searchParams.set('outputMint', mint);
  orderUrl.searchParams.set('amount', Math.floor(usdcAmount * Math.pow(10, USDC_DECIMALS)).toString());
  orderUrl.searchParams.set('slippageBps', slippageBps.toString());
  orderUrl.searchParams.set('taker', wallet.publicKey.toBase58());

  const orderHeaders = {};
  if (process.env.JUPITER_API_KEY) {
    orderHeaders['x-api-key'] = process.env.JUPITER_API_KEY;
  }
  const orderRes = await fetch(orderUrl.toString(), { headers: orderHeaders });
  if (!orderRes.ok) {
    throw new Error(`Jupiter /order failed: ${orderRes.status} ${await orderRes.text()}`);
  }
  const order = await orderRes.json();

  const { txid, outputAmount } = await executeSwap({ order, wallet, connection });
  const openedAt = new Date().toISOString();

  const decimals = await getMintDecimals(connection, mint);
  const tokenAmount = outputAmount / Math.pow(10, decimals);
  const entryPrice = usdcAmount / tokenAmount;

  console.log(`[executor] BUY ${symbol}: tx=${txid}, tokens=${tokenAmount.toFixed(6)}, entry=$${entryPrice.toFixed(6)}`);
  return { txid, tokenAmount, entryPrice, openedAt };
}

/**
 * High-level sell: token → USDC.
 * In dryRun mode, logs and returns mock result.
 *
 * @param {object} params
 * @param {string} params.symbol
 * @param {string} params.mint
 * @param {number} params.tokenAmount   — UI amount (human tokens); same units as stored in open_positions
 * @param {number} params.slippageBps
 * @param {Keypair} params.wallet
 * @param {Connection} params.connection
 * @param {boolean} params.dryRun
 * @param {number} params.currentPrice
 * @returns {Promise<{ txid: string | null, usdcReceived: number }>}
 */
export async function sell({ symbol, mint, tokenAmount, slippageBps, wallet, connection, dryRun, currentPrice }) {
  if (dryRun) {
    const usdcReceived = tokenAmount * currentPrice;
    console.log(`[executor] DRY RUN SELL ${symbol}: ${tokenAmount.toFixed(6)} tokens @ $${currentPrice.toFixed(6)} = $${usdcReceived.toFixed(2)} USDC`);
    return { txid: null, usdcReceived };
  }

  if (!wallet) {
    throw new Error('Wallet is required for live trading');
  }
  if (!connection) {
    throw new Error('Connection is required for live trading');
  }

  const minSolForFees = 0.005;
  const solLamports = await getSolBalanceLamports({ connection, wallet });
  const sol = solLamports / LAMPORTS_PER_SOL;
  if (sol < minSolForFees) {
    throw new Error(`Insufficient SOL for fees: have ${sol.toFixed(4)} SOL, need >= ${minSolForFees} SOL`);
  }

  const decimals = await getMintDecimals(connection, mint);
  const inputAmountRaw = uiAmountToRawFloorBigInt(tokenAmount, decimals);
  if (inputAmountRaw < 1n) {
    throw new Error(
      `Sell amount rounds to zero atomic units for ${symbol} (ui=${tokenAmount}, decimals=${decimals})`
    );
  }

  const orderUrl = new URL(`${JUPITER_BASE}/order`);
  orderUrl.searchParams.set('inputMint', mint);
  orderUrl.searchParams.set('outputMint', USDC_MINT);
  orderUrl.searchParams.set('amount', inputAmountRaw.toString());
  orderUrl.searchParams.set('slippageBps', slippageBps.toString());
  orderUrl.searchParams.set('taker', wallet.publicKey.toBase58());

  const orderHeaders = {};
  if (process.env.JUPITER_API_KEY) {
    orderHeaders['x-api-key'] = process.env.JUPITER_API_KEY;
  }
  const orderRes = await fetch(orderUrl.toString(), { headers: orderHeaders });
  if (!orderRes.ok) {
    throw new Error(`Jupiter /order failed: ${orderRes.status} ${await orderRes.text()}`);
  }
  const order = await orderRes.json();

  const { txid, outputAmount } = await executeSwap({ order, wallet, connection });
  const usdcReceived = outputAmount / Math.pow(10, USDC_DECIMALS);

  console.log(`[executor] SELL ${symbol}: tx=${txid}, received=$${usdcReceived.toFixed(2)} USDC`);
  return { txid, usdcReceived };
}
