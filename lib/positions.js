/**
 * positions.js — In-memory position tracking with JSON persistence.
 * Also maintains a closed-trade history in trades.json for win rate tracking.
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
 *   pnlPct: number,      // e.g. 1.05 = +1.05%
 *   pnlUsdc: number,     // e.g. 0.26
 *   reason: string,      // 'take_profit' | 'stop_loss' | 'bb_middle' | 'rsi_high'
 *   openedAt: ISO string,
 *   closedAt: ISO string,
 *   won: boolean,        // pnlPct > 0
 * }
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const POSITIONS_FILE = resolve(process.cwd(), 'positions.json');
const TRADES_FILE    = resolve(process.cwd(), 'trades.json');

// In-memory store: symbol → position
let _positions = {};
// All closed trades
let _trades = [];

/**
 * Load positions and trade history from disk. Call once at startup.
 */
export function loadPositions() {
  if (existsSync(POSITIONS_FILE)) {
    try {
      _positions = JSON.parse(readFileSync(POSITIONS_FILE, 'utf8'));
      console.log(`[positions] Loaded ${Object.keys(_positions).length} open positions from disk.`);
    } catch (e) {
      console.error('[positions] Failed to parse positions.json, starting fresh.', e.message);
      _positions = {};
    }
  } else {
    _positions = {};
  }

  if (existsSync(TRADES_FILE)) {
    try {
      _trades = JSON.parse(readFileSync(TRADES_FILE, 'utf8'));
      console.log(`[positions] Loaded ${_trades.length} historical trades from disk.`);
    } catch (e) {
      console.error('[positions] Failed to parse trades.json, starting fresh.', e.message);
      _trades = [];
    }
  } else {
    _trades = [];
  }
}

/** Persist positions to disk. */
function savePositions() {
  writeFileSync(POSITIONS_FILE, JSON.stringify(_positions, null, 2));
}

/** Persist trades to disk. */
function saveTrades() {
  writeFileSync(TRADES_FILE, JSON.stringify(_trades, null, 2));
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

/**
 * Open a new position.
 * @param {object} position
 */
export function openPosition(position) {
  if (_positions[position.symbol]) {
    throw new Error(`Position already open for ${position.symbol}`);
  }
  _positions[position.symbol] = { ...position, openedAt: new Date().toISOString() };
  savePositions();
}

/**
 * Close a position and record it in trade history.
 * @param {string} symbol
 * @param {number} exitPrice
 * @param {string} reason
 * @returns {object | null} the trade record, or null if no position found
 */
export function closePosition(symbol, exitPrice, reason = 'unknown') {
  const pos = _positions[symbol];
  if (!pos) return null;

  const rawPnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
  const pnlUsdc   = pos.sizeUsdc * (rawPnlPct / 100);

  const trade = {
    symbol,
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

  _trades.push(trade);
  delete _positions[symbol];

  savePositions();
  saveTrades();

  return trade;
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
 *   winRate: number,       // 0–100
 *   totalPnlUsdc: number,
 *   avgPnlPct: number,
 *   avgWinPct: number,
 *   avgLossPct: number,
 * }}
 */
export function getStats() {
  if (_trades.length === 0) {
    return { total: 0, wins: 0, losses: 0, winRate: 0, totalPnlUsdc: 0, avgPnlPct: 0, avgWinPct: 0, avgLossPct: 0 };
  }

  const wins   = _trades.filter(t => t.won);
  const losses = _trades.filter(t => !t.won);

  const totalPnlUsdc = _trades.reduce((sum, t) => sum + t.pnlUsdc, 0);
  const avgPnlPct    = _trades.reduce((sum, t) => sum + t.pnlPct, 0) / _trades.length;
  const avgWinPct    = wins.length   ? wins.reduce((sum, t)   => sum + t.pnlPct, 0) / wins.length   : 0;
  const avgLossPct   = losses.length ? losses.reduce((sum, t) => sum + t.pnlPct, 0) / losses.length : 0;

  return {
    total:        _trades.length,
    wins:         wins.length,
    losses:       losses.length,
    winRate:      parseFloat(((wins.length / _trades.length) * 100).toFixed(1)),
    totalPnlUsdc: parseFloat(totalPnlUsdc.toFixed(4)),
    avgPnlPct:    parseFloat(avgPnlPct.toFixed(4)),
    avgWinPct:    parseFloat(avgWinPct.toFixed(4)),
    avgLossPct:   parseFloat(avgLossPct.toFixed(4)),
  };
}
