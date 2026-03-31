/**
 * executor.js — Jupiter swap execution.
 * Handles quote → swap → sign → broadcast.
 */

import fetch from 'node-fetch';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';

const JUPITER_QUOTE = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP  = 'https://quote-api.jup.ag/v6/swap';
const USDC_MINT     = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;

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
 * Get a Jupiter quote for selling `inputMint` back to USDC.
 * @param {string} inputMint
 * @param {number} tokenAmount  — in raw token units (lamports/smallest unit)
 * @param {number} slippageBps
 * @returns {Promise<object>}
 */
export async function getSellQuote({ inputMint, tokenAmount, slippageBps }) {
  const url = new URL(JUPITER_QUOTE);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', USDC_MINT);
  url.searchParams.set('amount', Math.floor(tokenAmount).toString());
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
 * @returns {Promise<{ txid: string | null, tokenAmount: number, entryPrice: number }>}
 */
export async function buy({ symbol, mint, usdcAmount, slippageBps, wallet, connection, dryRun, currentPrice }) {
  if (dryRun) {
    const tokenAmount = usdcAmount / currentPrice;
    console.log(`[executor] DRY RUN BUY ${symbol}: $${usdcAmount} USDC @ $${currentPrice.toFixed(6)} = ${tokenAmount.toFixed(6)} tokens`);
    return { txid: null, tokenAmount, entryPrice: currentPrice };
  }

  const quote = await getQuote({ outputMint: mint, usdcAmount, slippageBps });
  const { txid, outputAmount } = await executeSwap({ quote, wallet, connection });

  // Derive token decimals from quote metadata (outDecimals)
  const decimals = quote.outputMint === USDC_MINT ? USDC_DECIMALS : (quote.outDecimals ?? 9);
  const tokenAmount = outputAmount / Math.pow(10, decimals);
  const entryPrice = usdcAmount / tokenAmount;

  console.log(`[executor] BUY ${symbol}: tx=${txid}, tokens=${tokenAmount.toFixed(6)}, entry=$${entryPrice.toFixed(6)}`);
  return { txid, tokenAmount, entryPrice };
}

/**
 * High-level sell: token → USDC.
 * In dryRun mode, logs and returns mock result.
 *
 * @param {object} params
 * @param {string} params.symbol
 * @param {string} params.mint
 * @param {number} params.tokenAmount   — raw token amount (smallest unit)
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

  const quote = await getSellQuote({ inputMint: mint, tokenAmount, slippageBps });
  const { txid, outputAmount } = await executeSwap({ quote, wallet, connection });
  const usdcReceived = outputAmount / Math.pow(10, USDC_DECIMALS);

  console.log(`[executor] SELL ${symbol}: tx=${txid}, received=$${usdcReceived.toFixed(2)} USDC`);
  return { txid, usdcReceived };
}
