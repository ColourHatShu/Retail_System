import { describe, expect, it } from 'vitest';
import { computeTax, PROVINCES, refundParts, taxLabels } from '../lib/tax';
import type { TaxRates } from '../lib/tax';

const rates = (code: keyof typeof PROVINCES): TaxRates => ({
  gst_bps: PROVINCES[code].gst_bps,
  pst_bps: PROVINCES[code].pst_bps,
  hst: PROVINCES[code].hst,
});

describe('computeTax', () => {
  it('charges 13% HST in Ontario as one amount', () => {
    const r = computeTax([{ gross_cents: 1000, tax_class: 'STANDARD' }], 0, rates('ON'));
    expect(r).toMatchObject({ gst_cents: 130, pst_cents: 0, total_cents: 1130 });
  });

  it('keeps GST and PST apart in British Columbia', () => {
    const r = computeTax([{ gross_cents: 1000, tax_class: 'STANDARD' }], 0, rates('BC'));
    expect(r).toMatchObject({ gst_cents: 50, pst_cents: 70, total_cents: 1120 });
  });

  it('charges QST at 9.975% in Quebec', () => {
    const r = computeTax([{ gross_cents: 10000, tax_class: 'STANDARD' }], 0, rates('QC'));
    expect(r).toMatchObject({ gst_cents: 500, pst_cents: 998 });
    // 9.975% of $33.33 is $3.3247 -> $3.32 (a 9.98% rate would give $3.33).
    expect(computeTax([{ gross_cents: 3333, tax_class: 'STANDARD' }], 0, rates('QC')).pst_cents).toBe(332);
  });

  it('respects tax classes on one receipt', () => {
    const r = computeTax(
      [
        { gross_cents: 1000, tax_class: 'STANDARD' },
        { gross_cents: 1000, tax_class: 'GST_ONLY' },
        { gross_cents: 1000, tax_class: 'EXEMPT' },
      ],
      0,
      rates('BC'),
    );
    expect(r).toMatchObject({ subtotal_cents: 3000, gst_cents: 100, pst_cents: 70, total_cents: 3170 });
    const on = computeTax(
      [
        { gross_cents: 1000, tax_class: 'STANDARD' },
        { gross_cents: 1000, tax_class: 'GST_ONLY' },
      ],
      0,
      rates('ON'),
    );
    expect(on.gst_cents).toBe(180);
  });

  it('spreads a receipt discount over the taxable and exempt parts', () => {
    const r = computeTax(
      [
        { gross_cents: 1000, tax_class: 'STANDARD' },
        { gross_cents: 1000, tax_class: 'EXEMPT' },
      ],
      200,
      rates('AB'),
    );
    // Half the discount lands on the taxable item: GST on $9.00.
    expect(r).toMatchObject({ taxable_cents: 1800, gst_cents: 45, total_cents: 1845 });
  });

  it('matches the old single-rate maths when everything is STANDARD and no province is set', () => {
    const r = computeTax([{ gross_cents: 1999, tax_class: 'STANDARD' }], 0, { gst_bps: 500, pst_bps: 0, hst: false });
    expect(r.tax_cents).toBe(Math.round((1999 * 500) / 10000));
  });
});

describe('refundParts', () => {
  it('refunds an exempt line without tax and a standard line with it', () => {
    const sale = { subtotal_cents: 2000, discount_cents: 0 };
    expect(refundParts(1000, 1, 'EXEMPT', sale, rates('BC'))).toEqual({ base: 1000, gst: 0, pst: 0 });
    expect(refundParts(1000, 1, 'STANDARD', sale, rates('BC'))).toEqual({ base: 1000, gst: 50, pst: 70 });
  });
});

describe('taxLabels', () => {
  it('names the taxes the way a Canadian receipt does', () => {
    expect(taxLabels('ON', 800)).toEqual({ gst: 'HST', pst: null });
    expect(taxLabels('QC', 998)).toEqual({ gst: 'GST', pst: 'QST' });
    expect(taxLabels('AB', 0)).toEqual({ gst: 'GST', pst: null });
    expect(taxLabels(null, 0)).toEqual({ gst: 'Tax', pst: null });
  });
});
