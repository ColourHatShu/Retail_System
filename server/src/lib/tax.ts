/**
 * Canadian sales tax.
 *
 * Two buckets, because they are filed with two different governments:
 *   - gst: GST, or HST in harmonized provinces — remitted to the CRA.
 *   - pst: PST / QST / RST — remitted to the province. Always 0 under HST.
 *
 * Each product carries a tax class:
 *   STANDARD  full tax (GST + PST, or full HST)
 *   GST_ONLY  federal part only (PST-exempt items, HST point-of-sale rebate items)
 *   EXEMPT    no tax (zero-rated basic groceries, exempt supplies)
 *
 * The receipt-level discount is spread over the classes in proportion to
 * their gross, with one rounding per base, and tax is rounded once per bucket
 * per receipt. The client mirrors this exactly (client/src/utils/tax.ts) so
 * the register total always matches the server's.
 */

export const TAX_CLASSES = ['STANDARD', 'GST_ONLY', 'EXEMPT'] as const;
export type TaxClass = (typeof TAX_CLASSES)[number];

export interface ProvinceInfo {
  name: string;
  gst_bps: number;
  pst_bps: number;
  hst: boolean;
  /** Name of the provincial tax when it is charged separately. */
  pst_label: 'PST' | 'QST' | 'RST' | null;
}

/**
 * Rates in force in 2026, in basis points (may be fractional: QST is 9.975%).
 * The owner can override either rate in the store profile.
 */
export const PROVINCES = {
  AB: { name: 'Alberta', gst_bps: 500, pst_bps: 0, hst: false, pst_label: null },
  BC: { name: 'British Columbia', gst_bps: 500, pst_bps: 700, hst: false, pst_label: 'PST' },
  MB: { name: 'Manitoba', gst_bps: 500, pst_bps: 700, hst: false, pst_label: 'RST' },
  NB: { name: 'New Brunswick', gst_bps: 500, pst_bps: 1000, hst: true, pst_label: null },
  NL: { name: 'Newfoundland and Labrador', gst_bps: 500, pst_bps: 1000, hst: true, pst_label: null },
  NS: { name: 'Nova Scotia', gst_bps: 500, pst_bps: 900, hst: true, pst_label: null },
  NT: { name: 'Northwest Territories', gst_bps: 500, pst_bps: 0, hst: false, pst_label: null },
  NU: { name: 'Nunavut', gst_bps: 500, pst_bps: 0, hst: false, pst_label: null },
  ON: { name: 'Ontario', gst_bps: 500, pst_bps: 800, hst: true, pst_label: null },
  PE: { name: 'Prince Edward Island', gst_bps: 500, pst_bps: 1000, hst: true, pst_label: null },
  QC: { name: 'Quebec', gst_bps: 500, pst_bps: 997.5, hst: false, pst_label: 'QST' },
  SK: { name: 'Saskatchewan', gst_bps: 500, pst_bps: 600, hst: false, pst_label: 'PST' },
  YT: { name: 'Yukon', gst_bps: 500, pst_bps: 0, hst: false, pst_label: null },
} as const satisfies Record<string, ProvinceInfo>;

export type Province = keyof typeof PROVINCES;
export const PROVINCE_CODES = Object.keys(PROVINCES) as Province[];

/** 9.975 (%) -> 997.5 (bps). Three decimals of a percent, which every Canadian rate fits. */
export function percentToRateBps(percent: number): number {
  return Math.round(percent * 1000) / 10;
}

export function isProvince(value: unknown): value is Province {
  return typeof value === 'string' && value in PROVINCES;
}

export interface TaxRates {
  gst_bps: number;
  pst_bps: number;
  hst: boolean;
}

export interface TaxLabels {
  /** Label for the CRA bucket: "GST", "HST", or "Tax" before a province is chosen. */
  gst: string;
  /** Label for the provincial bucket, or null when there is none to show. */
  pst: string | null;
}

export function taxLabels(province: string | null | undefined, pstBps: number): TaxLabels {
  if (!isProvince(province)) return { gst: 'Tax', pst: pstBps > 0 ? 'Provincial tax' : null };
  const p: ProvinceInfo = PROVINCES[province];
  if (p.hst) return { gst: 'HST', pst: null };
  return { gst: 'GST', pst: pstBps > 0 ? (p.pst_label ?? 'PST') : null };
}

export interface TaxLine {
  gross_cents: number;
  tax_class: TaxClass;
}

export interface TaxResult {
  subtotal_cents: number;
  taxable_cents: number;
  gst_cents: number;
  pst_cents: number;
  tax_cents: number;
  total_cents: number;
}

function bps(cents: number, rate: number): number {
  return Math.round((cents * rate) / 10000);
}

export function computeTax(lines: TaxLine[], discountCents: number, rates: TaxRates): TaxResult {
  let subtotal = 0;
  let federalGross = 0;
  let provincialGross = 0;
  for (const l of lines) {
    subtotal += l.gross_cents;
    if (l.tax_class !== 'EXEMPT') federalGross += l.gross_cents;
    if (l.tax_class === 'STANDARD') provincialGross += l.gross_cents;
  }
  const taxable = subtotal - discountCents;
  const share = (gross: number) => (subtotal > 0 ? Math.round((taxable * gross) / subtotal) : 0);
  const federalBase = share(federalGross);
  const provincialBase = share(provincialGross);

  let gst: number;
  let pst: number;
  if (rates.hst) {
    // One harmonized tax: full rate on STANDARD, federal part only on GST_ONLY.
    gst = bps(provincialBase, rates.gst_bps + rates.pst_bps) + bps(federalBase - provincialBase, rates.gst_bps);
    pst = 0;
  } else {
    gst = bps(federalBase, rates.gst_bps);
    pst = bps(provincialBase, rates.pst_bps);
  }
  return {
    subtotal_cents: subtotal,
    taxable_cents: taxable,
    gst_cents: gst,
    pst_cents: pst,
    tax_cents: gst + pst,
    total_cents: taxable + gst + pst,
  };
}

/**
 * Unrounded refund parts for `quantity` units of one receipt line: the line's
 * share of the discounted subtotal plus the tax that share attracted.
 */
export function refundParts(
  unitPriceCents: number,
  quantity: number,
  taxClass: TaxClass,
  sale: { subtotal_cents: number; discount_cents: number },
  rates: TaxRates,
): { base: number; gst: number; pst: number } {
  const ratio = sale.subtotal_cents > 0 ? (sale.subtotal_cents - sale.discount_cents) / sale.subtotal_cents : 0;
  const base = unitPriceCents * quantity * ratio;
  if (taxClass === 'EXEMPT') return { base, gst: 0, pst: 0 };
  if (taxClass === 'GST_ONLY') return { base, gst: (base * rates.gst_bps) / 10000, pst: 0 };
  if (rates.hst) return { base, gst: (base * (rates.gst_bps + rates.pst_bps)) / 10000, pst: 0 };
  return { base, gst: (base * rates.gst_bps) / 10000, pst: (base * rates.pst_bps) / 10000 };
}
