/**
 * signals.test.js — Unit tests for buy/sell signal logic.
 */

import { shouldBuy, shouldSell, pnlPct } from '../lib/signals.js';

const DEFAULT_BB = { upper: 110, middle: 100, lower: 90 };

// ── shouldBuy ──────────────────────────────────────────────────────────────────
describe('shouldBuy', () => {
  const base = {
    close: 89,           // below lower BB (90)
    bb: DEFAULT_BB,
    rsiValue: 35,        // below rsiBuyThreshold
    hasOpenPosition: false,
    rsiBuyThreshold: 38,
  };

  test('returns true when all conditions met', () => {
    expect(shouldBuy(base)).toBe(true);
  });

  test('returns false when already have position', () => {
    expect(shouldBuy({ ...base, hasOpenPosition: true })).toBe(false);
  });

  test('returns false when price above lower BB', () => {
    expect(shouldBuy({ ...base, close: 91 })).toBe(false);
  });

  test('returns false when RSI equals threshold (not strictly less)', () => {
    expect(shouldBuy({ ...base, rsiValue: 38 })).toBe(false);
  });

  test('returns false when RSI above threshold', () => {
    expect(shouldBuy({ ...base, rsiValue: 45 })).toBe(false);
  });

  test('returns true when price exactly at lower BB', () => {
    // close <= lower: 90 <= 90 is true
    expect(shouldBuy({ ...base, close: 90 })).toBe(true);
  });
});

// ── shouldSell ─────────────────────────────────────────────────────────────────
describe('shouldSell', () => {
  // entryPrice=95: TP @ 95.95, SL @ 94.24
  // close=95: below TP, above SL, RSI=50 < 65, close < middle(100) → no sell
  const base = {
    close: 95,
    bb: DEFAULT_BB,
    rsiValue: 50,
    entryPrice: 95,
    takeProfitPct: 1.0,   // TP at 95 * 1.01 = 95.95
    stopLossPct: 0.8,     // SL at 95 * 0.992 = 94.24
    rsiSellThreshold: 65,
  };

  test('no sell when conditions not met', () => {
    const { sell } = shouldSell(base);
    expect(sell).toBe(false);
  });

  test('TAKE_PROFIT when price hits TP level', () => {
    // 95.96 >= 95.95 (TP)
    const { sell, reason } = shouldSell({ ...base, close: 95.96 });
    expect(sell).toBe(true);
    expect(reason).toBe('TAKE_PROFIT');
  });

  test('STOP_LOSS when price hits SL level', () => {
    // 94.20 <= 94.24 (SL)
    const { sell, reason } = shouldSell({ ...base, close: 94.20 });
    expect(sell).toBe(true);
    expect(reason).toBe('STOP_LOSS');
  });

  test('RSI_HIGH when RSI exceeds threshold', () => {
    // close=95 doesn't trigger TP (95 < 95.95) or SL (95 > 94.24); RSI=70 > 65
    const { sell, reason } = shouldSell({ ...base, rsiValue: 70 });
    expect(sell).toBe(true);
    expect(reason).toBe('RSI_HIGH');
  });

  test('BB_MIDDLE when price reaches middle band', () => {
    // entryPrice=100: TP@101, SL@99.2; close=100: not TP, not SL, RSI=50 < 65, close >= middle(100)
    const { sell, reason } = shouldSell({ ...base, close: 100, entryPrice: 100 });
    expect(sell).toBe(true);
    expect(reason).toBe('BB_MIDDLE');
  });

  test('TAKE_PROFIT takes priority over BB_MIDDLE', () => {
    // close=105 > TP and > middle; TP should fire first
    const { sell, reason } = shouldSell({ ...base, close: 105 });
    expect(sell).toBe(true);
    expect(reason).toBe('TAKE_PROFIT');
  });
});

// ── pnlPct ─────────────────────────────────────────────────────────────────────
describe('pnlPct', () => {
  test('positive PnL on gain', () => {
    expect(pnlPct(100, 101)).toBeCloseTo(1.0);
  });

  test('negative PnL on loss', () => {
    expect(pnlPct(100, 99.2)).toBeCloseTo(-0.8);
  });

  test('zero PnL on no change', () => {
    expect(pnlPct(100, 100)).toBeCloseTo(0);
  });
});
