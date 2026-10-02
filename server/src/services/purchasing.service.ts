import { currentDb, row, rows, withTransaction } from '../db';
import { badRequest, conflict, notFound } from '../lib/errors';
import { fromCents, toCents } from '../lib/money';
import type { PurchaseOrderCreate, PurchaseOrderReceive, SupplierCreate, SupplierUpdate } from '../schemas';
import type { AuthUser } from '../types';
import { applyStockDelta } from './inventory.service';
import { recordMovement } from './ledger';
import { requireProductRowById } from './products.service';
import { nextDocumentNumber } from './sales.service';

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export interface Supplier {
  id: number;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  created_at: string;
}

function duplicateName(err: unknown): never {
  if ((err as { code?: string }).code === '23505') {
    throw conflict('DUPLICATE_SUPPLIER', 'A supplier with that name already exists');
  }
  throw err;
}

export async function listSuppliers(): Promise<Supplier[]> {
  return rows<Supplier>(currentDb(), 'SELECT * FROM suppliers ORDER BY name');
}

export async function createSupplier(input: SupplierCreate): Promise<Supplier> {
  try {
    return (await row<Supplier>(
      currentDb(),
      `INSERT INTO suppliers (name, contact_name, phone, email, notes) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [input.name, input.contact_name ?? null, input.phone ?? null, input.email ?? null, input.notes ?? null],
    ))!;
  } catch (err) {
    duplicateName(err);
  }
}

export async function updateSupplier(id: number, input: SupplierUpdate): Promise<Supplier> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of ['name', 'contact_name', 'phone', 'email', 'notes'] as const) {
    if (input[key] !== undefined) {
      values.push(input[key]);
      sets.push(`${key} = $${values.length}`);
    }
  }
  if (sets.length === 0) {
    const found = await row<Supplier>(currentDb(), 'SELECT * FROM suppliers WHERE id = $1', [id]);
    if (!found) throw notFound('Supplier not found');
    return found;
  }
  values.push(id);
  try {
    const updated = await row<Supplier>(
      currentDb(),
      `UPDATE suppliers SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    if (!updated) throw notFound('Supplier not found');
    return updated;
  } catch (err) {
    duplicateName(err);
  }
}

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

export interface PurchaseOrderLine {
  id: number;
  product_id: number;
  product_name: string;
  barcode: string;
  quantity: number;
  received_quantity: number;
  unit_cost: number;
}

export interface PurchaseOrder {
  id: number;
  po_number: string;
  supplier_id: number;
  supplier_name: string;
  status: 'ORDERED' | 'RECEIVED' | 'CANCELLED';
  notes: string | null;
  created_by_name: string | null;
  created_at: string;
  received_at: string | null;
  item_count: number;
  total_cost: number;
  items?: PurchaseOrderLine[];
}

const PO_SELECT = `
  SELECT po.*, s.name AS supplier_name, u.display_name AS created_by_name,
         (SELECT COALESCE(SUM(i.quantity), 0)::int FROM purchase_order_items i WHERE i.po_id = po.id) AS item_count,
         (SELECT COALESCE(SUM(i.quantity * i.unit_cost_cents), 0) FROM purchase_order_items i WHERE i.po_id = po.id)
           AS total_cost_cents
  FROM purchase_orders po
  JOIN suppliers s ON s.id = po.supplier_id
  LEFT JOIN users u ON u.id = po.created_by
`;

type PoRow = Omit<PurchaseOrder, 'total_cost' | 'items'> & { total_cost_cents: number };

const serializePo = ({ total_cost_cents, ...r }: PoRow): PurchaseOrder => ({
  ...r,
  total_cost: fromCents(total_cost_cents),
});

export async function listPurchaseOrders(): Promise<PurchaseOrder[]> {
  return (await rows<PoRow>(currentDb(), `${PO_SELECT} ORDER BY po.id DESC LIMIT 100`)).map(serializePo);
}

export async function getPurchaseOrder(id: number, db = currentDb()): Promise<PurchaseOrder> {
  const po = await row<PoRow>(db, `${PO_SELECT} WHERE po.id = $1`, [id]);
  if (!po) throw notFound('Purchase order not found');
  const items = await rows<{
    id: number;
    product_id: number;
    product_name: string;
    barcode: string;
    quantity: number;
    received_quantity: number;
    unit_cost_cents: number;
  }>(
    db,
    `SELECT i.id, i.product_id, p.name AS product_name, p.barcode, i.quantity, i.received_quantity, i.unit_cost_cents
     FROM purchase_order_items i JOIN products p ON p.id = i.product_id
     WHERE i.po_id = $1 ORDER BY i.id`,
    [id],
  );
  return {
    ...serializePo(po),
    items: items.map(({ unit_cost_cents, ...i }) => ({ ...i, unit_cost: fromCents(unit_cost_cents) })),
  };
}

export async function createPurchaseOrder(input: PurchaseOrderCreate, user: AuthUser): Promise<PurchaseOrder> {
  return withTransaction(async (tx) => {
    const supplier = await row(tx, 'SELECT id FROM suppliers WHERE id = $1', [input.supplier_id]);
    if (!supplier) throw notFound('Supplier not found');
    const number = await nextDocumentNumber(tx, 'PO');
    const po = (await row<{ id: number }>(
      tx,
      'INSERT INTO purchase_orders (po_number, supplier_id, notes, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
      [number, input.supplier_id, input.notes ?? null, user.id],
    ))!;
    for (const item of input.items) {
      await requireProductRowById(tx, item.product_id);
      await tx.query(
        'INSERT INTO purchase_order_items (po_id, product_id, quantity, unit_cost_cents) VALUES ($1, $2, $3, $4)',
        [po.id, item.product_id, item.quantity, toCents(item.unit_cost)],
      );
    }
    return getPurchaseOrder(po.id, tx);
  });
}

/**
 * Book delivered goods into stock. Omitting items receives everything still
 * outstanding. Each line becomes a RESTOCK movement, and the product's cost
 * price follows the latest cost paid.
 */
export async function receivePurchaseOrder(
  id: number,
  input: PurchaseOrderReceive,
  user: AuthUser,
): Promise<PurchaseOrder> {
  return withTransaction(async (tx) => {
    const po = await row<{ id: number; po_number: string; status: string }>(
      tx,
      'SELECT id, po_number, status FROM purchase_orders WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (!po) throw notFound('Purchase order not found');
    if (po.status !== 'ORDERED') throw conflict('PO_CLOSED', `${po.po_number} is ${po.status.toLowerCase()}`);

    const lines = await rows<{ id: number; product_id: number; quantity: number; received_quantity: number; unit_cost_cents: number }>(
      tx,
      'SELECT * FROM purchase_order_items WHERE po_id = $1 ORDER BY product_id FOR UPDATE',
      [id],
    );
    const wanted = new Map<number, number>();
    if (input.items && input.items.length > 0) {
      for (const r of input.items) wanted.set(r.item_id, (wanted.get(r.item_id) ?? 0) + r.quantity);
      for (const itemId of wanted.keys()) {
        if (!lines.some((l) => l.id === itemId)) throw badRequest(`Line ${itemId} is not on ${po.po_number}`);
      }
    } else {
      for (const l of lines) wanted.set(l.id, l.quantity - l.received_quantity);
    }

    for (const l of lines) {
      const qty = wanted.get(l.id) ?? 0;
      if (qty <= 0) continue;
      const outstanding = l.quantity - l.received_quantity;
      if (qty > outstanding) {
        throw badRequest(`Only ${outstanding} still to receive on one of the lines`);
      }
      const product = await requireProductRowById(tx, l.product_id, true);
      const after = await applyStockDelta(tx, product, qty);
      await recordMovement(tx, {
        product_id: product.id,
        type: 'RESTOCK',
        quantity_change: qty,
        quantity_before: product.stock_quantity,
        quantity_after: after,
        reference_id: po.po_number,
        reason: `Received on ${po.po_number}`,
        user_id: user.id,
      });
      await tx.query('UPDATE products SET cost_price_cents = $1, updated_at = now() WHERE id = $2', [
        l.unit_cost_cents,
        product.id,
      ]);
      await tx.query('UPDATE purchase_order_items SET received_quantity = received_quantity + $1 WHERE id = $2', [
        qty,
        l.id,
      ]);
    }

    const left = (await row<{ n: number }>(
      tx,
      'SELECT COUNT(*)::int AS n FROM purchase_order_items WHERE po_id = $1 AND received_quantity < quantity',
      [id],
    ))!;
    if (left.n === 0) {
      await tx.query("UPDATE purchase_orders SET status = 'RECEIVED', received_at = now() WHERE id = $1", [id]);
    }
    return getPurchaseOrder(id, tx);
  });
}

export async function cancelPurchaseOrder(id: number): Promise<PurchaseOrder> {
  const done = await row(
    currentDb(),
    "UPDATE purchase_orders SET status = 'CANCELLED' WHERE id = $1 AND status = 'ORDERED' RETURNING id",
    [id],
  );
  if (!done) throw conflict('PO_CLOSED', 'Only an open purchase order can be cancelled');
  return getPurchaseOrder(id);
}

/** Active products at or below their low-stock level, with a suggested order and their last supplier. */
export async function reorderSuggestions() {
  const list = await rows<{
    id: number;
    name: string;
    barcode: string;
    stock_quantity: number;
    min_stock_level: number;
    cost_price_cents: number;
    last_supplier_id: number | null;
  }>(
    currentDb(),
    `SELECT p.id, p.name, p.barcode, p.stock_quantity, p.min_stock_level, p.cost_price_cents,
            (SELECT po.supplier_id FROM purchase_order_items i JOIN purchase_orders po ON po.id = i.po_id
             WHERE i.product_id = p.id ORDER BY po.id DESC LIMIT 1) AS last_supplier_id
     FROM products p
     WHERE p.is_active AND p.stock_quantity <= p.min_stock_level
     ORDER BY p.stock_quantity - p.min_stock_level, p.name
     LIMIT 200`,
  );
  return list.map(({ cost_price_cents, ...p }) => ({
    ...p,
    cost_price: fromCents(cost_price_cents),
    suggested_quantity: Math.max(p.min_stock_level * 2 - p.stock_quantity, 1),
  }));
}
