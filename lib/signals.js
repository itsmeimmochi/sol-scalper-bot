/**
 * signals.js — Pure buy/sell signal logic.
 * All functions take plain data, return booleans. No I/O.
 */

/**
 * Determine if a buy signal is present.
 * Conditions: close ≤ lower BB AND RSI < rsiBuyThreshold AND no open position.
 *
 * @param {object} params
 * @param {number} params.close
 * @param {{ upper: number, middle: number, lower: number }} params.bb
 * @param {number} params.rsiValue
 * @param {boolean} params.hasOpenPosition
 * @param {number} params.rsiBuyThreshold
 * @returns {boolean}
 */
export function shouldBuy({ close, bb, rsiValue, hasOpenPosition, rsiBuyThreshold }) {
  if (hasOpenPosition) return false;
  return close <= bb.lower && rsiValue < rsiBuyThreshold;
}

/**
 * @param {{ upper: number, middle: number, lower: number }} bb
 * @param {number} bbMiddleSellPosition 0 = middle, 1 = upper (clamped to [0,1])
 * @returns {number}
 */
function bandExitLevel(bb, bbMiddleSellPosition) {
  const t = Math.min(1, Math.max(0, bbMiddleSellPosition));
  const span = bb.upper - bb.middle;
  if (span > 0) {
    return bb.middle + t * span;
  }
  return bb.middle;
}

/**
 * Determine if a sell signal is present.
 * Conditions: close ≥ band exit level (see bbMiddleSellPosition) OR RSI > rsiSellThreshold
 * OR stop-loss OR take-profit. Optional: bbMiddleMinPnlPct only applies to the band exit.
 *
 * @param {object} params
 * @param {number} params.close
 * @param {{ upper: number, middle: number, lower: number }} params.bb
 * @param {number} params.rsiValue
 * @param {number} params.entryPrice
 * @param {number} params.takeProfitPct   — e.g. 1.0 means +1%
 * @param {number} params.stopLossPct     — e.g. 0.8 means -0.8%
 * @param {number} params.rsiSellThreshold
 * @param {number} [params.bbMiddleSellPosition=0] 0 = middle band, 1 = upper band
 * @param {number} [params.bbMiddleMinPnlPct=0] min unrealized PnL % (vs entry) to allow BB_MIDDLE; 0 = off
 * @returns {{ sell: boolean, reason: string | null }}
 */
export function shouldSell({
  close,
  bb,
  rsiValue,
  entryPrice,
  takeProfitPct,
  stopLossPct,
  rsiSellThreshold,
  bbMiddleSellPosition = 0,
  bbMiddleMinPnlPct = 0,
}) {
  const takeProfitPrice = entryPrice * (1 + takeProfitPct / 100);
  const stopLossPrice = entryPrice * (1 - stopLossPct / 100);
  const exitLevel = bandExitLevel(bb, bbMiddleSellPosition);

  if (close >= takeProfitPrice) return { sell: true, reason: 'TAKE_PROFIT' };
  if (close <= stopLossPrice) return { sell: true, reason: 'STOP_LOSS' };
  if (rsiValue > rsiSellThreshold) return { sell: true, reason: 'RSI_HIGH' };
  if (close < exitLevel) return { sell: false, reason: null };
  if (bbMiddleMinPnlPct > 0 && pnlPct(entryPrice, close) < bbMiddleMinPnlPct) {
    return { sell: false, reason: null };
  }
  return { sell: true, reason: 'BB_MIDDLE' };
}

/**
 * Calculate PnL percentage from entry to current price.
 * @param {number} entryPrice
 * @param {number} currentPrice
 * @returns {number}  e.g. 1.5 means +1.5%
 */
export function pnlPct(entryPrice, currentPrice) {
  return ((currentPrice - entryPrice) / entryPrice) * 100;
}
