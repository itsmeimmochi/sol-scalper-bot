/**
 * positions.js — In-memory position tracking backed by PostgreSQL.
 *
 * Position shape:
 * {
 *   symbol, mint, entryPrice, sizeUsdc, tokenAmount, openedAt,
 *   isSimulated: boolean  — true = paper / dry run, false = on-chain live
 * }
 *
 * Trade record shape includes isSimulated.
 */

import { getPool } from './db.js';
import { getTrackedTokenBalances } from './executor.js';
import { positionKey } from './positionKey.js';

const RECONCILE_DUST_USD = 0.5;

// In-memory store: `${symbol}:${lane}` → position
let _positions = {};
// All closed trades
let _trades = [];

function iso(d) {
  if (d instanceof Date) {
    return d.toISOString();
  }
  return d;
}

function rowToPosition(row) {
  return {
    symbol: row.symbol,
    mint: row.mint,
    entryPrice: Number(row.entry_price),
    sizeUsdc: Number(row.size_usdc),
    tokenAmount: Number(row.token_amount),
    openedAt: iso(row.opened_at),
    isSimulated: row.is_simulated !== false,
  };
}

function rowToTrade(row) {
  return {
    symbol: row.symbol,
    entryPrice: Number(row.entry_price),
    exitPrice: Number(row.exit_price),
    sizeUsdc: Number(row.size_usdc),
    pnlPct: Number(row.pnl_pct),
    pnlUsdc: Number(row.pnl_usdc),
    reason: row.reason,
    openedAt: iso(row.opened_at),
    closedAt: iso(row.closed_at),
    won: row.won,
    isSimulated: row.is_simulated !== false,
  };
}

function matchesLane(position, dryRun) {
  return position.isSimulated === dryRun;
}

/**
 * Load positions and trade history from the database. Call once at startup (and after full reconcile).
 */
export async function loadPositions() {
  const pool = getPool();
  const posRes = await pool.query(
    `SELECT symbol, mint, entry_price, size_usdc, token_amount, opened_at, is_simulated
     FROM open_positions`
  );
  _positions = {};
  for (const row of posRes.rows) {
    const pos = rowToPosition(row);
    _positions[positionKey(pos.symbol, pos.isSimulated)] = pos;
  }
  console.log(`[positions] Loaded ${Object.keys(_positions).length} open positions from database.`);

  const tradesRes = await pool.query(
    `SELECT symbol, entry_price, exit_price, size_usdc, pnl_pct, pnl_usdc, reason, opened_at, closed_at, won, is_simulated
     FROM trades ORDER BY id ASC`
  );
  _trades = tradesRes.rows.map(rowToTrade);
  console.log(`[positions] Loaded ${_trades.length} historical trades from database.`);
}

/**
 * @param {boolean} dryRun — true = simulated lane (paper), false = live lane
 */
export function hasPosition(symbol, dryRun) {
  const p = _positions[positionKey(symbol, dryRun)];
  return !!p;
}

/**
 * @param {boolean} dryRun
 * @returns {object | null}
 */
export function getPosition(symbol, dryRun) {
  return _positions[positionKey(symbol, dryRun)] ?? null;
}

/** @returns {object[]} */
export function getAllPositions() {
  return Object.values(_positions);
}

/**
 * @param {boolean} dryRun
 * @returns {number}
 */
export function openPositionCount(dryRun) {
  return Object.values(_positions).filter((p) => matchesLane(p, dryRun)).length;
}

/**
 * Remove all simulated open rows from DB and memory (call at start of each live scan).
 */
export async function purgeSimulatedOpenPositionsFromDb() {
  await getPool().query('DELETE FROM open_positions WHERE is_simulated = true');
  const next = {};
  for (const sym of Object.keys(_positions)) {
    const p = _positions[sym];
    if (!p.isSimulated) {
      next[sym] = p;
    }
  }
  _positions = next;
}

/**
 * Align live open_positions with wallet: drop stale rows below dust; adopt wallet-held tracked tokens.
 * @param {{ connection: import('@solana/web3.js').Connection, wallet: import('@solana/web3.js').Keypair, tokens: { symbol: string, mint: string, geckoId: string }[], currentPrices: Map<string, number>, maxOpenPositions: number }} params
 */
export async function reconcileLiveOpenPositionsWithWallet({
  connection,
  wallet,
  tokens,
  currentPrices,
  maxOpenPositions,
}) {
  const mints = tokens.map((t) => t.mint);
  const balances = await getTrackedTokenBalances({ connection, wallet, mints });
  const geckoByMint = new Map(tokens.map((t) => [t.mint, t.geckoId]));
  const pool = getPool();

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const liveRowsRes = await client.query(
      `SELECT symbol, mint FROM open_positions WHERE is_simulated = false`
    );
    const liveRows = liveRowsRes.rows;

    const pruneSymbols = liveRows
      .map((row) => {
        const geckoId = geckoByMint.get(row.mint);
        const price = geckoId != null ? currentPrices.get(geckoId) : null;
        const ui = balances.get(row.mint) ?? 0;
        const notional = price != null && Number.isFinite(price) && price > 0 ? ui * price : 0;
        const belowDust = notional < RECONCILE_DUST_USD;
        return belowDust ? row.symbol : null;
      })
      .filter(Boolean);

    for (const sym of pruneSymbols) {
      await client.query('DELETE FROM open_positions WHERE symbol = $1 AND is_simulated = false', [sym]);
      console.log(
        `[positions] Wallet reconcile: removed stale live row ${sym} (wallet below $${RECONCILE_DUST_USD} notional or missing price)`
      );
    }

    const remainingRes = await client.query(
      `SELECT symbol FROM open_positions WHERE is_simulated = false`
    );
    const openLiveSymbols = new Set(remainingRes.rows.map((r) => r.symbol));
    let liveCount = openLiveSymbols.size;

    const adoptOrdered = tokens.filter((t) => {
      const price = currentPrices.get(t.geckoId);
      if (price == null || !Number.isFinite(price) || price <= 0) {
        return false;
      }
      const ui = balances.get(t.mint) ?? 0;
      const notional = ui * price;
      if (notional < RECONCILE_DUST_USD) {
        return false;
      }
      return !openLiveSymbols.has(t.symbol);
    });

    /** @type {{ symbol: string, mint: string, entryPrice: number, sizeUsdc: number, tokenAmount: number, openedAt: string }[]} */
    const adopted = [];

    for (const t of adoptOrdered) {
      if (liveCount >= maxOpenPositions) {
        break;
      }
      const ui = balances.get(t.mint) ?? 0;
      const price = currentPrices.get(t.geckoId);
      const computedSize = ui * price;
      const openedAt = new Date().toISOString();
      await client.query(
        `INSERT INTO open_positions (symbol, mint, entry_price, size_usdc, token_amount, opened_at, is_simulated)
         VALUES ($1, $2, $3, $4, $5, $6, false)`,
        [t.symbol, t.mint, price, computedSize, ui, openedAt]
      );
      adopted.push({
        symbol: t.symbol,
        mint: t.mint,
        entryPrice: price,
        sizeUsdc: computedSize,
        tokenAmount: ui,
        openedAt,
      });
      openLiveSymbols.add(t.symbol);
      liveCount += 1;
      console.log(`[positions] Wallet reconcile: adopted live position ${t.symbol} from on-chain balance`);
    }

    await client.query('COMMIT');

    for (const sym of pruneSymbols) {
      delete _positions[positionKey(sym, false)];
    }
    for (const a of adopted) {
      _positions[positionKey(a.symbol, false)] = {
        symbol: a.symbol,
        mint: a.mint,
        entryPrice: a.entryPrice,
        sizeUsdc: a.sizeUsdc,
        tokenAmount: a.tokenAmount,
        openedAt: a.openedAt,
        isSimulated: false,
      };
    }
  } catch (e) {
    try {
      await client?.query('ROLLBACK');
    } catch (_) {
      /* ignore rollback errors */
    }
    throw e;
  } finally {
    client?.release();
  }

  await loadPositions();
}

function buildTradeRecord(pos, exitPrice, reason) {
  const rawPnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
  const pnlUsdc = pos.sizeUsdc * (rawPnlPct / 100);
  return {
    symbol: pos.symbol,
    entryPrice: pos.entryPrice,
    exitPrice,
    sizeUsdc: pos.sizeUsdc,
    pnlPct: parseFloat(rawPnlPct.toFixed(4)),
    pnlUsdc: parseFloat(pnlUsdc.toFixed(4)),
    reason,
    openedAt: pos.openedAt,
    closedAt: new Date().toISOString(),
    won: rawPnlPct > 0,
    isSimulated: pos.isSimulated,
  };
}

/**
 * DELETE open row + INSERT trade in one transaction.
 * @returns {'ok' | 'no_open_row'}
 */
async function persistCloseTradeTx(trade, symbol) {
  let client;
  try {
    client = await getPool().connect();
    await client.query('BEGIN');
    const del = await client.query(
      'DELETE FROM open_positions WHERE symbol = $1 AND is_simulated = $2',
      [symbol, trade.isSimulated]
    );
    if (del.rowCount === 0) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {
        /* ignore rollback errors — still return no_open_row for caller recovery */
      }
      return 'no_open_row';
    }
    await client.query(
      `INSERT INTO trades (
        symbol, entry_price, exit_price, size_usdc, pnl_pct, pnl_usdc, reason, opened_at, closed_at, won, is_simulated
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        trade.symbol,
        trade.entryPrice,
        trade.exitPrice,
        trade.sizeUsdc,
        trade.pnlPct,
        trade.pnlUsdc,
        trade.reason,
        trade.openedAt,
        trade.closedAt,
        trade.won,
        trade.isSimulated,
      ]
    );
    await client.query('COMMIT');
    return 'ok';
  } catch (e) {
    try {
      await client?.query('ROLLBACK');
    } catch (_) {
      /* ignore rollback errors */
    }
    throw e;
  } finally {
    client?.release();
  }
}

async function persistTradeOnly(trade) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO trades (
      symbol, entry_price, exit_price, size_usdc, pnl_pct, pnl_usdc, reason, opened_at, closed_at, won, is_simulated
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      trade.symbol,
      trade.entryPrice,
      trade.exitPrice,
      trade.sizeUsdc,
      trade.pnlPct,
      trade.pnlUsdc,
      trade.reason,
      trade.openedAt,
      trade.closedAt,
      trade.won,
      trade.isSimulated,
    ]
  );
}

function applyCloseToMemory(trade) {
  delete _positions[positionKey(trade.symbol, trade.isSimulated)];
  _trades.push(trade);
}

const BUY_OPEN_ATTEMPTS = 5;
const BUY_OPEN_BASE_MS = 200;

/**
 * Upsert open_positions after a successful on-chain buy when plain INSERT retries failed.
 * @param {{ symbol: string, mint: string, entryPrice: number, sizeUsdc: number, tokenAmount: number, isSimulated?: boolean }} payload
 */
export async function reconcileOpenAfterOnChainBuy(payload) {
  const openedAtNew = new Date().toISOString();
  const isSimulated = payload.isSimulated === true;
  const pool = getPool();
  const res = await pool.query(
    `INSERT INTO open_positions AS op (symbol, mint, entry_price, size_usdc, token_amount, opened_at, is_simulated)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (symbol, is_simulated) DO UPDATE SET
       mint = EXCLUDED.mint,
       entry_price = EXCLUDED.entry_price,
       size_usdc = EXCLUDED.size_usdc,
       token_amount = EXCLUDED.token_amount,
       opened_at = op.opened_at,
       is_simulated = EXCLUDED.is_simulated
     RETURNING symbol, mint, entry_price, size_usdc, token_amount, opened_at, is_simulated`,
    [
      payload.symbol,
      payload.mint,
      payload.entryPrice,
      payload.sizeUsdc,
      payload.tokenAmount,
      openedAtNew,
      isSimulated,
    ]
  );
  const row = res.rows[0];
  const pos = rowToPosition(row);
  _positions[positionKey(pos.symbol, pos.isSimulated)] = pos;
}

/**
 * After a successful buy, persist the open row with retries.
 * @param {{ symbol: string, mint: string, entryPrice: number, sizeUsdc: number, tokenAmount: number, isSimulated: boolean }} payload
 * @returns {Promise<{ ok: true } | { ok: false, error: Error, memoryRecovered: boolean }>}
 */
export async function persistBuyOpenWithRetries(payload) {
  if (hasPosition(payload.symbol, payload.isSimulated)) {
    return { ok: true };
  }

  let lastErr;
  for (let attempt = 0; attempt < BUY_OPEN_ATTEMPTS; attempt++) {
    try {
      await openPosition(payload);
      return { ok: true };
    } catch (e) {
      lastErr = e;
      const alreadyOpen = e.message && e.message.includes('Position already open');
      if (alreadyOpen) {
        return { ok: true };
      }
      if (e.code === '23505') {
        try {
          await reconcileOpenAfterOnChainBuy(payload);
          return { ok: true };
        } catch (reconcileDupErr) {
          lastErr = reconcileDupErr;
        }
      }
    }
    await new Promise((res) => setTimeout(res, BUY_OPEN_BASE_MS * (attempt + 1)));
  }

  console.error(
    `[positions] openPosition failed after ${BUY_OPEN_ATTEMPTS} attempts (${lastErr?.message}); reconciling after buy`
  );

  try {
    await reconcileOpenAfterOnChainBuy(payload);
    return { ok: true };
  } catch (reconcileErr) {
    const openedAt = new Date().toISOString();
    _positions[positionKey(payload.symbol, payload.isSimulated)] = {
      symbol: payload.symbol,
      mint: payload.mint,
      entryPrice: payload.entryPrice,
      sizeUsdc: payload.sizeUsdc,
      tokenAmount: payload.tokenAmount,
      openedAt,
      isSimulated: payload.isSimulated,
    };
    console.error(
      `[positions] CRITICAL: buy recorded in memory only (${reconcileErr.message}). ` +
        'Repair open_positions in the database before restart or the bot may not see this position.'
    );
    return { ok: false, error: reconcileErr, memoryRecovered: true };
  }
}

/**
 * @param {object} position — must include isSimulated
 */
export async function openPosition(position) {
  const isSimulated = position.isSimulated === true;
  const key = positionKey(position.symbol, isSimulated);
  if (_positions[key]) {
    throw new Error(`Position already open for ${position.symbol} (isSimulated=${isSimulated})`);
  }
  const openedAt = new Date().toISOString();
  const pool = getPool();
  await pool.query(
    `INSERT INTO open_positions (symbol, mint, entry_price, size_usdc, token_amount, opened_at, is_simulated)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      position.symbol,
      position.mint,
      position.entryPrice,
      position.sizeUsdc,
      position.tokenAmount,
      openedAt,
      isSimulated,
    ]
  );
  _positions[key] = {
    symbol: position.symbol,
    mint: position.mint,
    entryPrice: position.entryPrice,
    sizeUsdc: position.sizeUsdc,
    tokenAmount: position.tokenAmount,
    openedAt,
    isSimulated,
  };
}

/**
 * @param {boolean} dryRun — lane for the position being closed
 */
export async function closePosition(symbol, exitPrice, reason = 'unknown', dryRun) {
  const pos = getPosition(symbol, dryRun);
  if (!pos) {
    return null;
  }

  const trade = buildTradeRecord(pos, exitPrice, reason);
  const status = await persistCloseTradeTx(trade, symbol);
  if (status === 'no_open_row') {
    await persistTradeOnly(trade);
    applyCloseToMemory(trade);
    return trade;
  }

  applyCloseToMemory(trade);
  return trade;
}

export async function reconcilePositionClosedAfterSell(positionSnapshot, exitPrice, reason = 'unknown') {
  const trade = buildTradeRecord(positionSnapshot, exitPrice, reason);
  const status = await persistCloseTradeTx(trade, positionSnapshot.symbol);
  if (status === 'no_open_row') {
    await persistTradeOnly(trade);
    applyCloseToMemory(trade);
    return trade;
  }

  applyCloseToMemory(trade);
  return trade;
}

const SELL_CLOSE_ATTEMPTS = 5;
const SELL_CLOSE_BASE_MS = 200;

/**
 * @param {boolean} dryRun — current scan mode (must match position lane)
 */
export async function persistSellCloseWithRetries(symbol, exitPrice, reason, positionSnapshot, dryRun) {
  let lastErr;
  for (let attempt = 0; attempt < SELL_CLOSE_ATTEMPTS; attempt++) {
    if (!hasPosition(symbol, dryRun)) {
      return null;
    }
    try {
      return await closePosition(symbol, exitPrice, reason, dryRun);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((res) => setTimeout(res, SELL_CLOSE_BASE_MS * (attempt + 1)));
  }

  console.error(
    `[positions] closePosition failed after ${SELL_CLOSE_ATTEMPTS} attempts (${lastErr?.message}); reconciling after sell`
  );
  try {
    return await reconcilePositionClosedAfterSell(positionSnapshot, exitPrice, reason);
  } catch (reconcileErr) {
    delete _positions[positionKey(symbol, dryRun)];
    try {
      const trade = buildTradeRecord(positionSnapshot, exitPrice, reason);
      applyCloseToMemory(trade);
    } catch (_) {
      /* ignore memory fallback errors */
    }
    console.error(
      `[positions] Reconcile failed (${reconcileErr.message}); evicted ${symbol} from memory so the bot will not retry sells this run. ` +
        'If open_positions still has a row for this symbol, delete it or fix the DB before restart.'
    );
    throw reconcileErr;
  }
}

export function getTrades() {
  return [..._trades];
}

/**
 * Stats for the given mode (paper vs live).
 * @param {boolean} dryRun
 */
export function getStats(dryRun) {
  const trades = _trades.filter((t) => t.isSimulated === dryRun);
  if (trades.length === 0) {
    return {
      total: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalPnlUsdc: 0,
      avgPnlPct: 0,
      avgWinPct: 0,
      avgLossPct: 0,
    };
  }

  const wins = trades.filter((t) => t.won);
  const losses = trades.filter((t) => !t.won);

  const totalPnlUsdc = trades.reduce((sum, t) => sum + t.pnlUsdc, 0);
  const avgPnlPct = trades.reduce((sum, t) => sum + t.pnlPct, 0) / trades.length;
  const avgWinPct = wins.length ? wins.reduce((sum, t) => sum + t.pnlPct, 0) / wins.length : 0;
  const avgLossPct = losses.length
    ? losses.reduce((sum, t) => sum + t.pnlPct, 0) / losses.length
    : 0;

  return {
    total: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: parseFloat(((wins.length / trades.length) * 100).toFixed(1)),
    totalPnlUsdc: parseFloat(totalPnlUsdc.toFixed(4)),
    avgPnlPct: parseFloat(avgPnlPct.toFixed(4)),
    avgWinPct: parseFloat(avgWinPct.toFixed(4)),
    avgLossPct: parseFloat(avgLossPct.toFixed(4)),
  };
}
