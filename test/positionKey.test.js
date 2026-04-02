import assert from 'node:assert/strict';
import { positionKey } from '../lib/positionKey.js';

describe('positionKey', () => {
  it('separates simulated and live lanes', () => {
    const a = positionKey('SOL', true);
    const b = positionKey('SOL', false);
    assert.notEqual(a, b);
  });

  it('is stable and deterministic', () => {
    assert.equal(positionKey('BONK', true), positionKey('BONK', true));
    assert.equal(positionKey('BONK', false), positionKey('BONK', false));
  });
});

