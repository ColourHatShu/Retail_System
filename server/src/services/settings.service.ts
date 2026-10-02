import { currentDb, rows, withTransaction } from '../db';
import type { Queryable } from '../db';
import { bpsToPercent, fromCents, toCents } from '../lib/money';
import { isProvince, percentToRateBps, PROVINCES, taxLabels } from '../lib/tax';
import type { TaxLabels, TaxRates } from '../lib/tax';
import type { SettingsUpdate } from '../schemas';
import type { Settings } from '../types';

const DEFAULTS: Settings = {
  store_name: 'Nexus POS',
  currency: 'USD',
  tax_rate_bps: 500,
  province: null,
  gst_rate_bps: 500,
  pst_rate_bps: 0,
  gst_number: null,
  pst_number: null,
  store_address: null,
  store_phone: null,
  return_window_days: 30,
  refund_approval_threshold_cents: 5000,
  timezone: 'America/Toronto',
};

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Validated here rather than at the call site: an unknown IANA zone makes Intl
 * throw, and that must never be the reason a checkout fails.
 */
function zone(value: string | undefined): string {
  if (!value) return DEFAULTS.timezone;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value });
    return value;
  } catch {
    return DEFAULTS.timezone;
  }
}

/** Raw settings as stored (tax in basis points, money in cents). Used by services. */
export async function getSettings(db: Queryable = currentDb()): Promise<Settings> {
  const list = await rows<{ key: string; value: string }>(db, 'SELECT key, value FROM settings');
  const map = new Map(list.map((r) => [r.key, r.value]));
  const legacyRate = int(map.get('tax_rate_bps'), DEFAULTS.tax_rate_bps);
  const province = map.get('province');
  // A shop that has never chosen a province keeps its old single rate as "Tax".
  const gst = int(map.get('gst_rate_bps'), legacyRate);
  const pst = int(map.get('pst_rate_bps'), 0);
  const text = (key: string) => map.get(key) || null;
  return {
    store_name: map.get('store_name') ?? DEFAULTS.store_name,
    currency: map.get('currency') ?? DEFAULTS.currency,
    tax_rate_bps: gst + pst,
    province: isProvince(province) ? province : null,
    gst_rate_bps: gst,
    pst_rate_bps: pst,
    gst_number: text('gst_number'),
    pst_number: text('pst_number'),
    store_address: text('store_address'),
    store_phone: text('store_phone'),
    return_window_days: int(map.get('return_window_days'), DEFAULTS.return_window_days),
    refund_approval_threshold_cents: int(
      map.get('refund_approval_threshold_cents'),
      DEFAULTS.refund_approval_threshold_cents,
    ),
    timezone: zone(map.get('timezone')),
  };
}

export function taxRates(s: Settings): TaxRates {
  return { gst_bps: s.gst_rate_bps, pst_bps: s.pst_rate_bps, hst: s.province ? PROVINCES[s.province].hst : false };
}

export interface SettingsApi {
  store_name: string;
  currency: string;
  /** GST/HST + PST combined: the rate a fully taxable item pays. */
  tax_rate_percent: number;
  province: string | null;
  gst_rate_percent: number;
  pst_rate_percent: number;
  hst: boolean;
  tax_labels: TaxLabels;
  gst_number: string | null;
  pst_number: string | null;
  store_address: string | null;
  store_phone: string | null;
  return_window_days: number;
  refund_approval_threshold: number;
}

/** API-facing shape (tax as a percentage, money as decimals). */
export async function getSettingsApi(db: Queryable = currentDb()): Promise<SettingsApi> {
  const s = await getSettings(db);
  return {
    store_name: s.store_name,
    currency: s.currency,
    tax_rate_percent: bpsToPercent(s.tax_rate_bps),
    province: s.province,
    gst_rate_percent: bpsToPercent(s.gst_rate_bps),
    pst_rate_percent: bpsToPercent(s.pst_rate_bps),
    hst: taxRates(s).hst,
    tax_labels: taxLabels(s.province, s.pst_rate_bps),
    gst_number: s.gst_number,
    pst_number: s.pst_number,
    store_address: s.store_address,
    store_phone: s.store_phone,
    return_window_days: s.return_window_days,
    refund_approval_threshold: fromCents(s.refund_approval_threshold_cents),
  };
}

export async function updateSettings(input: SettingsUpdate): Promise<SettingsApi> {
  return withTransaction(async (tx) => {
    const upsert = (key: string, value: string) =>
      tx.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, value],
      );
    if (input.store_name !== undefined) await upsert('store_name', input.store_name);
    if (input.currency !== undefined) await upsert('currency', input.currency);
    // Rates: an explicit rate wins; otherwise a newly chosen province brings
    // its own. tax_rate_bps is kept equal to the combined rate for old readers.
    const current = await getSettings(tx);
    let gst = current.gst_rate_bps;
    let pst = current.pst_rate_bps;
    if (input.tax_rate_percent !== undefined) {
      gst = percentToRateBps(input.tax_rate_percent);
      pst = 0;
    }
    if (input.province !== undefined) {
      await upsert('province', input.province ?? '');
      if (input.province && isProvince(input.province)) {
        gst = PROVINCES[input.province].gst_bps;
        pst = PROVINCES[input.province].pst_bps;
      }
    }
    if (input.gst_rate_percent !== undefined) gst = percentToRateBps(input.gst_rate_percent);
    if (input.pst_rate_percent !== undefined) pst = percentToRateBps(input.pst_rate_percent);
    if (gst !== current.gst_rate_bps || pst !== current.pst_rate_bps) {
      await upsert('gst_rate_bps', String(gst));
      await upsert('pst_rate_bps', String(pst));
      await upsert('tax_rate_bps', String(gst + pst));
    }
    for (const key of ['gst_number', 'pst_number', 'store_address', 'store_phone'] as const) {
      if (input[key] !== undefined) await upsert(key, input[key] ?? '');
    }
    if (input.return_window_days !== undefined) {
      await upsert('return_window_days', String(input.return_window_days));
    }
    if (input.refund_approval_threshold !== undefined) {
      await upsert('refund_approval_threshold_cents', String(toCents(input.refund_approval_threshold)));
    }
    return getSettingsApi(tx);
  });
}
