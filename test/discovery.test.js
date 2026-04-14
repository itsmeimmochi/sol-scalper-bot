import { isLikelyWrappedAsset } from '../lib/discovery.js';

describe('isLikelyWrappedAsset', () => {
  test('flags wrapped/bridged by name', () => {
    expect(isLikelyWrappedAsset({ id: 'foo', symbol: 'ABC', name: 'Wrapped ABC' })).toBe(true);
    expect(isLikelyWrappedAsset({ id: 'foo', symbol: 'ABC', name: 'Bridged ABC' })).toBe(true);
  });

  test('flags wormhole/portal hints', () => {
    expect(isLikelyWrappedAsset({ id: 'foo-wormhole', symbol: 'ABC', name: 'ABC' })).toBe(true);
    expect(isLikelyWrappedAsset({ id: 'foo', symbol: 'ABC', name: 'ABC (Wormhole)' })).toBe(true);
  });

  test('does not flag normal assets', () => {
    expect(isLikelyWrappedAsset({ id: 'solana', symbol: 'SOL', name: 'Solana' })).toBe(false);
    expect(isLikelyWrappedAsset({ id: 'bonk', symbol: 'BONK', name: 'Bonk' })).toBe(false);
  });
});

