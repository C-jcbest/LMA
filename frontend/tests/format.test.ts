import { expect, it } from 'vitest';
import { formatSigned, MILLIMETER_DIGITS, RATE_DIGITS } from '../src/features/monitoring/format';

it('四舍五入为 0 时不显示负号，正数带加号', () => {
  expect(formatSigned(-0.0004, MILLIMETER_DIGITS)).toBe('0.0');
  expect(formatSigned(-0.04, MILLIMETER_DIGITS)).toBe('0.0');
  expect(formatSigned(3.06, MILLIMETER_DIGITS)).toBe('+3.1');
  expect(formatSigned(-18.94, MILLIMETER_DIGITS)).toBe('-18.9');
});

it('慢速形变的速率保留两位小数，不被显示成 0', () => {
  expect(formatSigned(-0.034, RATE_DIGITS)).toBe('-0.03');
  expect(formatSigned(0.004, RATE_DIGITS)).toBe('0.00');
});
