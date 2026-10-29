// Pure number-line geometry, shared by server tests and widget conventions.
export const MIN = -4;
export const MAX = 4;
export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
export const valueToX = (value) => (value - MIN) / (MAX - MIN);
export const xToValue = (x) => MIN + clamp(x, 0, 1) * (MAX - MIN);
export const nearestTick = (x) => Math.round(xToValue(x));
export function validateTick(value) {
  if (!Number.isInteger(value) || value < MIN || value > MAX) {
    throw new RangeError("Tick must be an integer between -4 and 4");
  }
  return value;
}
