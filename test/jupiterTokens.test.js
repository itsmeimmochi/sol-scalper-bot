import {
  resolveMintFromJupiterTokenList,
} from '../lib/jupiterTokens.js';

describe('resolveMintFromJupiterTokenList', () => {
  test('returns null when no match', () => {
    const out = resolveMintFromJupiterTokenList(
      { symbol: 'NOPE', name: 'Nope' },
      [{ address: 'mint1', symbol: 'SOL', name: 'Solana', tags: [], decimals: 9 }]
    );
    expect(out).toBe(null);
  });

  test('resolves unique symbol match', () => {
    const out = resolveMintFromJupiterTokenList(
      { symbol: 'SOL', name: 'Solana' },
      [{ address: 'So111', symbol: 'SOL', name: 'Solana', tags: [], decimals: 9 }]
    );
    expect(out).toEqual({ mint: 'So111' });
  });

  test('prefers strict/verified when symbol ambiguous', () => {
    const out = resolveMintFromJupiterTokenList(
      { symbol: 'ABC', name: 'Alpha Beta Coin' },
      [
        { address: 'mintA', symbol: 'ABC', name: 'Alpha Beta Coin', tags: [], decimals: 6 },
        { address: 'mintB', symbol: 'ABC', name: 'Alpha Beta Coin', tags: ['strict', 'verified'], decimals: 6 },
      ]
    );
    expect(out).toEqual({ mint: 'mintB' });
  });

  test('returns null when still ambiguous', () => {
    const out = resolveMintFromJupiterTokenList(
      { symbol: 'ABC', name: 'Alpha' },
      [
        { address: 'mintA', symbol: 'ABC', name: 'Alpha', tags: [], decimals: 6 },
        { address: 'mintB', symbol: 'ABC', name: 'Alpha', tags: [], decimals: 6 },
      ]
    );
    expect(out).toBe(null);
  });
});

