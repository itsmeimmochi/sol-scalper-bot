/**
 * indicators.js — Pure functions for Bollinger Bands and RSI.
 * No side effects, no I/O. Safe to unit test in isolation.
 */

/**
 * Calculate Simple Moving Average over the last `period` values of `closes`.
 * @param {number[]} closes
 * @param {number} period
 * @returns {number}
 */
export function sma(closes, period) {
  if (closes.length < period) throw new Error(`Not enough data: need ${period}, got ${closes.length}`);
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * Calculate standard deviation of the last `period` values.
 * @param {number[]} closes
 * @param {number} period
 * @param {number} mean  pre-computed mean (avoids double pass)
 * @returns {number}
 */
export function stdDev(closes, period, mean) {
  const slice = closes.slice(-period);
  const variance = slice.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / period;
  return Math.sqrt(variance);
}

/**
 * Compute Bollinger Bands for the latest candle.
 * @param {number[]} closes   — full price history (need >= period)
 * @param {number} period     — lookback window (default 20)
 * @param {number} multiplier — std-dev multiplier (default 2)
 * @returns {{ upper: number, middle: number, lower: number }}
 */
export function bollingerBands(closes, period = 20, multiplier = 2) {
  const middle = sma(closes, period);
  const sd = stdDev(closes, period, middle);
  return {
    upper: middle + multiplier * sd,
    middle,
    lower: middle - multiplier * sd,
  };
}

/**
 * Compute RSI (Wilder's smoothing) for the latest candle.
 * @param {number[]} closes   — full price history (need >= period + 1)
 * @param {number} period     — default 14
 * @returns {number}  0–100
 */
export function rsi(closes, period = 14) {
  if (closes.length < period + 1) {
    throw new Error(`Not enough data for RSI: need ${period + 1}, got ${closes.length}`);
  }

  // Initial averages over first `period` changes
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Wilder smoothing for the rest
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change >= 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
