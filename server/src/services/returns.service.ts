import { getPool, row, rows, withTransaction } from '../db';
import type { Queryable } from '../db';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { formatMoney, fromCents } from '../lib/money';
import type { ReturnCreate } from '../schemas';
import type {
  AuthUser,
  Pagination,
  PaymentMethod,
  ReturnItemRow,
  ReturnRecord,
  ReturnRow,
  Sale,
  SaleItemRow,
  SaleRow,
  SaleStatus,
} from '../types';
import { applyStockDelta } from './inventory.service';
import { recordMovement } from './ledger';
import { requireProductRowById } from './products.service';
import { getSaleItems, nextDocumentNumber, serializeSale } from './sales.service';
import { getSettings } from './settings.service';

const VOID_WINDOW_HOURS = 24;

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

const RETURN_SELECT = `
  SELECT r.*, s.receipt_number, u.display_name AS processed_by_name
  FROM returns r
  JOIN sales s ON s.id = r.sale_id
  LEFT JOIN users u ON u.id = r.processed_by
`;

function serializeReturn(r: ReturnRow, items?: ReturnItemRow[]): ReturnRecord {
  return {
    id: r.id,
    return_number: r.return_number,
    kind: r.kind,
    sale_id: r.sale_id,
    receipt_number: r.receipt_number,
    refund: fromCents(r.refund_cents),
    refund_method: r.refund_method,
    reason: r.reason,
    processed_by: r.processed_by,
    processed_by_name: r.processed_by_name ?? null,
    created_at: r.created_at,
    ...(items
      ? {
          items: items.map((i) => ({
            sale_item_id: i.sale_item_id,
            product_id: i.product_id,
            name: i.product_name,
            quantity: i.quantity,
            unit_price: fromCents(i.unit_price_cents),
            refund: fromCents(i.refund_cents),
            restock: i.restock,
            condition: i.condition,
          })),
        }
      : {}),
  };
}

export async function getReturn(id: number, db: Queryable = getPool()): Promise<ReturnRecord> {
  const r = await row<ReturnRow>(db, `${RETURN_SELECT} WHERE r.id = $1`, [id]);
  if (!r) throw notFound(`Return ${id} not found`);
  const items = await rows<ReturnItemRow>(db, 'SELECT * FROM return_items WHERE return_id = $1 ORDER BY id', [id]);
  return serializeReturn(r, items);
}

export async function listReturns(
  limit: number,
  offset: number,
): Promise<{ data: ReturnRecord[]; pagination: Pagination }> {
  const db = getPool();
  const list = await rows<ReturnRow>(
    db,
    `${RETURN_SELECT} ORDER BY r.created_at DESC, r.id DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  const { total } = (await row<{ total: number }>(db, 'SELECT COUNT(*) AS total FROM returns'))!;
  return { data: list.map((r) => serializeReturn(r)), pagination: { total, limit, offset } };
}

export async function returnsForSale(saleId: number): Promise<ReturnRecord[]> {
  const list = await rows<ReturnRow>(getPool(), `${RETURN_SELECT} WHERE r.sale_id = $1 ORDER BY r.id`, [saleId]);
  return list.map((r) => serializeReturn(r));
}

// ---------------------------------------------------------------------------
// Refund maths
// ---------------------------------------------------------------------------

interface PlannedLine {
  item: SaleItemRow;
  quantity: number;
  restock: boolean;
  condition: string;
  refund_cents: number;
}

interface ReturnPlan {
  sale: SaleRow & { refunded_cents: number };
  items: SaleItemRow[];
  lines: PlannedLine[];
  refund_cents: number;
  refund_method: PaymentMethod;
  completes_sale: boolean;
  requires_manager: boolean;
  window_closed: boolean;
}

/**
 * Each returned unit refunds its share of what the customer actually paid:
 * the line's gross price scaled by (total / subtotal), which folds in both
 * the receipt-level discount and tax. When a return completes the sale, the
 * refund is forced to exactly the remaining paid amount so rounding can never
 * leave a cent behind or refund a cent too many.
 */
function planLines(
  sale: SaleRow & { refunded_cents: number },
  items: SaleItemRow[],
  requested: ReturnCreate['items'],
): { lines: PlannedLine[]; refund_cents: number; completes_sale: boolean } {
  const seen = new Set<number>();
  const lines: PlannedLine[] = [];

  for (const req of requested) {
    if (seen.has(req.sale_item_id)) throw badRequest(`Line ${req.sale_item_id} is listed twice`);
    seen.add(req.sale_item_id);

    const item = items.find((i) => i.id === req.sale_item_id);
    if (!item) throw badRequest(`Line ${req.sale_item_id} does not belong to this receipt`);

    const remaining = item.quantity - (item.returned_quantity ?? 0);
    if (req.quantity > remaining) {
      throw conflict(
        'RETURN_EXCEEDS_SALE',
        `Only ${remaining} of "${item.product_name}" can still be returned on this receipt`,
        { sale_item_id: item.id, remaining, requested: req.quantity },
      );
    }

    lines.push({ item, quantity: req.quantity, restock: req.restock, condition: req.condition, refund_cents: 0 });
  }

  const ratio = sale.subtotal_cents > 0 ? sale.total_cents / sale.subtotal_cents : 0;
  for (const l of lines) {
    l.refund_cents = Math.round(l.item.unit_price_cents * l.quantity * ratio);
  }

  const completes_sale = items.every((it) => {
    const now = lines.find((l) => l.item.id === it.id)?.quantity ?? 0;
    return (it.returned_quantity ?? 0) + now >= it.quantity;
  });

  const remainingPaid = sale.total_cents - sale.refunded_cents;
  let refund_cents = lines.reduce((s, l) => s + l.refund_cents, 0);

  if (completes_sale || refund_cents > remainingPaid) {
    // Absorb any rounding drift on the last line.
    const target = completes_sale ? remainingPaid : Math.min(refund_cents, remainingPaid);
    const last = lines[lines.length - 1];
    last.refund_cents += target - refund_cents;
    refund_cents = target;
  }

  return { lines, refund_cents, completes_sale };
}

async function lockSale(
  tx: Queryable,
  ref: { sale_id?: number; receipt_number?: string },
): Promise<SaleRow & { refunded_cents: number }> {
  const sale =
    ref.sale_id !== undefined
      ? await row<SaleRow>(tx, 'SELECT * FROM sales WHERE id = $1 FOR UPDATE', [ref.sale_id])
      : await row<SaleRow>(tx, 'SELECT * FROM sales WHERE receipt_number = $1 FOR UPDATE', [
          (ref.receipt_number ?? '').trim().toUpperCase(),
        ]);
  if (!sale) throw notFound(`Receipt ${ref.receipt_number ?? ref.sale_id} not found`);
  const { refunded } = (await row<{ refunded: number }>(
    tx,
    'SELECT COALESCE(SUM(refund_cents), 0) AS refunded FROM returns WHERE sale_id = $1',
    [sale.id],
  ))!;
  return { ...sale, refunded_cents: refunded };
}

async function buildPlan(tx: Queryable, input: ReturnCreate, kind: 'RETURN' | 'VOID'): Promise<ReturnPlan> {
  const settings = await getSettings(tx);
  const sale = await lockSale(tx, input);

  if (sale.status === 'VOIDED') {
    throw conflict('SALE_VOIDED', `Receipt ${sale.receipt_number} was voided and cannot be returned against`);
  }

  const items = await getSaleItems(tx, sale.id);
  const { lines, refund_cents, completes_sale } = planLines(sale, items, input.items);

  const ageDays = (Date.now() - new Date(sale.created_at).getTime()) / 86_400_000;
  const window_closed = kind === 'RETURN' && ageDays > settings.return_window_days;
  const requires_manager = refund_cents > settings.refund_approval_threshold_cents;

  return {
    sale,
    items,
    lines,
    refund_cents,
    refund_method: input.refund_method ?? sale.payment_method,
    completes_sale,
    requires_manager,
    window_closed,
  };
}

function blockedReason(plan: ReturnPlan, actor: AuthUser, currency: string): string | null {
  if (plan.window_closed && actor.role !== 'OWNER') {
    return 'The return window for this receipt has closed; only an owner can override it';
  }
  if (plan.requires_manager && actor.role === 'CASHIER') {
    return `Refunds above ${formatMoney(plan.refund_cents, currency)} must be processed by a manager or owner`;
  }
  return null;
}

export interface ReturnQuote {
  sale: Sale;
  lines: Array<{ sale_item_id: number; name: string; quantity: number; restock: boolean; condition: string; refund: number }>;
  refund: number;
  refund_method: PaymentMethod;
  completes_sale: boolean;
  requires_manager: boolean;
  window_closed: boolean;
  /** Whether the signed-in user may process exactly this return right now. */
  allowed: boolean;
  blocked_reason: string | null;
}

/** Dry run: what would this return refund, and may the signed-in user do it? Writes nothing. */
export async function quoteReturn(input: ReturnCreate, actor: AuthUser): Promise<ReturnQuote> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const plan = await buildPlan(client, input, 'RETURN');
    const settings = await getSettings(client);
    const blocked = blockedReason(plan, actor, settings.currency);
    return {
      sale: serializeSale(plan.sale, plan.items),
      lines: plan.lines.map((l) => ({
        sale_item_id: l.item.id,
        name: l.item.product_name,
        quantity: l.quantity,
        restock: l.restock,
        condition: l.condition,
        refund: fromCents(l.refund_cents),
      })),
      refund: fromCents(plan.refund_cents),
      refund_method: plan.refund_method,
      completes_sale: plan.completes_sale,
      requires_manager: plan.requires_manager,
      window_closed: plan.window_closed,
      allowed: blocked === null,
      blocked_reason: blocked,
    };
  } finally {
    // Always roll back: a quote must never leave a trace or hold the sale lock.
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function persist(
  tx: Queryable,
  plan: ReturnPlan,
  input: ReturnCreate,
  actor: AuthUser,
  kind: 'RETURN' | 'VOID',
): Promise<number> {
  const number = await nextDocumentNumber(tx, 'RET');
  const created = (await row<{ id: number }>(
    tx,
    `INSERT INTO returns (return_number, sale_id, kind, refund_cents, refund_method, reason, processed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [number, plan.sale.id, kind, plan.refund_cents, plan.refund_method, input.reason ?? null, actor.id],
  ))!;

  for (const l of plan.lines) {
    await tx.query(
      `INSERT INTO return_items (return_id, sale_item_id, product_id, product_name, quantity, unit_price_cents, refund_cents, restock, condition)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        created.id,
        l.item.id,
        l.item.product_id,
        l.item.product_name,
        l.quantity,
        l.item.unit_price_cents,
        l.refund_cents,
        l.restock,
        l.condition,
      ],
    );

    if (l.restock) {
      const product = await requireProductRowById(tx, l.item.product_id, true);
      const after = await applyStockDelta(tx, product, l.quantity);
      await recordMovement(tx, {
        product_id: product.id,
        type: 'RETURN',
        quantity_change: l.quantity,
        quantity_before: product.stock_quantity,
        quantity_after: after,
        reference_id: number,
        reason: `${kind === 'VOID' ? 'Voided sale' : 'Customer return'} #${plan.sale.receipt_number} (${l.condition.toLowerCase()})`,
        customer_name: plan.sale.customer_name,
        customer_phone: plan.sale.customer_phone,
        payment_method: plan.refund_method,
        sale_id: plan.sale.id,
        user_id: actor.id,
      });
    }
  }

  const status: SaleStatus = kind === 'VOID' ? 'VOIDED' : plan.completes_sale ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  await tx.query('UPDATE sales SET status = $1 WHERE id = $2', [status, plan.sale.id]);

  return created.id;
}

/** Customer return against a receipt. Cashiers are limited by the approval threshold and the return window. */
export async function processReturn(input: ReturnCreate, actor: AuthUser): Promise<ReturnRecord> {
  return withTransaction(async (tx) => {
    const plan = await buildPlan(tx, input, 'RETURN');
    const settings = await getSettings(tx);
    const blocked = blockedReason(plan, actor, settings.currency);
    if (blocked) {
      throw new AppError(403, plan.window_closed ? 'RETURN_WINDOW_CLOSED' : 'APPROVAL_REQUIRED', blocked, {
        refund: fromCents(plan.refund_cents),
        threshold: fromCents(settings.refund_approval_threshold_cents),
      });
    }
    const id = await persist(tx, plan, input, actor, 'RETURN');
    return getReturn(id, tx);
  });
}

/**
 * Void: reverse a whole receipt as if it never happened. Manager or owner
 * only (enforced by the route), same day, and only if nothing has been
 * returned against it yet. Everything goes back on the shelf.
 */
export async function voidSale(saleId: number, reason: string, actor: AuthUser): Promise<ReturnRecord> {
  return withTransaction(async (tx) => {
    const sale = await lockSale(tx, { sale_id: saleId });
    if (sale.status === 'VOIDED') throw conflict('SALE_VOIDED', `Receipt ${sale.receipt_number} is already voided`);
    if (sale.refunded_cents > 0) {
      throw conflict(
        'SALE_HAS_RETURNS',
        `Receipt ${sale.receipt_number} already has a return; refund the rest instead of voiding`,
      );
    }
    const ageHours = (Date.now() - new Date(sale.created_at).getTime()) / 3_600_000;
    if (ageHours > VOID_WINDOW_HOURS) {
      throw conflict(
        'VOID_WINDOW_CLOSED',
        `Sales can only be voided within ${VOID_WINDOW_HOURS} hours; process a return instead`,
      );
    }

    const items = await getSaleItems(tx, sale.id);
    const input: ReturnCreate = {
      sale_id: sale.id,
      reason,
      items: items.map((i) => ({ sale_item_id: i.id, quantity: i.quantity, restock: true, condition: 'RESALABLE' })),
    };
    const plan = await buildPlan(tx, input, 'VOID');
    const id = await persist(tx, plan, input, actor, 'VOID');
    return getReturn(id, tx);
  });
}
