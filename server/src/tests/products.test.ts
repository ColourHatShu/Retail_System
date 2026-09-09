import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { bootstrapOwner, client, createTestSchema, dropTestSchema, firstDepartmentId, hasDatabase } from './helpers';

const app = createApp();
let api: ReturnType<typeof client>;
let deptId: number;

describe.skipIf(!hasDatabase)('products, departments, settings, errors', () => {
  beforeAll(async () => {
    await createTestSchema();
    api = client(app, await bootstrapOwner(app));
    deptId = await firstDepartmentId();
  });
  afterAll(dropTestSchema);

  describe('products', () => {
    it('creates with cents-safe price and logs initial stock', async () => {
      const res = await api
        .post('/api/products')
        .send({ barcode: 'P-1', name: 'Oats', department_id: deptId, price: '4.35', stock_quantity: 3 });
      expect(res.status).toBe(201);
      expect(res.body.data.price).toBe(4.35);
      expect(res.body.data.cost_price).toBe(0);
      expect(res.body.data.unit).toBe('pcs');
      expect(res.body.data.department_name).toBeTruthy();

      const moves = await api.get(`/api/movements?product_id=${res.body.data.id}`);
      expect(moves.body.data[0]).toMatchObject({ type: 'INITIAL', quantity_change: 3, quantity_after: 3 });
    });

    it('rejects missing fields, bad department, and duplicate barcodes with clear codes', async () => {
      const missing = await api.post('/api/products').send({ name: 'x' });
      expect(missing.status).toBe(400);
      expect(missing.body.code).toBe('VALIDATION_ERROR');
      expect(missing.body.error).toMatch(/barcode/);

      const badDept = await api.post('/api/products').send({ barcode: 'P-2', name: 'x', department_id: 9999, price: 1 });
      expect(badDept.status).toBe(400);

      const dup = await api.post('/api/products').send({ barcode: 'P-1', name: 'Dup', department_id: deptId, price: 1 });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('ALREADY_EXISTS');
      expect(dup.body.error).toMatch(/barcode already exists/);

      const negative = await api.post('/api/products').send({ barcode: 'P-3', name: 'x', department_id: deptId, price: -1 });
      expect(negative.status).toBe(400);
    });

    it('updates partially, can clear sku with null, and never touches stock', async () => {
      const created = await api
        .post('/api/products')
        .send({ barcode: 'P-4', name: 'Soap', sku: 'CARE-1', department_id: deptId, price: 6.5, stock_quantity: 20 });
      const id = created.body.data.id;

      const res = await api.put(`/api/products/${id}`).send({ price: 7, sku: null, stock_quantity: 0 });
      expect(res.status).toBe(200);
      expect(res.body.data.price).toBe(7);
      expect(res.body.data.sku).toBeNull();
      expect(res.body.data.name).toBe('Soap');
      expect(res.body.data.stock_quantity).toBe(20);
    });

    it('lists with filters', async () => {
      const all = await api.get('/api/products');
      expect(all.status).toBe(200);
      expect(all.body.data.length).toBeGreaterThanOrEqual(2);

      const search = await api.get('/api/products?search=soap');
      expect(search.body.data.map((p: { name: string }) => p.name)).toEqual(['Soap']);

      const allDept = await api.get('/api/products?department_id=ALL');
      expect(allDept.status).toBe(200);

      const bad = await api.get('/api/products?department_id=abc');
      expect(bad.status).toBe(400);
    });

    it('looks up by barcode and 404s cleanly', async () => {
      const ok = await api.get('/api/products/barcode/P-4');
      expect(ok.status).toBe(200);
      const missing = await api.get('/api/products/barcode/NOPE');
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('NOT_FOUND');
      const badId = await api.get('/api/products/abc');
      expect(badId.status).toBe(400);
    });

    it('refuses to delete a product that has been sold, allows otherwise', async () => {
      const sold = await api
        .post('/api/products')
        .send({ barcode: 'P-5', name: 'Sold', department_id: deptId, price: 1, stock_quantity: 5 });
      const sale = await api
        .post('/api/sales/checkout')
        .send({ items: [{ product_id: sold.body.data.id, quantity: 1 }], payment_method: 'CARD' });
      expect(sale.status).toBe(201);
      const refuse = await api.delete(`/api/products/${sold.body.data.id}`);
      expect(refuse.status).toBe(409);
      expect(refuse.body.code).toBe('IN_USE');

      const fresh = await api.post('/api/products').send({ barcode: 'P-6', name: 'Fresh', department_id: deptId, price: 1 });
      const del = await api.delete(`/api/products/${fresh.body.data.id}`);
      expect(del.status).toBe(200);
      const gone = await api.get(`/api/products/${fresh.body.data.id}`);
      expect(gone.status).toBe(404);
    });
  });

  describe('departments', () => {
    it('creates, uppercases the code, refuses duplicates, and blocks delete while in use', async () => {
      const res = await api.post('/api/departments').send({ name: 'Frozen Foods', code: 'frz', color: '#123456' });
      expect(res.status).toBe(201);
      expect(res.body.data.code).toBe('FRZ');

      const dup = await api.post('/api/departments').send({ name: 'Frozen Foods', code: 'FRZ2' });
      expect(dup.status).toBe(409);
      expect(dup.body.error).toMatch(/name already exists/);

      const badColor = await api.post('/api/departments').send({ name: 'X', code: 'XX', color: 'red' });
      expect(badColor.status).toBe(400);

      const inUse = await api.delete(`/api/departments/${deptId}`);
      expect(inUse.status).toBe(409);
      expect(inUse.body.code).toBe('IN_USE');

      const list = await api.get('/api/departments');
      const first = list.body.data.find((d: { id: number }) => d.id === deptId);
      expect(typeof first.inventory_value).toBe('number');
      expect(first.product_count).toBeGreaterThan(0);
    });
  });

  describe('settings', () => {
    it('reads defaults and updates tax as a percentage', async () => {
      const get = await api.get('/api/settings');
      expect(get.body.data).toEqual({
        store_name: 'Nexus POS',
        currency: 'USD',
        tax_rate_percent: 5,
        return_window_days: 30,
        refund_approval_threshold: 50,
      });

      const put = await api.put('/api/settings').send({ tax_rate_percent: '7.25', currency: 'inr' });
      expect(put.status).toBe(200);
      expect(put.body.data.tax_rate_percent).toBe(7.25);
      expect(put.body.data.currency).toBe('INR');

      const bad = await api.put('/api/settings').send({ tax_rate_percent: 150 });
      expect(bad.status).toBe(400);
    });
  });

  describe('error envelope', () => {
    it('returns JSON 404 for unknown routes and 400 for malformed JSON', async () => {
      const missing = await api.get('/api/nope');
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('NOT_FOUND');

      const bad = await api.post('/api/products').set('Content-Type', 'application/json').send('{not json');
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('INVALID_JSON');
    });
  });
});
