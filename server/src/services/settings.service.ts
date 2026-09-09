import { getPool, rows, withTransaction } from '../db';
import type { Queryable } from '../db';
import { bpsToPercent, fromCents, percentToBps, toCents } from '../lib/money';
import type { SettingsUpdate } from '../schemas';
import type { Settings } from '../types';

const DEFAULTS: Settings = {
  store_name: 'Nexus POS',
  currency: 'USD',
  tax_rate_bps: 500,
  return_window_days: 30,
  refund_approval_threshold_cents: 5000,
};

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Raw settings as stored (tax in basis points, money in cents). Used by services. */
export async function getSettings(db: Queryable = getPool()): Promise<Settings> {
  const list = await rows<{ key: string; value: string }>(db, 'SELECT key, value FROM settings');
  const map = new Map(list.map((r) => [r.key, r.value]));
  return {
    store_name: map.get('store_name') ?? DEFAULTS.store_name,
    currency: map.get('currency') ?? DEFAULTS.currency,
    tax_rate_bps: int(map.get('tax_rate_bps'), DEFAULTS.tax_rate_bps),
    return_window_days: int(map.get('return_window_days'), DEFAULTS.return_window_days),
    refund_approval_threshold_cents: int(
      map.get('refund_approval_threshold_cents'),
      DEFAULTS.refund_approval_threshold_cents,
    ),
  };
}

export interface SettingsApi {
  store_name: string;
  currency: string;
  tax_rate_percent: number;
  return_window_days: number;
  refund_approval_threshold: number;
}

/** API-facing shape (tax as a percentage, money as decimals). */
export async function getSettingsApi(db: Queryable = getPool()): Promise<SettingsApi> {
  const s = await getSettings(db);
  return {
    store_name: s.store_name,
    currency: s.currency,
    tax_rate_percent: bpsToPercent(s.tax_rate_bps),
    return_window_days: s.return_window_days,
    refund_approval_threshold: fromCents(s.refund_approval_threshold_cents),
  };
}

export async function updateSettings(input: SettingsUpdate): Promise<SettingsApi> {
  return withTransaction(async (tx) => {
    const upsert = (key: string, value: string) =>
      tx.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, value],
      );
    if (input.store_name !== undefined) await upsert('store_name', input.store_name);
    if (input.currency !== undefined) await upsert('currency', input.currency);
    if (input.tax_rate_percent !== undefined) {
      await upsert('tax_rate_bps', String(percentToBps(input.tax_rate_percent)));
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
