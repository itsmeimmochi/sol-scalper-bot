/**
 * tokenAmount.test.js — UI → atomic conversion for Jupiter sells.
 */

import { uiAmountToRawFloorBigInt } from '../lib/tokenAmount.js';

describe('uiAmountToRawFloorBigInt', () => {
  test('floors UI to raw for 6 decimals', () => {
    expect(uiAmountToRawFloorBigInt(1.5, 6)).toBe(1_500_000n);
    expect(uiAmountToRawFloorBigInt(25, 6)).toBe(25_000_000n);
  });

  test('floors UI to raw for 9 decimals', () => {
    expect(uiAmountToRawFloorBigInt(1.234567891, 9)).toBe(1_234_567_891n);
  });

  test('returns 0 for non-positive or non-finite', () => {
    expect(uiAmountToRawFloorBigInt(0, 6)).toBe(0n);
    expect(uiAmountToRawFloorBigInt(-1, 6)).toBe(0n);
    expect(uiAmountToRawFloorBigInt(Number.NaN, 6)).toBe(0n);
    expect(uiAmountToRawFloorBigInt(Number.POSITIVE_INFINITY, 6)).toBe(0n);
  });

  test('rejects invalid decimals', () => {
    expect(() => uiAmountToRawFloorBigInt(1, -1)).toThrow(/Invalid mint decimals/);
    expect(() => uiAmountToRawFloorBigInt(1, 19)).toThrow(/Invalid mint decimals/);
    expect(() => uiAmountToRawFloorBigInt(1, 1.5)).toThrow(/Invalid mint decimals/);
  });
});
