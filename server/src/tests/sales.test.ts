import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { getPool } from '../db';
import { bootstrapOwner, client, createTestSchema, dropTestSchema, firstDepartmentId, hasDatabase } from './helpers';

const app = createApp();
let api: ReturnType<typeof client>;
let deptId: number;
let seq = 0;

describe.skipIf(!hasDatabase)('sales', () => {
  beforeAll(async () => {
    await createTestSchema();
    api = client(app, await bootstrapOwner(app));
    deptId = await firstDepartmentId();
    await getPool().query("UPDATE settings SET value = '500' WHERE key = 'tax_rate_bps'");
  });
  afterAll(dropTestSchema);

  async function makeProduct(overrides: Record<string, unknown> = {}) {
    const res = await api.post('/api/products').send({
      barcode: `SALE-${++seq}`,
      name: `Item ${seq}`,
      department_id: deptId,
      price: 1.99,
      stock_quantity: 10,
      ...overrides,
    });
    expect(res.status).toBe(201);
    return res.body.data as { id: number; barcode: string; stock_quantity: number };
  }

  describe('POST /api/sales/checkout', () => {
    it('recomputes every money field on the server, ignores client prices, and records the cashier', async () => {
      const p = await makeProduct({ price: 1.99, stock_quantity: 10 });

      const res = await api.post('/api/sales/checkout').send({
        // A tampered client claims the item costs one cent and the total is 3 cents.
        items: [{ product_id: p.id, quantity: 3, unit_price: 0.01 }],
        subtotal: 0.03,
        total: 0.03,
        payment_method: 'CASH',
        amount_paid: 10,
      });

      expect(res.status).toBe(201);
      const sale = res.body.data;
      expect(sale.subtotal).toBe(5.97);
      expect(sale.tax_rate).toBe(5);
      expect(sale.tax_amount).toBe(0.3); // 597 * 5% = 29.85 -> 30 cents
      expect(sale.total).toBe(6.27);
      expect(sale.amount_paid).toBe(10);
      expect(sale.change_due).toBe(3.73);
      expect(sale.items).toHaveLength(1);
      expect(sale.items[0].unit_price).toBe(1.99);
      expect(sale.items[0].total_price).toBe(5.97);
      expect(sale.receipt_number).toMatch(/^REC-\d{8}-\d{4}$/);
      expect(sale.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(sale.cashier_name).toBe('Store Owner');

      const after = await api.get(`/api/products/${p.id}`);
      expect(after.body.data.stock_quantity).toBe(7);

      const moves = await api.get(`/api/movements?product_id=${p.id}&type=SALE`);
      expect(moves.body.data).toHaveLength(1);
      expect(moves.body.data[0]).toMatchObject({
        quantity_change: -3,
        quantity_before: 10,
        quantity_after: 7,
        reference_id: sale.receipt_number,
        sale_id: sale.id,
        user_name: 'Store Owner',
      });
    });

    it('refuses the sale with PRICE_CHANGED when the register total is stale', async () => {
      const p = await makeProduct({ price: 2.0 });
      const res = await api
        .post('/api/sales/checkout')
        .send({ items: [{ product_id: p.id, quantity: 1 }], expected_total: 2.0, payment_method: 'CARD' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PRICE_CHANGED');
      expect(res.body.details).toEqual({ server_total: 2.1, client_total: 2.0 });

      const after = await api.get(`/api/products/${p.id}`);
      expect(after.body.data.stock_quantity).toBe(10); // nothing was deducted
    });

    it('accepts the sale when expected_total matches', async () => {
      const p = await makeProduct({ price: 2.0 });
      const res = await api
        .post('/api/sales/checkout')
        .send({ items: [{ product_id: p.id, quantity: 1 }], expected_total: 2.1, payment_method: 'CARD' });
      expect(res.status).toBe(201);
      expect(res.body.data.amount_paid).toBe(2.1);
      expect(res.body.data.change_due).toBe(0);
    });

    it('rolls back completely on oversell', async () => {
      const ok = await makeProduct({ stock_quantity: 5 });
      const short = await makeProduct({ stock_quantity: 1 });

      const res = await api.post('/api/sales/checkout').send({
        items: [
          { product_id: ok.id, quantity: 2 },
          { product_id: short.id, quantity: 2 },
        ],
        payment_method: 'CARD',
      });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INSUFFICIENT_STOCK');
      expect(res.body.details.product_id).toBe(short.id);

      const a = await api.get(`/api/products/${ok.id}`);
      const b = await api.get(`/api/products/${short.id}`);
      expect(a.body.data.stock_quantity).toBe(5);
      expect(b.body.data.stock_quantity).toBe(1);
      const moves = await api.get(`/api/movements?product_id=${ok.id}&type=SALE`);
      expect(moves.body.data).toHaveLength(0);
    });

    it('merges duplicate lines and checks stock against the merged quantity', async () => {
      const p = await makeProduct({ stock_quantity: 5 });
      const res = await api.post('/api/sales/checkout').send({
        items: [
          { product_id: p.id, quantity: 3 },
          { barcode: p.barcode, quantity: 3 },
        ],
        payment_method: 'CARD',
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INSUFFICIENT_STOCK');
      expect(res.body.details.requested).toBe(6);
    });

    it('serialises concurrent checkouts so stock never goes negative', async () => {
      const p = await makeProduct({ stock_quantity: 5 });
      const attempts = await Promise.all(
        Array.from({ length: 4 }, () =>
          api.post('/api/sales/checkout').send({ items: [{ product_id: p.id, quantity: 2 }], payment_method: 'CARD' }),
        ),
      );
      const ok = attempts.filter((r) => r.status === 201).length;
      const refused = attempts.filter((r) => r.status === 409 && r.body.code === 'INSUFFICIENT_STOCK').length;
      expect(ok).toBe(2); // 5 units allows exactly two sales of 2
      expect(refused).toBe(2);
      const after = await api.get(`/api/products/${p.id}`);
      expect(after.body.data.stock_quantity).toBe(1);
    });

    it('rejects insufficient cash', async () => {
      const p = await makeProduct({ price: 10 });
      const res = await api
        .post('/api/sales/checkout')
        .send({ items: [{ product_id: p.id, quantity: 1 }], payment_method: 'CASH', amount_paid: 10 });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Insufficient payment/);
    });

    it('requires amount_paid for cash', async () => {
      const p = await makeProduct();
      const res = await api
        .post('/api/sales/checkout')
        .send({ items: [{ product_id: p.id, quantity: 1 }], payment_method: 'CASH' });
      expect(res.status).toBe(400);
    });

    it('applies a receipt-level discount before tax', async () => {
      const p = await makeProduct({ price: 10 });
      const res = await api
        .post('/api/sales/checkout')
        .send({ items: [{ product_id: p.id, quantity: 2 }], discount: 5, payment_method: 'CARD' });
      expect(res.status).toBe(201);
      expect(res.body.data.subtotal).toBe(20);
      expect(res.body.data.discount).toBe(5);
      expect(res.body.data.tax_amount).toBe(0.75); // 5% of 15
      expect(res.body.data.total).toBe(15.75);
    });

    it('rejects a discount larger than the subtotal', async () => {
      const p = await makeProduct({ price: 1 });
      const res = await api
        .post('/api/sales/checkout')
        .send({ items: [{ product_id: p.id, quantity: 1 }], discount: 2, payment_method: 'CARD' });
      expect(res.status).toBe(400);
    });

    it('issues gap-free sequential receipt numbers', async () => {
      const p = await makeProduct({ stock_quantity: 50 });
      const nums: string[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await api
          .post('/api/sales/checkout')
          .send({ items: [{ product_id: p.id, quantity: 1 }], payment_method: 'CARD' });
        expect(res.status).toBe(201);
        nums.push(res.body.data.receipt_number);
      }
      const seqs = nums.map((n) => Number(n.split('-')[2]));
      expect(seqs[1]).toBe(seqs[0] + 1);
      expect(seqs[2]).toBe(seqs[1] + 1);
    });

    it('uses the configured tax rate', async () => {
      await api.put('/api/settings').send({ tax_rate_percent: 18 });
      const p = await makeProduct({ price: 100 });
      const res = await api
        .post('/api/sales/checkout')
        .send({ items: [{ product_id: p.id, quantity: 1 }], payment_method: 'CARD' });
      expect(res.status).toBe(201);
      expect(res.body.data.tax_rate).toBe(18);
      expect(res.body.data.total).toBe(118);
      await api.put('/api/settings').send({ tax_rate_percent: 5 });
    });

    it('validates the payload shape', async () => {
      const empty = await api.post('/api/sales/checkout').send({ items: [] });
      expect(empty.status).toBe(400);
      expect(empty.body.code).toBe('VALIDATION_ERROR');

      const noRef = await api.post('/api/sales/checkout').send({ items: [{ quantity: 1 }], payment_method: 'CARD' });
      expect(noRef.status).toBe(400);

      const badMethod = await api
        .post('/api/sales/checkout')
        .send({ items: [{ product_id: 1, quantity: 1 }], payment_method: 'BITCOIN' });
      expect(badMethod.status).toBe(400);

      const unknown = await api
        .post('/api/sales/checkout')
        .send({ items: [{ product_id: 999999, quantity: 1 }], payment_method: 'CARD' });
      expect(unknown.status).toBe(404);
    });
  });

  describe('GET /api/sales', () => {
    it('lists with pagination and returns a sale with items', async () => {
      const list = await api.get('/api/sales?limit=2');
      expect(list.status).toBe(200);
      expect(list.body.pagination.limit).toBe(2);
      expect(list.body.data.length).toBeLessThanOrEqual(2);
      expect(list.body.data[0].item_count).toBeGreaterThan(0);
      expect(list.body.data[0].cashier_name).toBe('Store Owner');

      const one = await api.get(`/api/sales/${list.body.data[0].id}`);
      expect(one.status).toBe(200);
      expect(Array.isArray(one.body.data.items)).toBe(true);

      const missing = await api.get('/api/sales/999999');
      expect(missing.status).toBe(404);
    });
  });
});
