/**
 * indicators.test.js — Unit tests for BB and RSI calculations.
 */

import { sma, stdDev, bollingerBands, rsi } from '../lib/indicators.js';

// ── SMA ────────────────────────────────────────────────────────────────────────
describe('sma', () => {
  test('calculates simple moving average correctly', () => {
    const prices = [1, 2, 3, 4, 5];
    expect(sma(prices, 5)).toBeCloseTo(3.0);
  });

  test('uses only the last `period` values', () => {
    const prices = [100, 1, 2, 3, 4, 5];
    expect(sma(prices, 5)).toBeCloseTo(3.0); // ignores 100
  });

  test('throws when not enough data', () => {
    expect(() => sma([1, 2], 5)).toThrow();
  });
});

// ── stdDev ─────────────────────────────────────────────────────────────────────
describe('stdDev', () => {
  test('returns 0 for constant prices', () => {
    const prices = [5, 5, 5, 5, 5];
    const mean = sma(prices, 5);
    expect(stdDev(prices, 5, mean)).toBeCloseTo(0);
  });

  test('calculates correct std dev for simple data', () => {
    const prices = [2, 4, 4, 4, 5, 5, 7, 9];
    const period = 8;
    const mean = sma(prices, period);
    expect(mean).toBeCloseTo(5.0);
    expect(stdDev(prices, period, mean)).toBeCloseTo(2.0);
  });
});

// ── Bollinger Bands ────────────────────────────────────────────────────────────
describe('bollingerBands', () => {
  const PERIOD = 20;
  // Generate 30 prices around 100 with slight variation
  const prices = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 2);

  test('returns upper, middle, lower', () => {
    const bb = bollingerBands(prices, PERIOD, 2);
    expect(bb).toHaveProperty('upper');
    expect(bb).toHaveProperty('middle');
    expect(bb).toHaveProperty('lower');
  });

  test('upper > middle > lower', () => {
    const bb = bollingerBands(prices, PERIOD, 2);
    expect(bb.upper).toBeGreaterThan(bb.middle);
    expect(bb.middle).toBeGreaterThan(bb.lower);
  });

  test('middle equals SMA', () => {
    const bb = bollingerBands(prices, PERIOD, 2);
    expect(bb.middle).toBeCloseTo(sma(prices, PERIOD));
  });

  test('band width scales with multiplier', () => {
    const bb1 = bollingerBands(prices, PERIOD, 1);
    const bb2 = bollingerBands(prices, PERIOD, 2);
    const width1 = bb1.upper - bb1.lower;
    const width2 = bb2.upper - bb2.lower;
    expect(width2).toBeCloseTo(width1 * 2, 5);
  });

  test('throws with insufficient data', () => {
    expect(() => bollingerBands([1, 2, 3], 20)).toThrow();
  });
});

// ── RSI ────────────────────────────────────────────────────────────────────────
describe('rsi', () => {
  test('returns 100 for strictly increasing prices', () => {
    const prices = Array.from({ length: 20 }, (_, i) => i + 1); // 1,2,...,20
    expect(rsi(prices, 14)).toBeCloseTo(100);
  });

  test('returns 0 for strictly decreasing prices', () => {
    const prices = Array.from({ length: 20 }, (_, i) => 20 - i); // 20,19,...,1
    expect(rsi(prices, 14)).toBeCloseTo(0);
  });

  test('returns ~50 for alternating equal up/down moves', () => {
    // Alternating +1, -1 creates equal avg gain and loss
    const prices = [100];
    for (let i = 0; i < 30; i++) {
      prices.push(prices[prices.length - 1] + (i % 2 === 0 ? 1 : -1));
    }
    const result = rsi(prices, 14);
    expect(result).toBeGreaterThan(40);
    expect(result).toBeLessThan(60);
  });

  test('result is between 0 and 100', () => {
    const prices = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i * 0.5) * 10);
    const result = rsi(prices, 14);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(100);
  });

  test('throws with insufficient data', () => {
    expect(() => rsi([1, 2, 3], 14)).toThrow();
  });
});
