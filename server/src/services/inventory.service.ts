import { row, rows, withTransaction } from '../db';
import type { Queryable } from '../db';
import { conflict } from '../lib/errors';
import { toCents } from '../lib/money';
import type { ScanAdjust, SetCount } from '../schemas';
import type { AuthUser, Department, Product, ProductRow, StockMovement } from '../types';
import { recordMovement, serializeMovement } from './ledger';
import { getProduct, requireProductRowByBarcode } from './products.service';

/**
 * Apply a signed stock delta to a product row that was read FOR UPDATE inside
 * the current transaction. Refuses to go below zero. Returns the new balance.
 * Callers MUST pair this with recordMovement().
 */
export async function applyStockDelta(tx: Queryable, product: ProductRow, delta: number): Promise<number> {
  const after = product.stock_quantity + delta;
  if (after < 0) {
    throw conflict(
      'INSUFFICIENT_STOCK',
      `Cannot reduce stock of "${product.name}" below zero. Current stock is ${product.stock_quantity}, attempted deduction is ${-delta}.`,
      { product_id: product.id, available: product.stock_quantity, requested: -delta },
    );
  }
  await tx.query('UPDATE products SET stock_quantity = $1, updated_at = now() WHERE id = $2', [after, product.id]);
  return after;
}

export interface AdjustResult {
  product: Product;
  movement: StockMovement | null;
  message?: string;
}

/** Barcode-driven stock in / stock out (restock, return, write-off). */
export async function adjustStockByBarcode(input: ScanAdjust, by: AuthUser): Promise<AdjustResult> {
  const delta =
    input.type === 'ADJUSTMENT_REMOVE' ? -Math.abs(input.change_quantity) : Math.abs(input.change_quantity);

  const defaultReason =
    input.type === 'RESTOCK'
      ? 'Restock shipment received'
      : input.type === 'RETURN'
        ? 'Customer return to stock'
        : input.type === 'ADJUSTMENT_REMOVE'
          ? 'Inventory reduction / write-off'
          : 'Stock adjustment';

  return withTransaction(async (tx) => {
    const product = await requireProductRowByBarcode(tx, input.barcode, true);
    const after = await applyStockDelta(tx, product, delta);
    const movement = await recordMovement(tx, {
      product_id: product.id,
      type: input.type,
      quantity_change: delta,
      quantity_before: product.stock_quantity,
      quantity_after: after,
      reference_id: input.reference_id ?? (delta > 0 ? 'SCAN-IN' : 'SCAN-OUT'),
      reason: input.reason ?? defaultReason,
      user_id: by.id,
    });
    return { product: await getProduct(product.id, tx), movement: serializeMovement(movement) };
  });
}

/** Physical cycle count: set the absolute quantity and log the variance. */
export async function setPhysicalCount(input: SetCount, by: AuthUser): Promise<AdjustResult> {
  return withTransaction(async (tx) => {
    const product = await requireProductRowByBarcode(tx, input.barcode, true);
    const delta = input.actual_count - product.stock_quantity;

    if (delta === 0) {
      return {
        product: await getProduct(product.id, tx),
        movement: null,
        message: 'Stock already matches physical count',
      };
    }

    const after = await applyStockDelta(tx, product, delta);
    const movement = await recordMovement(tx, {
      product_id: product.id,
      type: delta > 0 ? 'ADJUSTMENT_ADD' : 'ADJUSTMENT_REMOVE',
      quantity_change: delta,
      quantity_before: product.stock_quantity,
      quantity_after: after,
      reference_id: 'STOCK-AUDIT',
      reason: input.reason ?? 'Physical cycle count adjustment',
      user_id: by.id,
    });
    return { product: await getProduct(product.id, tx), movement: serializeMovement(movement) };
  });
}

// ---------------------------------------------------------------------------
// Spreadsheet import
// ---------------------------------------------------------------------------

export interface ImportResult {
  inserted_count: number;
  updated_count: number;
  created_departments: Department[];
  skipped: Array<{ row: number; reason: string }>;
  total_processed: number;
}

const PRESET_COLORS = ['#0ea5e9', '#10b981', '#6366f1', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#f43f5e'];

function text(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

function decimal(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

function integer(v: unknown): number | undefined {
  const n = decimal(v);
  return n === undefined ? undefined : Math.trunc(n);
}

interface NormalisedRow {
  name: string;
  barcode: string;
  department: string;
  price_cents: number;
  cost_price_cents: number;
  stock_quantity: number;
  min_stock_level: number;
  unit: string;
  sku: string | null;
}

function normaliseRow(raw: Record<string, unknown>): NormalisedRow | string {
  const name = text(raw.name ?? raw.product_name ?? raw.product);
  const barcode = text(raw.barcode ?? raw.upc ?? raw.ean);
  if (!name) return 'missing name';
  if (!barcode) return 'missing barcode';

  const price = decimal(raw.price ?? raw.retail_price ?? raw.selling_price);
  if (price === undefined || price < 0) return 'missing or invalid price';

  const cost = decimal(raw.cost_price ?? raw.cost) ?? 0;
  const stock = integer(raw.stock_quantity ?? raw.stock ?? raw.qty ?? raw.quantity) ?? 0;
  const minStock = integer(raw.min_stock_level ?? raw.min_stock ?? raw.reorder_level) ?? 5;
  if (stock < 0) return 'negative stock quantity';

  return {
    name,
    barcode,
    department: text(raw.department ?? raw.category) || 'General',
    price_cents: toCents(price),
    cost_price_cents: toCents(Math.max(0, cost)),
    stock_quantity: stock,
    min_stock_level: Math.max(0, minStock),
    unit: text(raw.unit) || 'pcs',
    sku: text(raw.sku) || null,
  };
}

/**
 * Bulk upsert by barcode. Existing products are updated from the sheet and
 * their stock is INCREASED by the sheet quantity (treated as a delivery).
 * Unknown departments are auto-created. The whole batch is one transaction;
 * rows that cannot be parsed are skipped and reported, not silently dropped.
 */
export async function importProductsBatch(items: Record<string, unknown>[], by: AuthUser): Promise<ImportResult> {
  return withTransaction(async (tx) => {
    const depts = await rows<{ id: number; name: string; code: string }>(tx, 'SELECT id, name, code FROM departments');
    const deptByName = new Map(depts.map((d) => [d.name.trim().toLowerCase(), d]));
    const codes = new Set(depts.map((d) => d.code.toUpperCase()));

    const result: ImportResult = {
      inserted_count: 0,
      updated_count: 0,
      created_departments: [],
      skipped: [],
      total_processed: 0,
    };

    for (let index = 0; index < items.length; index++) {
      const parsed = normaliseRow(items[index]);
      if (typeof parsed === 'string') {
        result.skipped.push({ row: index + 1, reason: parsed });
        continue;
      }

      let dept = deptByName.get(parsed.department.toLowerCase());
      if (!dept) {
        let base = parsed.department.replace(/[^a-zA-Z]/g, '').substring(0, 4).toUpperCase();
        if (base.length < 2) base = 'DEPT';
        let code = base;
        let n = 1;
        while (codes.has(code)) code = `${base.substring(0, 3)}${n++}`;
        codes.add(code);

        const created = await row<Department>(
          tx,
          'INSERT INTO departments (name, code, description, color) VALUES ($1, $2, $3, $4) RETURNING *',
          [parsed.department, code, 'Auto-created from spreadsheet import', PRESET_COLORS[index % PRESET_COLORS.length]],
        );
        dept = { id: created!.id, name: created!.name, code: created!.code };
        deptByName.set(parsed.department.toLowerCase(), dept);
        result.created_departments.push(created!);
      }

      const existing = await row<ProductRow>(tx, 'SELECT * FROM products WHERE barcode = $1 FOR UPDATE', [parsed.barcode]);

      if (existing) {
        const newStock = existing.stock_quantity + parsed.stock_quantity;
        await tx.query(
          `UPDATE products SET name = $1, department_id = $2, price_cents = $3, cost_price_cents = $4,
             stock_quantity = $5, min_stock_level = $6, unit = $7, sku = COALESCE($8, sku), updated_at = now()
           WHERE id = $9`,
          [
            parsed.name,
            dept.id,
            parsed.price_cents,
            parsed.cost_price_cents,
            newStock,
            parsed.min_stock_level,
            parsed.unit,
            parsed.sku,
            existing.id,
          ],
        );
        if (parsed.stock_quantity > 0) {
          await recordMovement(tx, {
            product_id: existing.id,
            type: 'RESTOCK',
            quantity_change: parsed.stock_quantity,
            quantity_before: existing.stock_quantity,
            quantity_after: newStock,
            reference_id: 'SHEET-IMPORT',
            reason: 'Restock imported from spreadsheet',
            user_id: by.id,
          });
        }
        result.updated_count++;
      } else {
        const inserted = await row<{ id: number }>(
          tx,
          `INSERT INTO products (barcode, sku, name, department_id, price_cents, cost_price_cents,
                                 stock_quantity, min_stock_level, unit)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [
            parsed.barcode,
            parsed.sku,
            parsed.name,
            dept.id,
            parsed.price_cents,
            parsed.cost_price_cents,
            parsed.stock_quantity,
            parsed.min_stock_level,
            parsed.unit,
          ],
        );
        if (parsed.stock_quantity > 0) {
          await recordMovement(tx, {
            product_id: inserted!.id,
            type: 'INITIAL',
            quantity_change: parsed.stock_quantity,
            quantity_before: 0,
            quantity_after: parsed.stock_quantity,
            reference_id: 'SHEET-IMPORT',
            reason: 'Initial stock from spreadsheet import',
            user_id: by.id,
          });
        }
        result.inserted_count++;
      }
    }

    result.total_processed = result.inserted_count + result.updated_count;
    return result;
  });
}
