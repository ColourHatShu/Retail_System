import { describe, expect, it } from 'vitest';
import { applyBps, bpsToPercent, formatMoney, fromCents, percentToBps, toCents } from '../lib/money';

describe('toCents', () => {
  it('converts ordinary prices exactly', () => {
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(0.1)).toBe(10);
    expect(toCents(100)).toBe(10000);
    expect(toCents('4.50')).toBe(450);
  });

  it('survives binary floating point traps', () => {
    expect(toCents(1.005)).toBe(101); // naive Math.round(1.005*100) gives 100
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(4.35)).toBe(435); // 4.35*100 = 434.99999
  });

  it('handles negatives symmetrically', () => {
    expect(toCents(-1.005)).toBe(-101);
  });

  it('rejects garbage', () => {
    expect(() => toCents('abc')).toThrow(TypeError);
    expect(() => toCents(Number.NaN)).toThrow(TypeError);
    expect(() => toCents(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe('fromCents', () => {
  it('round-trips', () => {
    for (const v of [0, 1, 99, 100, 1999, 123456789]) {
      expect(toCents(fromCents(v))).toBe(v);
    }
  });
});

describe('tax', () => {
  it('converts percent to basis points and back', () => {
    expect(percentToBps(5)).toBe(500);
    expect(percentToBps('7.25')).toBe(725);
    expect(percentToBps(18)).toBe(1800);
    expect(bpsToPercent(725)).toBe(7.25);
  });

  it('applies rates with cent rounding', () => {
    expect(applyBps(597, 500)).toBe(30); // 29.85 -> 30
    expect(applyBps(1000, 500)).toBe(50);
    expect(applyBps(1, 500)).toBe(0); // 0.05 -> 0
    expect(applyBps(10, 500)).toBe(1); // 0.5 -> 1
    expect(applyBps(0, 500)).toBe(0);
    expect(applyBps(12345, 0)).toBe(0);
  });
});

describe('formatMoney', () => {
  it('formats with the currency symbol', () => {
    expect(formatMoney(627, 'USD')).toBe('$6.27');
    expect(formatMoney(0, 'USD')).toBe('$0.00');
  });

  it('falls back gracefully on unknown currency codes', () => {
    expect(formatMoney(150, 'ZZZ')).toContain('1.50');
  });
});
