/**
 * Money handling.
 *
 * Rule: every monetary value is STORED and COMPUTED as an integer number of
 * cents (minor units). Decimal "major unit" numbers (e.g. 19.99) exist only at
 * the API boundary, converted with toCents() on the way in and fromCents() on
 * the way out. Tax rates are stored as basis points (500 bps = 5.00%).
 */

/** Convert a decimal amount (number or numeric string) into integer cents. */
export function toCents(amount: number | string): number {
  const n = typeof amount === 'string' ? Number(amount.trim()) : amount;
  if (!Number.isFinite(n)) {
    throw new TypeError(`Invalid monetary amount: ${String(amount)}`);
  }
  // The tiny epsilon prevents 1.005 * 100 = 100.49999 from rounding down.
  const sign = n < 0 ? -1 : 1;
  return sign * Math.round((Math.abs(n) + 1e-9) * 100);
}

/** Convert integer cents back to a decimal number for API responses. */
export function fromCents(cents: number): number {
  return cents / 100;
}

/** Convert a percentage (5 or "5.25") into basis points (500, 525). */
export function percentToBps(percent: number | string): number {
  const n = typeof percent === 'string' ? Number(percent.trim()) : percent;
  if (!Number.isFinite(n)) {
    throw new TypeError(`Invalid percentage: ${String(percent)}`);
  }
  const sign = n < 0 ? -1 : 1;
  return sign * Math.round((Math.abs(n) + 1e-9) * 100);
}

export function bpsToPercent(bps: number): number {
  return bps / 100;
}

/** Apply a basis-point rate to a cents amount, rounding half-up to the cent. */
export function applyBps(cents: number, bps: number): number {
  return Math.round((cents * bps) / 10000);
}

/** Human-readable money for error messages, e.g. "$6.27". */
export function formatMoney(cents: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}
