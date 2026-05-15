import { tokenAllowsBuy } from '../lib/db.js';

describe('tokenAllowsBuy', () => {
  test('treats missing enabled as buyable', () => {
    expect(tokenAllowsBuy({ symbol: 'SOL' })).toBe(true);
  });

  test('blocks buy when enabled is false', () => {
    expect(tokenAllowsBuy({ symbol: 'SOL', enabled: false })).toBe(false);
  });

  test('allows buy when enabled is true', () => {
    expect(tokenAllowsBuy({ symbol: 'SOL', enabled: true })).toBe(true);
  });
});
