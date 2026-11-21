export const MILLIMETER_DIGITS = 1;
export const RATE_DIGITS = 2;

export function formatSigned(value: number, digits: number): string {
  const rounded = Number(value.toFixed(digits));
  if (rounded === 0) {
    return (0).toFixed(digits);
  }
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(digits)}`;
}
