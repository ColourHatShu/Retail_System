import type { Queryable } from '../db';
import { fromCents } from '../lib/money';
import type { MovementType, StockMovement, StockMovementRow } from '../types';

/**
 * The stock ledger. Every change to products.stock_quantity MUST be paired
 * with a movement row so the audit trail can always reconstruct the balance.
 * Always called inside the transaction that changed the stock.
 */
export interface MovementInput {
  product_id: number;
  type: MovementType;
  quantity_change: number;
  quantity_before: number;
  quantity_after: number;
  reference_id?: string | null;
  reason?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  payment_method?: string | null;
  sale_id?: number | null;
  /** The signed-in user who caused the movement. */
  user_id?: number | null;
}

export async function recordMovement(tx: Queryable, m: MovementInput): Promise<StockMovementRow> {
  if (m.quantity_before + m.quantity_change !== m.quantity_after) {
    throw new Error(
      `Ledger integrity violation: ${m.quantity_before} + ${m.quantity_change} != ${m.quantity_after}`,
    );
  }
  const result = await tx.query<StockMovementRow>(
    `INSERT INTO stock_movements (
       product_id, type, quantity_change, quantity_before, quantity_after,
       reference_id, reason, customer_name, customer_phone, payment_method, sale_id, user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      m.product_id,
      m.type,
      m.quantity_change,
      m.quantity_before,
      m.quantity_after,
      m.reference_id ?? null,
      m.reason ?? null,
      m.customer_name ?? null,
      m.customer_phone ?? null,
      m.payment_method ?? null,
      m.sale_id ?? null,
      m.user_id ?? null,
    ],
  );
  return result.rows[0];
}

export function serializeMovement(row: StockMovementRow): StockMovement {
  const { product_price_cents, ...rest } = row;
  return {
    ...rest,
    ...(product_price_cents !== undefined ? { product_price: fromCents(product_price_cents) } : {}),
  };
}
