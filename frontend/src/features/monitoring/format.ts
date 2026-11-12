/** 位移量保留 1 位小数（mm）。 */
export const MILLIMETER_DIGITS = 1;
/** 速率保留 2 位小数（mm/天）：慢速形变常在 0.01～0.1 mm/天，只留 1 位会显示成 0。 */
export const RATE_DIGITS = 2;

/** 带正负号的数值；四舍五入后为 0 时不带符号，避免出现“-0.0”。 */
export function formatSigned(value: number, digits: number): string {
  const rounded = Number(value.toFixed(digits));
  if (rounded === 0) {
    return (0).toFixed(digits);
  }
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(digits)}`;
}
