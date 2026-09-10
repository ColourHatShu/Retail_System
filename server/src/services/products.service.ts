import { getPool, row, rows, withTransaction } from '../db';
import type { Queryable } from '../db';
import { badRequest, notFound } from '../lib/errors';
import { fromCents, toCents } from '../lib/money';
import type { ProductCreate, ProductListQuery, ProductUpdate } from '../schemas';
import type { AuthUser, Product, ProductRow } from '../types';
import { recordMovement } from './ledger';

export const PRODUCT_SELECT = `
  SELECT p.*, d.name AS department_name, d.code AS department_code, d.color AS department_color
  FROM products p
  JOIN departments d ON d.id = p.department_id
`;

export function serializeProduct(r: ProductRow): Product {
  return {
    id: r.id,
    barcode: r.barcode,
    sku: r.sku,
    name: r.name,
    department_id: r.department_id,
    department_name: r.department_name,
    department_code: r.department_code,
    department_color: r.department_color,
    price: fromCents(r.price_cents),
    cost_price: fromCents(r.cost_price_cents),
    stock_quantity: r.stock_quantity,
    min_stock_level: r.min_stock_level,
    unit: r.unit,
    image_url: r.image_url,
    is_active: r.is_active,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** `lock` takes a FOR UPDATE row lock; only meaningful inside a transaction. */
export async function findProductRowById(db: Queryable, id: number, lock = false): Promise<ProductRow | undefined> {
  return row<ProductRow>(db, `${PRODUCT_SELECT} WHERE p.id = $1 ${lock ? 'FOR UPDATE OF p' : ''}`, [id]);
}

export async function findProductRowByBarcode(
  db: Queryable,
  barcode: string,
  lock = false,
): Promise<ProductRow | undefined> {
  return row<ProductRow>(db, `${PRODUCT_SELECT} WHERE p.barcode = $1 ${lock ? 'FOR UPDATE OF p' : ''}`, [
    barcode.trim(),
  ]);
}

export async function requireProductRowById(db: Queryable, id: number, lock = false): Promise<ProductRow> {
  const r = await findProductRowById(db, id, lock);
  if (!r) throw notFound(`Product ${id} not found`);
  return r;
}

export async function requireProductRowByBarcode(db: Queryable, barcode: string, lock = false): Promise<ProductRow> {
  const r = await findProductRowByBarcode(db, barcode, lock);
  if (!r) throw notFound(`Product with barcode "${barcode.trim()}" not found`);
  return r;
}

async function departmentExists(db: Queryable, id: number): Promise<boolean> {
  return !!(await row(db, 'SELECT 1 FROM departments WHERE id = $1', [id]));
}

export async function listProducts(q: ProductListQuery, db: Queryable = getPool()): Promise<Product[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  // Archived products stay out of the catalogue and the register by default.
  if (q.include_archived !== 'true') {
    where.push('p.is_active');
  }
  if (q.department_id !== undefined) {
    params.push(q.department_id);
    where.push(`p.department_id = $${params.length}`);
  }
  if (q.search) {
    params.push(`%${q.search}%`);
    const n = params.length;
    where.push(`(p.name ILIKE $${n} OR p.barcode ILIKE $${n} OR p.sku ILIKE $${n})`);
  }
  if (q.low_stock === 'true') {
    where.push('p.stock_quantity <= p.min_stock_level');
  }

  const sql = `${PRODUCT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.name ASC`;
  return (await rows<ProductRow>(db, sql, params)).map(serializeProduct);
}

export async function getProduct(id: number, db: Queryable = getPool()): Promise<Product> {
  return serializeProduct(await requireProductRowById(db, id));
}

export async function getProductByBarcode(barcode: string, db: Queryable = getPool()): Promise<Product> {
  return serializeProduct(await requireProductRowByBarcode(db, barcode));
}

export async function createProduct(input: ProductCreate, by: AuthUser): Promise<Product> {
  return withTransaction(async (tx) => {
    if (!(await departmentExists(tx, input.department_id))) {
      throw badRequest('Selected department does not exist');
    }

    const inserted = await row<{ id: number }>(
      tx,
      `INSERT INTO products (
         barcode, sku, name, department_id, price_cents, cost_price_cents,
         stock_quantity, min_stock_level, unit, image_url
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        input.barcode,
        input.sku ?? null,
        input.name,
        input.department_id,
        toCents(input.price),
        toCents(input.cost_price),
        input.stock_quantity,
        input.min_stock_level,
        input.unit,
        input.image_url ?? null,
      ],
    );
    const productId = inserted!.id;

    if (input.stock_quantity > 0) {
      await recordMovement(tx, {
        product_id: productId,
        type: 'INITIAL',
        quantity_change: input.stock_quantity,
        quantity_before: 0,
        quantity_after: input.stock_quantity,
        reference_id: 'INIT-CREATE',
        reason: 'Initial stock on product creation',
        user_id: by.id,
      });
    }

    return getProduct(productId, tx);
  });
}

/**
 * Partial update. Only fields present in `input` are written, and sending
 * null for sku/image_url clears them. stock_quantity is never touched here:
 * stock only moves through the inventory service so the ledger stays true.
 */
export async function updateProduct(id: number, input: ProductUpdate): Promise<Product> {
  return withTransaction(async (tx) => {
    await requireProductRowById(tx, id, true);

    if (input.department_id !== undefined && !(await departmentExists(tx, input.department_id))) {
      throw badRequest('Selected department does not exist');
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const assign = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (input.barcode !== undefined) assign('barcode', input.barcode);
    if (input.sku !== undefined) assign('sku', input.sku);
    if (input.name !== undefined) assign('name', input.name);
    if (input.department_id !== undefined) assign('department_id', input.department_id);
    if (input.price !== undefined) assign('price_cents', toCents(input.price));
    if (input.cost_price !== undefined) assign('cost_price_cents', toCents(input.cost_price));
    if (input.min_stock_level !== undefined) assign('min_stock_level', input.min_stock_level);
    if (input.unit !== undefined) assign('unit', input.unit);
    if (input.image_url !== undefined) assign('image_url', input.image_url);
    if (input.is_active !== undefined) assign('is_active', input.is_active);

    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(id);
      await tx.query(`UPDATE products SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    }

    return getProduct(id, tx);
  });
}

/**
 * Only ever removes a product with no history at all. One that appears on a sale
 * or a refund is refused by the sale_items / return_items foreign keys, surfaced
 * as 409 HAS_HISTORY, so receipts keep pointing at something real. Retire those
 * by archiving instead: PUT /api/products/:id with { is_active: false }.
 */
export async function deleteProduct(id: number): Promise<void> {
  const deleted = await row<{ id: number }>(getPool(), 'DELETE FROM products WHERE id = $1 RETURNING id', [id]);
  if (!deleted) throw notFound(`Product ${id} not found`);
}
