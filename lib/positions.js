/**
 * positions.js — In-memory position tracking with JSON persistence.
 *
 * Position shape:
 * {
 *   symbol: string,
 *   mint: string,
 *   entryPrice: number,
 *   sizeUsdc: number,
 *   tokenAmount: number,   // tokens received
 *   openedAt: ISO string,
 * }
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const POSITIONS_FILE = resolve(process.cwd(), 'positions.json');

// In-memory store: symbol → position
let _positions = {};

/**
 * Load positions from disk. Call once at startup.
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
}

/** Persist current state to disk. */
function save() {
  writeFileSync(POSITIONS_FILE, JSON.stringify(_positions, null, 2));
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
  save();
}

/**
 * Close a position by symbol.
 * @param {string} symbol
 * @returns {object | null} the closed position, or null if not found
 */
export function closePosition(symbol) {
  const pos = _positions[symbol];
  if (!pos) return null;
  delete _positions[symbol];
  save();
  return pos;
}
