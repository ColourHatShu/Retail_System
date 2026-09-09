import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { bootstrapOwner, client, createTestSchema, dropTestSchema, firstDepartmentId, hasDatabase } from './helpers';

const app = createApp();
let api: ReturnType<typeof client>;
let deptId: number;
let seq = 0;

describe.skipIf(!hasDatabase)('inventory', () => {
  beforeAll(async () => {
    await createTestSchema();
    api = client(app, await bootstrapOwner(app));
    deptId = await firstDepartmentId();
  });
  afterAll(dropTestSchema);

  async function makeProduct(overrides: Record<string, unknown> = {}) {
    const res = await api
      .post('/api/products')
      .send({ barcode: `INV-${++seq}`, name: `Item ${seq}`, department_id: deptId, price: 2, stock_quantity: 10, ...overrides });
    expect(res.status).toBe(201);
    return res.body.data as { id: number; barcode: string };
  }

  describe('POST /api/inventory/scan-adjust', () => {
    it('restocks and writes a ledger row with before/after balances and the user', async () => {
      const p = await makeProduct({ stock_quantity: 10 });
      const res = await api
        .post('/api/inventory/scan-adjust')
        .send({ barcode: p.barcode, change_quantity: 5, type: 'RESTOCK' });
      expect(res.status).toBe(200);
      expect(res.body.data.product.stock_quantity).toBe(15);
      expect(res.body.data.movement).toMatchObject({
        type: 'RESTOCK',
        quantity_change: 5,
        quantity_before: 10,
        quantity_after: 15,
        reference_id: 'SCAN-IN',
      });
      expect(typeof res.body.data.movement.user_id).toBe('number');
    });

    it('treats ADJUSTMENT_REMOVE as negative regardless of sign sent', async () => {
      const p = await makeProduct({ stock_quantity: 10 });
      const res = await api
        .post('/api/inventory/scan-adjust')
        .send({ barcode: p.barcode, change_quantity: 4, type: 'ADJUSTMENT_REMOVE', reason: 'Damaged' });
      expect(res.status).toBe(200);
      expect(res.body.data.product.stock_quantity).toBe(6);
      expect(res.body.data.movement.quantity_change).toBe(-4);
      expect(res.body.data.movement.reason).toBe('Damaged');
    });

    it('refuses to go below zero with 409 INSUFFICIENT_STOCK', async () => {
      const p = await makeProduct({ stock_quantity: 3 });
      const res = await api
        .post('/api/inventory/scan-adjust')
        .send({ barcode: p.barcode, change_quantity: 4, type: 'ADJUSTMENT_REMOVE' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INSUFFICIENT_STOCK');
      const after = await api.get(`/api/products/${p.id}`);
      expect(after.body.data.stock_quantity).toBe(3);
    });

    it('returns 404 for an unknown barcode and 400 for bad input', async () => {
      const missing = await api
        .post('/api/inventory/scan-adjust')
        .send({ barcode: 'NOPE', change_quantity: 1, type: 'RESTOCK' });
      expect(missing.status).toBe(404);

      const zero = await api.post('/api/inventory/scan-adjust').send({ barcode: 'x', change_quantity: 0, type: 'RESTOCK' });
      expect(zero.status).toBe(400);

      const badType = await api.post('/api/inventory/scan-adjust').send({ barcode: 'x', change_quantity: 1, type: 'SALE' });
      expect(badType.status).toBe(400);
    });
  });

  describe('POST /api/inventory/set-count', () => {
    it('records the variance as an adjustment', async () => {
      const p = await makeProduct({ stock_quantity: 10 });
      const res = await api.post('/api/inventory/set-count').send({ barcode: p.barcode, actual_count: 7 });
      expect(res.status).toBe(200);
      expect(res.body.data.product.stock_quantity).toBe(7);
      expect(res.body.data.movement).toMatchObject({ type: 'ADJUSTMENT_REMOVE', quantity_change: -3, reference_id: 'STOCK-AUDIT' });
    });

    it('is a no-op when the count already matches', async () => {
      const p = await makeProduct({ stock_quantity: 10 });
      const res = await api.post('/api/inventory/set-count').send({ barcode: p.barcode, actual_count: 10 });
      expect(res.status).toBe(200);
      expect(res.body.data.movement).toBeNull();
    });
  });

  describe('POST /api/inventory/import-batch', () => {
    it('inserts, updates, auto-creates departments, and reports skipped rows', async () => {
      const existing = await makeProduct({ stock_quantity: 4, price: 1 });

      const res = await api.post('/api/inventory/import-batch').send({
        items: [
          { name: 'Chai Masala 100g', barcode: 'IMP-1', department: 'Spices', price: '3.50', stock: 12 },
          { name: existing.barcode, barcode: existing.barcode, department: 'Beverages', price: 1.25, stock: 6 },
          { name: 'No barcode', price: 1 },
          { name: 'No price', barcode: 'IMP-3' },
        ],
      });

      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d.inserted_count).toBe(1);
      expect(d.updated_count).toBe(1);
      expect(d.created_departments.map((x: { name: string }) => x.name)).toEqual(['Spices']);
      expect(d.skipped).toEqual([
        { row: 3, reason: 'missing barcode' },
        { row: 4, reason: 'missing or invalid price' },
      ]);

      const updated = await api.get(`/api/products/${existing.id}`);
      expect(updated.body.data.stock_quantity).toBe(10);
      expect(updated.body.data.price).toBe(1.25);

      const created = await api.get('/api/products/barcode/IMP-1');
      expect(created.body.data.price).toBe(3.5);
      expect(created.body.data.stock_quantity).toBe(12);
      expect(created.body.data.department_name).toBe('Spices');

      const moves = await api.get(`/api/movements?product_id=${existing.id}&type=RESTOCK`);
      expect(moves.body.data[0]).toMatchObject({ quantity_before: 4, quantity_after: 10, reference_id: 'SHEET-IMPORT' });
    });
  });

  describe('GET /api/movements', () => {
    it('filters by type and paginates', async () => {
      const res = await api.get('/api/movements?type=RESTOCK&limit=1');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].type).toBe('RESTOCK');
      expect(res.body.pagination.total).toBeGreaterThanOrEqual(1);
      expect(typeof res.body.data[0].product_price).toBe('number');
      expect(res.body.data[0].user_name).toBe('Store Owner');
    });

    it('rejects an unknown type', async () => {
      const res = await api.get('/api/movements?type=BOGUS');
      expect(res.status).toBe(400);
    });

    it('exports CSV with a user column and formula-injection guarding', async () => {
      const p = await makeProduct({ stock_quantity: 1 });
      await api
        .post('/api/inventory/scan-adjust')
        .send({ barcode: p.barcode, change_quantity: 1, type: 'RESTOCK', reason: '=HYPERLINK("http://evil")' });
      const res = await api.get('/api/movements/export-csv');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.text.split('\r\n')[0]).toMatch(/^ID,Date Time,Product Name,Barcode,Department,Type,Quantity Change,Before,After,User/);
      expect(res.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
      expect(res.text).toContain('Store Owner');
    });
  });
});
