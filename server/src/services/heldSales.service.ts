import { currentDb, row, rows } from '../db';
import { notFound } from '../lib/errors';
import { fromCents, toCents } from '../lib/money';
import type { HeldSaleCreate } from '../schemas';
import type { AuthUser } from '../types';

/**
 * Parked carts. Kept on the server so either counter can pick one up.
 * Resuming deletes the row in the same statement, so two counters can never
 * both resume the same cart.
 */

export interface HeldSale {
  id: number;
  label: string | null;
  payload: Omit<HeldSaleCreate, 'label' | 'total'>;
  item_count: number;
  total: number;
  created_by_name: string | null;
  created_at: string;
}

interface HeldRow {
  id: number;
  label: string | null;
  payload: HeldSale['payload'];
  item_count: number;
  total_cents: number;
  created_by_name: string | null;
  created_at: string;
}

const serialize = (r: HeldRow): HeldSale => ({
  id: r.id,
  label: r.label,
  payload: r.payload,
  item_count: r.item_count,
  total: fromCents(r.total_cents),
  created_by_name: r.created_by_name,
  created_at: r.created_at,
});

export async function listHeld(): Promise<HeldSale[]> {
  const list = await rows<HeldRow>(
    currentDb(),
    `SELECT h.*, u.display_name AS created_by_name
     FROM held_sales h LEFT JOIN users u ON u.id = h.created_by
     ORDER BY h.id DESC`,
  );
  return list.map(serialize);
}

export async function holdSale(input: HeldSaleCreate, user: AuthUser): Promise<HeldSale> {
  const { label, total, ...payload } = input;
  const created = (await row<{ id: number }>(
    currentDb(),
    `INSERT INTO held_sales (label, payload, item_count, total_cents, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      label ?? null,
      JSON.stringify(payload),
      payload.items.reduce((a, i) => a + i.quantity, 0),
      toCents(total ?? 0),
      user.id,
    ],
  ))!;
  return (await listHeld()).find((h) => h.id === created.id)!;
}

export async function resumeHeld(id: number): Promise<HeldSale> {
  const taken = await row<HeldRow>(
    currentDb(),
    `DELETE FROM held_sales h WHERE h.id = $1
     RETURNING h.*, NULL::text AS created_by_name`,
    [id],
  );
  if (!taken) throw notFound('That held sale was already resumed or discarded');
  return serialize(taken);
}
