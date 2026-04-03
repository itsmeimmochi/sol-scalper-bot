/**
 * Convert UI (human) token amounts to atomic units for Jupiter and SPL.
 */

/**
 * Floor a UI token amount to atomic units (integer smallest units).
 * Position sizes here are far below Number precision limits; very large values may lose precision.
 *
 * @param {number} uiAmount
 * @param {number} decimals SPL mint decimals (0–18)
 * @returns {bigint}
 */
export function uiAmountToRawFloorBigInt(uiAmount, decimals) {
  if (!Number.isFinite(uiAmount) || uiAmount <= 0) {
    return 0n;
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`Invalid mint decimals: ${decimals}`);
  }
  const scaled = uiAmount * 10 ** decimals;
  if (!Number.isFinite(scaled)) {
    throw new Error('Token amount out of range for conversion');
  }
  return BigInt(Math.floor(scaled + 1e-12));
}
