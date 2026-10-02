import { currentDb, row, rows, withTransaction } from '../db';
import type { Queryable } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { bpsToPercent, formatMoney, fromCents, toCents } from '../lib/money';
import { computeTax, taxLabels } from '../lib/tax';
import type { CheckoutInput } from '../schemas';
import type {
  AuthUser,
  Pagination,
  PaymentMethod,
  ProductRow,
  Sale,
  SaleItem,
  SaleItemRow,
  SaleRow,
  SaleTender,
} from '../types';
import { applyStockDelta } from './inventory.service';
import { recordMovement } from './ledger';
import { findProductRowByBarcode, findProductRowById, requireProductRowById } from './products.service';
import { getSettings, taxRates } from './settings.service';

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

const SALE_SELECT = `
  SELECT s.*,
         u.display_name AS cashier_name,
         -- Units, not lines: checkout merges repeat scans of one product into a
         -- single row, so COUNT(*) would report three bottles of cola as "1".
         (SELECT COALESCE(SUM(si.quantity), 0) FROM sale_items si WHERE si.sale_id = s.id) AS item_count,
         (SELECT COALESCE(SUM(r.refund_cents), 0) FROM returns r WHERE r.sale_id = s.id) AS refunded_cents,
         (SELECT json_agg(json_build_object('method', sp.method, 'amount_cents', sp.amount_cents) ORDER BY sp.id)
            FROM sale_payments sp WHERE sp.sale_id = s.id) AS payments
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
    tax_class: r.tax_class,
    list_price: fromCents(r.list_price_cents ?? r.unit_price_cents),
    line_discount: fromCents(r.line_discount_cents ?? 0),
    unit: r.unit,
    department_name: r.department_name,
  };
}

export function serializeSale(r: SaleRow, items?: SaleItemRow[]): Sale {
  // Receipts from before province-aware tax carry one flat rate, shown as "Tax".
  const split = r.gst_cents !== null;
  return {
    id: r.id,
    receipt_number: r.receipt_number,
    subtotal: fromCents(r.subtotal_cents),
    tax_rate: bpsToPercent(r.tax_rate_bps),
    tax_amount: fromCents(r.tax_cents),
    gst_amount: fromCents(split ? r.gst_cents! : r.tax_cents),
    pst_amount: fromCents(split ? (r.pst_cents ?? 0) : 0),
    gst_rate: bpsToPercent(split ? (r.gst_rate_bps ?? 0) : r.tax_rate_bps),
    pst_rate: bpsToPercent(split ? (r.pst_rate_bps ?? 0) : 0),
    tax_labels: split ? taxLabels(r.province, r.pst_rate_bps ?? 0) : { gst: 'Tax', pst: null },
    gst_number: r.gst_number ?? null,
    pst_number: r.pst_number ?? null,
    discount: fromCents(r.discount_cents),
    total: fromCents(r.total_cents),
    payment_method: r.payment_method,
    // Older receipts have no tender rows: one tender, cash as handed over.
    payments: r.payments?.length
      ? r.payments.map((p) => ({ method: p.method, amount: fromCents(Number(p.amount_cents)) }))
      : r.payment_method === 'SPLIT'
        ? []
        : [
            {
              method: r.payment_method,
              amount: fromCents(r.payment_method === 'CASH' ? r.amount_paid_cents : r.total_cents),
            },
          ],
    amount_paid: fromCents(r.amount_paid_cents),
    change_due: fromCents(r.change_due_cents),
    customer_name: r.customer_name,
    customer_phone: r.customer_phone,
    status: r.status,
    cashier_id: r.cashier_id,
    cashier_name: r.cashier_name ?? null,
    refunded_total: fromCents(r.refunded_cents ?? 0),
    shift_id: r.shift_id ?? null,
    customer_id: r.customer_id ?? null,
    points_earned: r.points_earned ?? 0,
    client_ref: r.client_ref ?? null,
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

export async function getSale(id: number, db: Queryable = currentDb()): Promise<Sale> {
  const sale = await row<SaleRow>(db, `${SALE_SELECT} WHERE s.id = $1`, [id]);
  if (!sale) throw notFound(`Sale ${id} not found`);
  return serializeSale(sale, await getSaleItems(db, id));
}

/** Receipt lookup for returns: what the customer hands over at the counter. */
export async function getSaleByReceipt(receiptNumber: string, db: Queryable = currentDb()): Promise<Sale> {
  const sale = await row<SaleRow>(db, `${SALE_SELECT} WHERE s.receipt_number = $1`, [receiptNumber.trim().toUpperCase()]);
  if (!sale) throw notFound(`Receipt ${receiptNumber} not found`);
  return serializeSale(sale, await getSaleItems(db, sale.id));
}

export async function listSales(limit: number, offset: number): Promise<{ data: Sale[]; pagination: Pagination }> {
  const db = currentDb();
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

/**
 * The shop's calendar day, not UTC's. West of Greenwich the evening shift is
 * already tomorrow in UTC, so a UTC day would stamp a 19:00 sale with tomorrow's
 * date and start tomorrow's counter mid-shift. en-CA renders exactly YYYY-MM-DD.
 */
function storeDay(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export async function nextDocumentNumber(tx: Queryable, prefix: 'REC' | 'RET' | 'PO'): Promise<string> {
  const { timezone } = await getSettings(tx);
  const day = storeDay(timezone).replace(/-/g, '');
  const { value } = (await row<{ value: number }>(
    tx,
    `INSERT INTO sequences (name, value) VALUES ($1, 1)
     ON CONFLICT (tenant_id, name) DO UPDATE SET value = sequences.value + 1
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
  /** Charged per unit: the catalogue price, or a manager's override. */
  unitCents: number;
  lineDiscountCents: number;
  overridden: boolean;
}

const lineCents = (l: Line) => l.unitCents * l.quantity - l.lineDiscountCents;

/**
 * The server is the only authority on money. Client-supplied totals are
 * ignored; everything is recomputed from the product catalogue (or a
 * manager's per-line override) and the configured tax, in integer cents,
 * inside one transaction that holds row locks on every product sold. The
 * signed-in cashier, the open drawer shift and the customer are recorded.
 *
 * client_ref makes a checkout idempotent: sending the same one twice returns
 * the first sale. A sale that also carries sold_at was rung up offline: it is
 * not refused for stock the shelf no longer shows (the goods already left) or
 * for a price that changed since, and it keeps the time it really happened.
 */
export async function checkout(input: CheckoutInput, cashier: AuthUser): Promise<Sale> {
  const discountCents = toCents(input.discount);
  const offline = input.client_ref !== undefined && input.sold_at !== undefined;

  return withTransaction(async (tx) => {
    if (input.client_ref !== undefined) {
      const existing = await row<{ id: number }>(tx, 'SELECT id FROM sales WHERE client_ref = $1', [input.client_ref]);
      if (existing) return getSale(existing.id, tx);
    }

    const settings = await getSettings(tx);
    const currency = settings.currency;

    // 1. Resolve products (unlocked) and merge duplicate lines.
    const merged = new Map<number, { quantity: number; override?: number; discount: number }>();
    for (const item of input.items) {
      const found =
        item.product_id !== undefined
          ? await findProductRowById(tx, item.product_id)
          : await findProductRowByBarcode(tx, item.barcode as string);
      if (!found) throw notFound(`Product not found: ${item.product_id ?? item.barcode}`);
      const prev = merged.get(found.id);
      const override = item.price_override !== undefined ? toCents(item.price_override) : undefined;
      if (prev && prev.override !== override) {
        throw badRequest(`"${found.name}" is on the order twice at different prices`);
      }
      merged.set(found.id, {
        quantity: (prev?.quantity ?? 0) + item.quantity,
        override,
        discount: (prev?.discount ?? 0) + (item.line_discount !== undefined ? toCents(item.line_discount) : 0),
      });
    }

    // 2. Lock the rows in a fixed order (prevents deadlocks between two
    //    concurrent checkouts) and verify stock against the merged quantities.
    const lines: Line[] = [];
    for (const id of [...merged.keys()].sort((a, b) => a - b)) {
      const product = await requireProductRowById(tx, id, true);
      const m = merged.get(id)!;
      if (!offline && product.stock_quantity < m.quantity) {
        throw conflict(
          'INSUFFICIENT_STOCK',
          `Insufficient stock for "${product.name}". Available: ${product.stock_quantity}, requested: ${m.quantity}`,
          { product_id: product.id, available: product.stock_quantity, requested: m.quantity },
        );
      }
      const overridden = m.override !== undefined && m.override !== product.price_cents;
      if (overridden && cashier.role === 'CASHIER') {
        throw forbidden('MANAGER_REQUIRED', `Only a manager or owner can change the price of "${product.name}"`);
      }
      const unitCents = m.override ?? product.price_cents;
      if (m.discount > unitCents * m.quantity) {
        throw badRequest(`The discount on "${product.name}" is more than the line itself`);
      }
      lines.push({ product, quantity: m.quantity, unitCents, lineDiscountCents: m.discount, overridden });
    }

    // 3. Compute money in cents.
    const subtotal = lines.reduce((sum, l) => sum + lineCents(l), 0);
    if (discountCents > subtotal) {
      throw badRequest(`Discount (${formatMoney(discountCents, currency)}) cannot exceed the subtotal`);
    }
    const rates = taxRates(settings);
    const tax = computeTax(
      lines.map((l) => ({ gross_cents: lineCents(l), tax_class: l.product.tax_class })),
      discountCents,
      rates,
    );
    const total = tax.total_cents;

    // An offline sale was already paid at the price the register showed.
    if (!offline && input.expected_total !== undefined) {
      const expected = toCents(input.expected_total);
      if (expected !== total) {
        throw conflict(
          'PRICE_CHANGED',
          `The order total is ${formatMoney(total, currency)} but the register showed ${formatMoney(expected, currency)}. A price or the tax rate changed. Refresh and confirm the new total with the customer.`,
          { server_total: fromCents(total), client_total: fromCents(expected) },
        );
      }
    }

    // 4. Payment. Card tenders are charged exactly; change only comes from cash.
    const tenders =
      input.payments ??
      [{ method: input.payment_method, amount: input.payment_method === 'CASH' ? input.amount_paid : undefined }];
    let cash = 0;
    let card = 0;
    const payments: Array<{ method: PaymentMethod; cents: number }> = [];
    for (const t of tenders) {
      if (t.method === 'CASH') {
        if (t.amount === undefined) throw badRequest('amount_paid is required for cash payments');
        const cents = toCents(t.amount);
        cash += cents;
        payments.push({ method: 'CASH', cents });
      } else {
        const cents = t.amount === undefined ? total : toCents(t.amount);
        card += cents;
        payments.push({ method: t.method, cents });
      }
    }
    if (card > total) {
      throw badRequest(
        `Card payments (${formatMoney(card, currency)}) are more than the total (${formatMoney(total, currency)})`,
      );
    }
    const paid = cash + card;
    if (paid < total) {
      throw badRequest(
        `Insufficient payment: received ${formatMoney(paid, currency)}, required ${formatMoney(total, currency)}`,
        { received: fromCents(paid), required: fromCents(total) },
      );
    }
    const change = paid - total;
    const used = new Set(payments.filter((p) => p.cents > 0).map((p) => p.method));
    const tender: SaleTender = used.size > 1 ? 'SPLIT' : ([...used][0] ?? tenders[0].method);

    // 5. Customer and loyalty.
    let customer: { id: number; name: string; phone: string | null } | null = null;
    if (input.customer_id !== undefined) {
      customer =
        (await row<{ id: number; name: string; phone: string | null }>(
          tx,
          'SELECT id, name, phone FROM customers WHERE id = $1',
          [input.customer_id],
        )) ?? null;
      if (!customer) throw notFound('Customer not found');
    }
    const points = customer ? Math.floor((total / 100) * settings.loyalty_points_per_dollar) : 0;

    // 6. Persist.
    const receipt = await nextDocumentNumber(tx, 'REC');
    const customerName = input.customer_name || customer?.name || 'Walk-in Customer';
    const customerPhone = input.customer_phone ?? customer?.phone ?? null;
    const shift = await row<{ id: number }>(tx, "SELECT id FROM shifts WHERE status = 'OPEN'");
    const soldAt = offline && input.sold_at!.getTime() < Date.now() ? input.sold_at! : new Date();

    const sale = (await row<{ id: number }>(
      tx,
      `INSERT INTO sales (
         receipt_number, subtotal_cents, tax_rate_bps, tax_cents, discount_cents, total_cents,
         payment_method, amount_paid_cents, change_due_cents, customer_name, customer_phone, cashier_id,
         gst_cents, pst_cents, gst_rate_bps, pst_rate_bps, tax_hst, province, gst_number, pst_number,
         shift_id, customer_id, points_earned, client_ref, synced_at, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
                 $21, $22, $23, $24, $25, $26)
       RETURNING id`,
      [
        receipt,
        subtotal,
        // Integer column kept for old readers; the exact rates follow below.
        Math.round(settings.tax_rate_bps),
        tax.tax_cents,
        discountCents,
        total,
        tender,
        paid,
        change,
        customerName,
        customerPhone,
        cashier.id,
        tax.gst_cents,
        tax.pst_cents,
        rates.gst_bps,
        rates.pst_bps,
        rates.hst,
        settings.province,
        settings.gst_number,
        settings.pst_number,
        shift?.id ?? null,
        customer?.id ?? null,
        points,
        input.client_ref ?? null,
        offline ? new Date() : null,
        soldAt,
      ],
    ))!;

    for (const p of payments) {
      if (p.cents <= 0) continue;
      await tx.query('INSERT INTO sale_payments (sale_id, method, amount_cents) VALUES ($1, $2, $3)', [
        sale.id,
        p.method,
        p.cents,
      ]);
    }

    for (const l of lines) {
      await tx.query(
        `INSERT INTO sale_items (sale_id, product_id, product_name, barcode, quantity, unit_price_cents, total_price_cents,
                                 tax_class, list_price_cents, line_discount_cents, cost_cents, price_override_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          sale.id,
          l.product.id,
          l.product.name,
          l.product.barcode,
          l.quantity,
          l.unitCents,
          lineCents(l),
          l.product.tax_class,
          l.product.price_cents,
          l.lineDiscountCents,
          l.product.cost_price_cents,
          l.overridden ? cashier.id : null,
        ],
      );
      const after = await applyStockDelta(tx, l.product, -l.quantity, offline);
      await recordMovement(tx, {
        product_id: l.product.id,
        type: 'SALE',
        quantity_change: -l.quantity,
        quantity_before: l.product.stock_quantity,
        quantity_after: after,
        reference_id: receipt,
        reason: offline ? `POS Sale #${receipt} (rung up offline)` : `POS Sale #${receipt}`,
        customer_name: customerName,
        customer_phone: customerPhone,
        payment_method: tender,
        sale_id: sale.id,
        user_id: cashier.id,
      });
    }

    if (customer && points > 0) {
      await tx.query('UPDATE customers SET points = points + $1, updated_at = now() WHERE id = $2', [points, customer.id]);
    }

    return getSale(sale.id, tx);
  });
}
