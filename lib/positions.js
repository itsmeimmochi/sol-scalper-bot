/**
 * positions.js — In-memory position tracking backed by PostgreSQL.
 *
 * Position shape:
 * {
 *   symbol: string,
 *   mint: string,
 *   entryPrice: number,
 *   sizeUsdc: number,
 *   tokenAmount: number,
 *   openedAt: ISO string,
 * }
 *
 * Trade record shape:
 * {
 *   symbol: string,
 *   entryPrice: number,
 *   exitPrice: number,
 *   sizeUsdc: number,
 *   pnlPct: number,
 *   pnlUsdc: number,
 *   reason: string,
 *   openedAt: ISO string,
 *   closedAt: ISO string,
 *   won: boolean,
 * }
 */

import { getPool } from './db.js';

// In-memory store: symbol → position
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
  };
}

/**
 * Load positions and trade history from the database. Call once at startup.
 */
export async function loadPositions() {
  const pool = getPool();
  const posRes = await pool.query(
    'SELECT symbol, mint, entry_price, size_usdc, token_amount, opened_at FROM open_positions'
  );
  _positions = {};
  for (const row of posRes.rows) {
    _positions[row.symbol] = rowToPosition(row);
  }
  console.log(`[positions] Loaded ${Object.keys(_positions).length} open positions from database.`);

  const tradesRes = await pool.query(
    `SELECT symbol, entry_price, exit_price, size_usdc, pnl_pct, pnl_usdc, reason, opened_at, closed_at, won
     FROM trades ORDER BY id ASC`
  );
  _trades = tradesRes.rows.map(rowToTrade);
  console.log(`[positions] Loaded ${_trades.length} historical trades from database.`);
}

/** @returns {boolean} */
export function hasPosition(symbol) {
  return !!_positions[symbol];
}

/** @returns {object | null} */
export function getPosition(symbol) {
  return _positions[symbol] || null;
}

/** @returns {object[]} */
export function getAllPositions() {
  return Object.values(_positions);
}

/** @returns {number} */
export function openPositionCount() {
  return Object.keys(_positions).length;
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
    const del = await client.query('DELETE FROM open_positions WHERE symbol = $1', [symbol]);
    if (del.rowCount === 0) {
      await client.query('ROLLBACK');
      return 'no_open_row';
    }
    await client.query(
      `INSERT INTO trades (
        symbol, entry_price, exit_price, size_usdc, pnl_pct, pnl_usdc, reason, opened_at, closed_at, won
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
      symbol, entry_price, exit_price, size_usdc, pnl_pct, pnl_usdc, reason, opened_at, closed_at, won
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
    ]
  );
}

function applyCloseToMemory(trade) {
  delete _positions[trade.symbol];
  _trades.push(trade);
}

const BUY_OPEN_ATTEMPTS = 5;
const BUY_OPEN_BASE_MS = 200;

/**
 * Upsert open_positions after a successful on-chain buy when plain INSERT retries failed.
 * @param {{ symbol: string, mint: string, entryPrice: number, sizeUsdc: number, tokenAmount: number }} payload
 */
export async function reconcileOpenAfterOnChainBuy(payload) {
  const openedAtNew = new Date().toISOString();
  const pool = getPool();
  const res = await pool.query(
    `INSERT INTO open_positions AS op (symbol, mint, entry_price, size_usdc, token_amount, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (symbol) DO UPDATE SET
       mint = EXCLUDED.mint,
       entry_price = EXCLUDED.entry_price,
       size_usdc = EXCLUDED.size_usdc,
       token_amount = EXCLUDED.token_amount,
       opened_at = op.opened_at
     RETURNING symbol, mint, entry_price, size_usdc, token_amount, opened_at`,
    [
      payload.symbol,
      payload.mint,
      payload.entryPrice,
      payload.sizeUsdc,
      payload.tokenAmount,
      openedAtNew,
    ]
  );
  const row = res.rows[0];
  _positions[payload.symbol] = rowToPosition(row);
}

/**
 * After a successful on-chain buy, persist the open row with retries, then upsert reconcile.
 * @returns {Promise<{ ok: true } | { ok: false, error: Error, memoryRecovered: boolean }>}
 */
export async function persistBuyOpenWithRetries(payload) {
  if (hasPosition(payload.symbol)) {
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
      // Row may already exist in DB (e.g. insert committed before client saw response) while memory is empty.
      if (e.code === '23505') {
        try {
          await reconcileOpenAfterOnChainBuy(payload);
          return { ok: true };
        } catch (reconcileDupErr) {
          lastErr = reconcileDupErr;
        }
      }
    }
    await new Promise(res => setTimeout(res, BUY_OPEN_BASE_MS * (attempt + 1)));
  }

  console.error(
    `[positions] openPosition failed after ${BUY_OPEN_ATTEMPTS} attempts (${lastErr?.message}); reconciling after on-chain buy`
  );

  try {
    await reconcileOpenAfterOnChainBuy(payload);
    return { ok: true };
  } catch (reconcileErr) {
    const openedAt = new Date().toISOString();
    _positions[payload.symbol] = { ...payload, openedAt };
    console.error(
      `[positions] CRITICAL: on-chain buy recorded in memory only (${reconcileErr.message}). ` +
        'Repair open_positions in the database before restart or the bot may not see this position.'
    );
    return { ok: false, error: reconcileErr, memoryRecovered: true };
  }
}

/**
 * Open a new position.
 * @param {object} position
 */
export async function openPosition(position) {
  if (_positions[position.symbol]) {
    throw new Error(`Position already open for ${position.symbol}`);
  }
  const openedAt = new Date().toISOString();
  const pool = getPool();
  await pool.query(
    `INSERT INTO open_positions (symbol, mint, entry_price, size_usdc, token_amount, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      position.symbol,
      position.mint,
      position.entryPrice,
      position.sizeUsdc,
      position.tokenAmount,
      openedAt,
    ]
  );
  _positions[position.symbol] = { ...position, openedAt };
}

/**
 * Close a position and record it in trade history.
 * @param {string} symbol
 * @param {number} exitPrice
 * @param {string} reason
 * @returns {Promise<object | null>} the trade record, or null if no position found
 */
export async function closePosition(symbol, exitPrice, reason = 'unknown') {
  const pos = _positions[symbol];
  if (!pos) {
    return null;
  }

  const trade = buildTradeRecord(pos, exitPrice, reason);
  const status = await persistCloseTradeTx(trade, symbol);
  if (status === 'no_open_row') {
    // DB row missing: still record the trade outcome instead of silently dropping it.
    await persistTradeOnly(trade);
    applyCloseToMemory(trade);
    return trade;
  }

  applyCloseToMemory(trade);
  return trade;
}

/**
 * Persist close using a position snapshot (same row as before on-chain sell).
 * Use when `closePosition` cannot be retried but tokens were already sold.
 * @param {object} positionSnapshot
 */
export async function reconcilePositionClosedAfterSell(positionSnapshot, exitPrice, reason = 'unknown') {
  const trade = buildTradeRecord(positionSnapshot, exitPrice, reason);
  const status = await persistCloseTradeTx(trade, positionSnapshot.symbol);
  if (status === 'no_open_row') {
    // Position row is already gone; still persist the trade record.
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
 * After a successful on-chain sell, persist the close with retries, then reconcile if needed.
 * Avoids a loop where the DB still shows an open position but tokens are already gone.
 */
export async function persistSellCloseWithRetries(symbol, exitPrice, reason, positionSnapshot) {
  let lastErr;
  for (let attempt = 0; attempt < SELL_CLOSE_ATTEMPTS; attempt++) {
    if (!hasPosition(symbol)) {
      return null;
    }
    try {
      return await closePosition(symbol, exitPrice, reason);
    } catch (e) {
      lastErr = e;
    }
    await new Promise(res => setTimeout(res, SELL_CLOSE_BASE_MS * (attempt + 1)));
  }

  console.error(
    `[positions] closePosition failed after ${SELL_CLOSE_ATTEMPTS} attempts (${lastErr?.message}); reconciling after on-chain sell`
  );
  try {
    return await reconcilePositionClosedAfterSell(positionSnapshot, exitPrice, reason);
  } catch (reconcileErr) {
    delete _positions[symbol];
    // DB is still failing; keep an in-memory trade record so the outcome isn't lost
    // for the duration of this process. The caller will still be notified of the
    // persistence failure so it can be fixed before restart.
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

/**
 * Return all closed trades.
 * @returns {object[]}
 */
export function getTrades() {
  return [..._trades];
}

/**
 * Compute win rate stats from closed trades.
 * @returns {{
 *   total: number,
 *   wins: number,
 *   losses: number,
 *   winRate: number,
 *   totalPnlUsdc: number,
 *   avgPnlPct: number,
 *   avgWinPct: number,
 *   avgLossPct: number,
 * }}
 */
export function getStats() {
  if (_trades.length === 0) {
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

  const wins = _trades.filter(t => t.won);
  const losses = _trades.filter(t => !t.won);

  const totalPnlUsdc = _trades.reduce((sum, t) => sum + t.pnlUsdc, 0);
  const avgPnlPct = _trades.reduce((sum, t) => sum + t.pnlPct, 0) / _trades.length;
  const avgWinPct = wins.length ? wins.reduce((sum, t) => sum + t.pnlPct, 0) / wins.length : 0;
  const avgLossPct = losses.length
    ? losses.reduce((sum, t) => sum + t.pnlPct, 0) / losses.length
    : 0;

  return {
    total: _trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: parseFloat(((wins.length / _trades.length) * 100).toFixed(1)),
    totalPnlUsdc: parseFloat(totalPnlUsdc.toFixed(4)),
    avgPnlPct: parseFloat(avgPnlPct.toFixed(4)),
    avgWinPct: parseFloat(avgWinPct.toFixed(4)),
    avgLossPct: parseFloat(avgLossPct.toFixed(4)),
  };
}
