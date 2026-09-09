import { getPool, row, rows, withTransaction } from '../db';
import type { Queryable } from '../db';
import { badRequest, conflict, notFound } from '../lib/errors';
import { applyBps, bpsToPercent, formatMoney, fromCents, toCents } from '../lib/money';
import type { CheckoutInput } from '../schemas';
import type { AuthUser, Pagination, ProductRow, Sale, SaleItem, SaleItemRow, SaleRow } from '../types';
import { applyStockDelta } from './inventory.service';
import { recordMovement } from './ledger';
import { findProductRowByBarcode, findProductRowById, requireProductRowById } from './products.service';
import { getSettings } from './settings.service';

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

const SALE_SELECT = `
  SELECT s.*,
         u.display_name AS cashier_name,
         (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS item_count,
         (SELECT COALESCE(SUM(r.refund_cents), 0) FROM returns r WHERE r.sale_id = s.id) AS refunded_cents
  FROM sales s
  LEFT JOIN users u ON u.id = s.cashier_id
`;

const SALE_ITEMS_SELECT = `
  SELECT si.*, p.unit, d.name AS department_name,
         (SELECT COALESCE(SUM(ri.quantity), 0) FROM return_items ri WHERE ri.sale_item_id = si.id)::int AS returned_quantity
  FROM sale_items si
  LEFT JOIN products p ON p.id = si.product_id
  LEFT JOIN departments d ON d.id = p.department_id
  WHERE si.sale_id = $1
  ORDER BY si.id ASC
`;

function serializeItem(r: SaleItemRow): SaleItem {
  return {
    id: r.id,
    product_id: r.product_id,
    name: r.product_name,
    barcode: r.barcode,
    quantity: r.quantity,
    returned_quantity: r.returned_quantity ?? 0,
    unit_price: fromCents(r.unit_price_cents),
    total_price: fromCents(r.total_price_cents),
    unit: r.unit,
    department_name: r.department_name,
  };
}

export function serializeSale(r: SaleRow, items?: SaleItemRow[]): Sale {
  return {
    id: r.id,
    receipt_number: r.receipt_number,
    subtotal: fromCents(r.subtotal_cents),
    tax_rate: bpsToPercent(r.tax_rate_bps),
    tax_amount: fromCents(r.tax_cents),
    discount: fromCents(r.discount_cents),
    total: fromCents(r.total_cents),
    payment_method: r.payment_method,
    amount_paid: fromCents(r.amount_paid_cents),
    change_due: fromCents(r.change_due_cents),
    customer_name: r.customer_name,
    customer_phone: r.customer_phone,
    status: r.status,
    cashier_id: r.cashier_id,
    cashier_name: r.cashier_name ?? null,
    refunded_total: fromCents(r.refunded_cents ?? 0),
    created_at: r.created_at,
    ...(r.item_count !== undefined ? { item_count: r.item_count } : {}),
    ...(items ? { items: items.map(serializeItem) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getSaleItems(db: Queryable, saleId: number): Promise<SaleItemRow[]> {
  return rows<SaleItemRow>(db, SALE_ITEMS_SELECT, [saleId]);
}

export async function getSale(id: number, db: Queryable = getPool()): Promise<Sale> {
  const sale = await row<SaleRow>(db, `${SALE_SELECT} WHERE s.id = $1`, [id]);
  if (!sale) throw notFound(`Sale ${id} not found`);
  return serializeSale(sale, await getSaleItems(db, id));
}

/** Receipt lookup for returns: what the customer hands over at the counter. */
export async function getSaleByReceipt(receiptNumber: string, db: Queryable = getPool()): Promise<Sale> {
  const sale = await row<SaleRow>(db, `${SALE_SELECT} WHERE s.receipt_number = $1`, [receiptNumber.trim().toUpperCase()]);
  if (!sale) throw notFound(`Receipt ${receiptNumber} not found`);
  return serializeSale(sale, await getSaleItems(db, sale.id));
}

export async function listSales(limit: number, offset: number): Promise<{ data: Sale[]; pagination: Pagination }> {
  const db = getPool();
  const list = await rows<SaleRow>(db, `${SALE_SELECT} ORDER BY s.created_at DESC, s.id DESC LIMIT $1 OFFSET $2`, [
    limit,
    offset,
  ]);
  const { total } = (await row<{ total: number }>(db, 'SELECT COUNT(*) AS total FROM sales'))!;
  return { data: list.map((r) => serializeSale(r)), pagination: { total, limit, offset } };
}

// ---------------------------------------------------------------------------
// Numbering: REC-YYYYMMDD-0001 / RET-YYYYMMDD-0001, gap-free per day. The
// UPSERT takes a row lock on the day's counter, so concurrent writers serialise.
// ---------------------------------------------------------------------------

export async function nextDocumentNumber(tx: Queryable, prefix: 'REC' | 'RET'): Promise<string> {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const { value } = (await row<{ value: number }>(
    tx,
    `INSERT INTO sequences (name, value) VALUES ($1, 1)
     ON CONFLICT (name) DO UPDATE SET value = sequences.value + 1
     RETURNING value`,
    [`${prefix.toLowerCase()}:${day}`],
  ))!;
  return `${prefix}-${day}-${String(value).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

interface Line {
  product: ProductRow;
  quantity: number;
}

/**
 * The server is the only authority on money. Client-supplied prices and
 * totals are ignored; everything is recomputed from the product catalogue
 * and the configured tax rate, in integer cents, inside one transaction
 * that holds row locks on every product sold. The signed-in cashier is
 * recorded on the sale and on each ledger row.
 */
export async function checkout(input: CheckoutInput, cashier: AuthUser): Promise<Sale> {
  const discountCents = toCents(input.discount);

  return withTransaction(async (tx) => {
    const settings = await getSettings(tx);
    const currency = settings.currency;

    // 1. Resolve products (unlocked) and merge duplicate lines.
    const merged = new Map<number, number>();
    for (const item of input.items) {
      const found =
        item.product_id !== undefined
          ? await findProductRowById(tx, item.product_id)
          : await findProductRowByBarcode(tx, item.barcode as string);
      if (!found) throw notFound(`Product not found: ${item.product_id ?? item.barcode}`);
      merged.set(found.id, (merged.get(found.id) ?? 0) + item.quantity);
    }

    // 2. Lock the rows in a fixed order (prevents deadlocks between two
    //    concurrent checkouts) and verify stock against the merged quantities.
    const lines: Line[] = [];
    for (const id of [...merged.keys()].sort((a, b) => a - b)) {
      const product = await requireProductRowById(tx, id, true);
      const quantity = merged.get(id)!;
      if (product.stock_quantity < quantity) {
        throw conflict(
          'INSUFFICIENT_STOCK',
          `Insufficient stock for "${product.name}". Available: ${product.stock_quantity}, requested: ${quantity}`,
          { product_id: product.id, available: product.stock_quantity, requested: quantity },
        );
      }
      lines.push({ product, quantity });
    }

    // 3. Compute money in cents.
    const subtotal = lines.reduce((sum, l) => sum + l.product.price_cents * l.quantity, 0);
    if (discountCents > subtotal) {
      throw badRequest(`Discount (${formatMoney(discountCents, currency)}) cannot exceed the subtotal`);
    }
    const taxable = subtotal - discountCents;
    const tax = applyBps(taxable, settings.tax_rate_bps);
    const total = taxable + tax;

    if (input.expected_total !== undefined) {
      const expected = toCents(input.expected_total);
      if (expected !== total) {
        throw conflict(
          'PRICE_CHANGED',
          `The order total is ${formatMoney(total, currency)} but the register showed ${formatMoney(expected, currency)}. A price or the tax rate changed. Refresh and confirm the new total with the customer.`,
          { server_total: fromCents(total), client_total: fromCents(expected) },
        );
      }
    }

    // 4. Payment.
    let paid: number;
    if (input.payment_method === 'CASH') {
      if (input.amount_paid === undefined) {
        throw badRequest('amount_paid is required for cash payments');
      }
      paid = toCents(input.amount_paid);
      if (paid < total) {
        throw badRequest(
          `Insufficient payment: received ${formatMoney(paid, currency)}, required ${formatMoney(total, currency)}`,
          { received: fromCents(paid), required: fromCents(total) },
        );
      }
    } else {
      paid = total;
    }
    const change = paid - total;

    // 5. Persist.
    const receipt = await nextDocumentNumber(tx, 'REC');
    const customerName = input.customer_name || 'Walk-in Customer';
    const customerPhone = input.customer_phone ?? null;

    const sale = (await row<{ id: number }>(
      tx,
      `INSERT INTO sales (
         receipt_number, subtotal_cents, tax_rate_bps, tax_cents, discount_cents, total_cents,
         payment_method, amount_paid_cents, change_due_cents, customer_name, customer_phone, cashier_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        receipt,
        subtotal,
        settings.tax_rate_bps,
        tax,
        discountCents,
        total,
        input.payment_method,
        paid,
        change,
        customerName,
        customerPhone,
        cashier.id,
      ],
    ))!;

    for (const l of lines) {
      await tx.query(
        `INSERT INTO sale_items (sale_id, product_id, product_name, barcode, quantity, unit_price_cents, total_price_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          sale.id,
          l.product.id,
          l.product.name,
          l.product.barcode,
          l.quantity,
          l.product.price_cents,
          l.product.price_cents * l.quantity,
        ],
      );
      const after = await applyStockDelta(tx, l.product, -l.quantity);
      await recordMovement(tx, {
        product_id: l.product.id,
        type: 'SALE',
        quantity_change: -l.quantity,
        quantity_before: l.product.stock_quantity,
        quantity_after: after,
        reference_id: receipt,
        reason: `POS Sale #${receipt}`,
        customer_name: customerName,
        customer_phone: customerPhone,
        payment_method: input.payment_method,
        sale_id: sale.id,
        user_id: cashier.id,
      });
    }

    return getSale(sale.id, tx);
  });
}
