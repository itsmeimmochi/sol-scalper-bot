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
 * Determine if a sell signal is present.
 * Conditions: close ≥ middle BB (SMA) OR RSI > rsiSellThreshold OR stop-loss hit OR take-profit hit.
 *
 * @param {object} params
 * @param {number} params.close
 * @param {{ upper: number, middle: number, lower: number }} params.bb
 * @param {number} params.rsiValue
 * @param {number} params.entryPrice
 * @param {number} params.takeProfitPct   — e.g. 1.0 means +1%
 * @param {number} params.stopLossPct     — e.g. 0.8 means -0.8%
 * @param {number} params.rsiSellThreshold
 * @returns {{ sell: boolean, reason: string | null }}
 */
export function shouldSell({ close, bb, rsiValue, entryPrice, takeProfitPct, stopLossPct, rsiSellThreshold }) {
  const takeProfitPrice = entryPrice * (1 + takeProfitPct / 100);
  const stopLossPrice = entryPrice * (1 - stopLossPct / 100);

  if (close >= takeProfitPrice) return { sell: true, reason: 'TAKE_PROFIT' };
  if (close <= stopLossPrice)   return { sell: true, reason: 'STOP_LOSS' };
  if (rsiValue > rsiSellThreshold) return { sell: true, reason: 'RSI_HIGH' };
  if (close >= bb.middle)       return { sell: true, reason: 'BB_MIDDLE' };

  return { sell: false, reason: null };
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
