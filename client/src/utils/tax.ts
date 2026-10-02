/**
 * Mirror of server/src/lib/tax.ts computeTax. Keep the two identical: the
 * register's total is sent as `expected_total`, and the server refuses the
 * sale if its own maths disagrees by a single cent.
 */

export type TaxClass = 'STANDARD' | 'GST_ONLY' | 'EXEMPT';

export const TAX_CLASS_OPTIONS: Array<{ value: TaxClass; label: string; hint: string }> = [
  { value: 'STANDARD', label: 'Fully taxable', hint: 'GST + PST, or full HST' },
  { value: 'GST_ONLY', label: 'GST only', hint: 'No provincial part (e.g. PST-exempt items)' },
  { value: 'EXEMPT', label: 'No tax', hint: 'Zero-rated or exempt (e.g. basic groceries)' },
];

export const PROVINCE_OPTIONS: Array<{ code: string; name: string }> = [
  { code: 'AB', name: 'Alberta' },
  { code: 'BC', name: 'British Columbia' },
  { code: 'MB', name: 'Manitoba' },
  { code: 'NB', name: 'New Brunswick' },
  { code: 'NL', name: 'Newfoundland and Labrador' },
  { code: 'NS', name: 'Nova Scotia' },
  { code: 'NT', name: 'Northwest Territories' },
  { code: 'NU', name: 'Nunavut' },
  { code: 'ON', name: 'Ontario' },
  { code: 'PE', name: 'Prince Edward Island' },
  { code: 'QC', name: 'Quebec' },
  { code: 'SK', name: 'Saskatchewan' },
  { code: 'YT', name: 'Yukon' },
];

export interface TaxRates {
  gst_bps: number;
  pst_bps: number;
  hst: boolean;
}

/** 9.975 (%) -> 997.5 (bps), exactly as the server stores it. */
export function percentToRateBps(percent: number): number {
  return Math.round(percent * 1000) / 10;
}

function bps(cents: number, rate: number): number {
  return Math.round((cents * rate) / 10000);
}

export function computeTax(
  lines: Array<{ gross_cents: number; tax_class: TaxClass }>,
  discountCents: number,
  rates: TaxRates,
) {
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

/** "123456789RT0001" -> "123456789 RT0001", the way the CRA prints it. */
export function formatGstNumber(value: string | null | undefined): string {
  if (!value) return '';
  const m = /^(\d{9})(RT\d{4})$/.exec(value);
  return m ? `${m[1]} ${m[2]}` : value;
}
