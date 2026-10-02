import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { getPool } from '../db';
import { bootstrapOwner, client, createTestSchema, dropTestSchema, firstDepartmentId, hasDatabase, loginAs } from './helpers';

const app = createApp();
let api: ReturnType<typeof client>;
let cashier: ReturnType<typeof client>;
let deptId: number;
let seq = 0;

// Each case makes many round trips; a remote test database needs the room.
describe.skipIf(!hasDatabase)('counter operations', { timeout: 90_000 }, () => {
  beforeAll(async () => {
    await createTestSchema();
    const owner = await bootstrapOwner(app);
    api = client(app, owner);
    cashier = client(app, (await loginAs(app, owner, 'CASHIER')).token);
    deptId = await firstDepartmentId();
    // A flat 5% so the arithmetic below stays readable.
    await getPool().query("UPDATE settings SET value = '500' WHERE key = 'tax_rate_bps'");
  });
  afterAll(dropTestSchema);

  async function makeProduct(overrides: Record<string, unknown> = {}) {
    const res = await api.post('/api/products').send({
      barcode: `OPS-${++seq}`,
      name: `Thing ${seq}`,
      department_id: deptId,
      price: 10,
      cost_price: 4,
      stock_quantity: 20,
      ...overrides,
    });
    expect(res.status).toBe(201);
    return res.body.data as { id: number; stock_quantity: number };
  }

  it('takes several tenders on one sale and gives change only from cash', async () => {
    const p = await makeProduct();
    const res = await api.post('/api/sales/checkout').send({
      items: [{ product_id: p.id, quantity: 2 }], // 21.00 with tax
      payments: [
        { method: 'DEBIT', amount: 15 },
        { method: 'CASH', amount: 10 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ payment_method: 'SPLIT', total: 21, change_due: 4 });
    expect(res.body.data.payments).toEqual([
      { method: 'DEBIT', amount: 15 },
      { method: 'CASH', amount: 10 },
    ]);

    const tooMuchCard = await api.post('/api/sales/checkout').send({
      items: [{ product_id: p.id, quantity: 1 }],
      payments: [{ method: 'CREDIT', amount: 50 }],
    });
    expect(tooMuchCard.status).toBe(400);
  });

  it('applies line discounts for anyone and price overrides for managers only', async () => {
    const p = await makeProduct();
    const discounted = await cashier.post('/api/sales/checkout').send({
      items: [{ product_id: p.id, quantity: 2, line_discount: 5 }],
      payment_method: 'CARD',
    });
    expect(discounted.status).toBe(201);
    expect(discounted.body.data).toMatchObject({ subtotal: 15, total: 15.75 });
    expect(discounted.body.data.items[0]).toMatchObject({ line_discount: 5, total_price: 15, list_price: 10 });

    const refused = await cashier.post('/api/sales/checkout').send({
      items: [{ product_id: p.id, quantity: 1, price_override: 1 }],
      payment_method: 'CARD',
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('MANAGER_REQUIRED');

    const overridden = await api.post('/api/sales/checkout').send({
      items: [{ product_id: p.id, quantity: 1, price_override: 8 }],
      payment_method: 'CARD',
    });
    expect(overridden.body.data).toMatchObject({ subtotal: 8, total: 8.4 });

    // A return refunds what the line really cost, not the catalogue price.
    const ret = await api.post('/api/returns').send({
      sale_id: discounted.body.data.id,
      items: [{ sale_item_id: discounted.body.data.items[0].id, quantity: 1, restock: true }],
    });
    expect(ret.body.data.refund).toBe(7.88);
  });

  it('runs a cash drawer shift and closes it against the expected cash', async () => {
    expect((await api.get('/api/shifts/current')).body.data).toBeNull();
    expect((await api.post('/api/shifts/cash').send({ type: 'PAY_OUT', amount: 5, reason: 'milk' })).status).toBe(409);

    const opened = await cashier.post('/api/shifts/open').send({ opening_float: 100 });
    expect(opened.status).toBe(201);
    expect((await api.post('/api/shifts/open').send({ opening_float: 50 })).status).toBe(409);

    const p = await makeProduct();
    await api.post('/api/sales/checkout').send({
      items: [{ product_id: p.id, quantity: 1 }], // 10.50
      payment_method: 'CASH',
      amount_paid: 20,
    });
    await api.post('/api/sales/checkout').send({ items: [{ product_id: p.id, quantity: 1 }], payment_method: 'DEBIT' });
    await api.post('/api/shifts/cash').send({ type: 'PAY_OUT', amount: 5, reason: 'milk' });
    await api.post('/api/shifts/cash').send({ type: 'PAY_IN', amount: 2, reason: 'change top-up' });

    const live = (await api.get('/api/shifts/current')).body.data;
    expect(live).toMatchObject({ sales_count: 2, opening_float: 100, pay_outs: 5, pay_ins: 2, expected_cash: 107.5 });
    expect(live.tenders).toMatchObject({ CASH: 10.5, DEBIT: 10.5 });

    const closed = await cashier.post('/api/shifts/close').send({ counted_cash: 107, note: 'short 50c' });
    expect(closed.body.data).toMatchObject({ status: 'CLOSED', expected_cash: 107.5, counted_cash: 107, over_short: -0.5 });
    expect((await cashier.get('/api/shifts')).status).toBe(403);
    expect((await api.get('/api/shifts')).body.data[0]).toMatchObject({ over_short: -0.5 });
  });

  it('parks a cart and lets it be resumed exactly once', async () => {
    const p = await makeProduct();
    const heldRes = await cashier
      .post('/api/held-sales')
      .send({ label: 'Blue jacket', items: [{ product_id: p.id, quantity: 3 }], total: 31.5 });
    expect(heldRes.status).toBe(201);
    expect((await api.get('/api/held-sales')).body.data).toHaveLength(1);
    const resumed = await api.post(`/api/held-sales/${heldRes.body.data.id}/resume`);
    expect(resumed.body.data.payload.items).toEqual([{ product_id: p.id, quantity: 3 }]);
    expect((await api.post(`/api/held-sales/${heldRes.body.data.id}/resume`)).status).toBe(404);
  });

  it('treats a repeated client_ref as the same sale even when online', async () => {
    const p = await makeProduct();
    const body = { items: [{ product_id: p.id, quantity: 1 }], payment_method: 'DEBIT', client_ref: 'online-ref-0001' };
    const a = await api.post('/api/sales/checkout').send(body);
    const b = await api.post('/api/sales/checkout').send(body);
    expect(b.body.data.id).toBe(a.body.data.id);
    expect((await api.get(`/api/products/${p.id}`)).body.data.stock_quantity).toBe(19);
  });

  it('records an offline sale once, at the time it happened, even past zero stock', async () => {
    const p = await makeProduct({ stock_quantity: 1 });
    const body = {
      items: [{ product_id: p.id, quantity: 2 }],
      payment_method: 'CASH',
      amount_paid: 21,
      client_ref: 'offline-abc-123',
      sold_at: '2026-01-15T15:00:00.000Z',
      expected_total: 999, // the register's old price is not a reason to lose the sale
    };
    const first = await api.post('/api/sales/checkout').send(body);
    expect(first.status).toBe(201);
    expect(first.body.data.created_at).toBe('2026-01-15T15:00:00.000Z');
    const again = await api.post('/api/sales/checkout').send(body);
    expect(again.body.data.id).toBe(first.body.data.id);
    const stock = await api.get(`/api/products/${p.id}`);
    expect(stock.body.data.stock_quantity).toBe(-1);
  });

  it('keeps customers, earns points, and takes them back on a refund', async () => {
    const c = await cashier.post('/api/customers').send({ name: 'Priya Shah', phone: '(416) 555-0100' });
    expect(c.status).toBe(201);
    expect(c.body.data.phone).toBe('4165550100');
    expect((await cashier.post('/api/customers').send({ name: 'Dup', phone: '416-555-0100' })).status).toBe(409);
    expect((await cashier.get('/api/customers?q=555')).body.data[0].name).toBe('Priya Shah');

    const p = await makeProduct();
    const sale = await cashier.post('/api/sales/checkout').send({
      items: [{ product_id: p.id, quantity: 4 }], // 42.00
      payment_method: 'CARD',
      customer_id: c.body.data.id,
    });
    expect(sale.body.data).toMatchObject({ customer_name: 'Priya Shah', points_earned: 42 });
    expect((await api.get(`/api/customers/${c.body.data.id}`)).body.data).toMatchObject({ points: 42, visits: 1 });

    await api.post('/api/returns').send({
      sale_id: sale.body.data.id,
      items: [{ sale_item_id: sale.body.data.items[0].id, quantity: 2, restock: true }],
    });
    expect((await api.get(`/api/customers/${c.body.data.id}`)).body.data.points).toBe(21);
    expect((await cashier.put(`/api/customers/${c.body.data.id}`).send({ points: 0 })).status).toBe(403);
  });

  it('reports profit and top sellers net of returns', async () => {
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 3_600_000).toISOString();
    const res = await api.get(`/api/reports/sales?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.body.data.totals.revenue).toBeGreaterThan(0);
    expect(res.body.data.totals.profit).toBeCloseTo(res.body.data.totals.revenue - res.body.data.totals.cost, 1);
    expect(res.body.data.top_products.length).toBeGreaterThan(0);
    expect((await cashier.get(`/api/reports/sales?from=${from}&to=${to}`)).status).toBe(403);
  });

  it('orders from a supplier and receives stock in parts', async () => {
    const p = await makeProduct({ stock_quantity: 2, min_stock_level: 5 });
    const suggestions = (await api.get('/api/purchasing/suggestions')).body.data as Array<{ id: number; suggested_quantity: number }>;
    expect(suggestions.find((x) => x.id === p.id)?.suggested_quantity).toBe(8);

    const sup = await api.post('/api/purchasing/suppliers').send({ name: 'Metro Wholesale' });
    expect(sup.status).toBe(201);
    expect((await api.post('/api/purchasing/suppliers').send({ name: 'Metro Wholesale' })).status).toBe(409);

    const po = await api.post('/api/purchasing/orders').send({
      supplier_id: sup.body.data.id,
      items: [{ product_id: p.id, quantity: 10, unit_cost: 3.5 }],
    });
    expect(po.status).toBe(201);
    expect(po.body.data.po_number).toMatch(/^PO-\d{8}-0001$/);

    const lineId = po.body.data.items[0].id;
    const part = await api.post(`/api/purchasing/orders/${po.body.data.id}/receive`).send({ items: [{ item_id: lineId, quantity: 4 }] });
    expect(part.body.data.status).toBe('ORDERED');
    const rest = await api.post(`/api/purchasing/orders/${po.body.data.id}/receive`).send({});
    expect(rest.body.data.status).toBe('RECEIVED');

    const product = (await api.get(`/api/products/${p.id}`)).body.data;
    expect(product).toMatchObject({ stock_quantity: 12, cost_price: 3.5 });
    expect((await cashier.get('/api/purchasing/orders')).status).toBe(403);
  });
});
