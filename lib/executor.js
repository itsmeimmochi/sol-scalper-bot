/**
 * executor.js — Jupiter swap execution.
 * Handles quote → swap → sign → broadcast.
 */

import fetch from 'node-fetch';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';

import { uiAmountToRawFloorBigInt } from './tokenAmount.js';

/** Classic SPL Token program — fetch all parsed token accounts for an owner in one RPC. */
const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

const JUPITER_QUOTE = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP  = 'https://quote-api.jup.ag/v6/swap';
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
  const url = new URL(JUPITER_QUOTE);
  url.searchParams.set('inputMint', USDC_MINT);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', amountIn.toString());
  url.searchParams.set('slippageBps', slippageBps.toString());

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Jupiter quote failed: ${res.status} ${await res.text()}`);
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
  const url = new URL(JUPITER_QUOTE);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', USDC_MINT);
  url.searchParams.set('amount', inputAmountRaw.toString());
  url.searchParams.set('slippageBps', slippageBps.toString());

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Jupiter sell quote failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Execute a Jupiter swap (buy or sell).
 * @param {object} params
 * @param {object} params.quote        — Jupiter quote object
 * @param {Keypair} params.wallet
 * @param {Connection} params.connection
 * @returns {Promise<{ txid: string, outputAmount: number }>}
 */
export async function executeSwap({ quote, wallet, connection }) {
  // Get swap transaction from Jupiter
  const swapRes = await fetch(JUPITER_SWAP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
    }),
  });

  if (!swapRes.ok) {
    throw new Error(`Jupiter swap request failed: ${swapRes.status} ${await swapRes.text()}`);
  }

  const { swapTransaction } = await swapRes.json();

  // Deserialize, sign, send
  const txBuffer = Buffer.from(swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuffer);
  tx.sign([wallet]);

  const txid = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  await connection.confirmTransaction(txid, 'confirmed');

  return {
    txid,
    outputAmount: Number(quote.outAmount),
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

  const quote = await getQuote({ outputMint: mint, usdcAmount, slippageBps });
  const { txid, outputAmount } = await executeSwap({ quote, wallet, connection });
  const openedAt = new Date().toISOString();

  // Derive token decimals from quote metadata (outDecimals)
  const decimals = quote.outputMint === USDC_MINT ? USDC_DECIMALS : (quote.outDecimals ?? 9);
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

  const quote = await getSellQuote({ inputMint: mint, inputAmountRaw, slippageBps });
  const { txid, outputAmount } = await executeSwap({ quote, wallet, connection });
  const usdcReceived = outputAmount / Math.pow(10, USDC_DECIMALS);

  console.log(`[executor] SELL ${symbol}: tx=${txid}, received=$${usdcReceived.toFixed(2)} USDC`);
  return { txid, usdcReceived };
}
