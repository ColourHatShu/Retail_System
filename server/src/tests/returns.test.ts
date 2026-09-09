import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { getPool } from '../db';
import { bootstrapOwner, client, createTestSchema, dropTestSchema, firstDepartmentId, hasDatabase, loginAs } from './helpers';

const app = createApp();
let owner: ReturnType<typeof client>;
let ownerToken: string;
let manager: ReturnType<typeof client>;
let cashier: ReturnType<typeof client>;
let deptId: number;
let seq = 0;

describe.skipIf(!hasDatabase)('returns and voids', () => {
  beforeAll(async () => {
    await createTestSchema();
    ownerToken = await bootstrapOwner(app);
    owner = client(app, ownerToken);
    manager = client(app, (await loginAs(app, ownerToken, 'MANAGER')).token);
    cashier = client(app, (await loginAs(app, ownerToken, 'CASHIER')).token);
    deptId = await firstDepartmentId();
    await owner.put('/api/settings').send({ tax_rate_percent: 5, refund_approval_threshold: 50, return_window_days: 30 });
  });
  afterAll(dropTestSchema);

  async function makeProduct(price: number, stock = 20) {
    const res = await owner
      .post('/api/products')
      .send({ barcode: `RET-${++seq}`, name: `Item ${seq}`, department_id: deptId, price, stock_quantity: stock });
    expect(res.status).toBe(201);
    return res.body.data as { id: number; barcode: string };
  }

  async function makeSale(lines: Array<{ product_id: number; quantity: number }>, discount = 0, by = cashier) {
    const res = await by.post('/api/sales/checkout').send({ items: lines, discount, payment_method: 'CARD' });
    expect(res.status).toBe(201);
    return res.body.data as {
      id: number;
      receipt_number: string;
      total: number;
      items: Array<{ id: number; product_id: number; quantity: number; returned_quantity: number }>;
    };
  }

  const stockOf = async (id: number) => (await owner.get(`/api/products/${id}`)).body.data.stock_quantity as number;

  it('refunds a partial return with tax and discount pro-rated, restocks, and logs the ledger', async () => {
    const a = await makeProduct(10, 20);
    const b = await makeProduct(4, 20);
    // subtotal 2*10 + 3*4 = 32, discount 2 => taxable 30, tax 1.50, total 31.50
    const sale = await makeSale(
      [
        { product_id: a.id, quantity: 2 },
        { product_id: b.id, quantity: 3 },
      ],
      2,
    );
    expect(sale.total).toBe(31.5);
    expect(await stockOf(a.id)).toBe(18);

    const lineA = sale.items.find((i) => i.product_id === a.id)!;
    const quote = await cashier
      .post('/api/returns/quote')
      .send({ receipt_number: sale.receipt_number, items: [{ sale_item_id: lineA.id, quantity: 1 }] });
    expect(quote.status).toBe(200);
    // one unit of A: 10 * (31.50 / 32) = 9.84375 -> 9.84
    expect(quote.body.data.refund).toBe(9.84);
    expect(quote.body.data.allowed).toBe(true);
    expect(quote.body.data.completes_sale).toBe(false);
    expect(await stockOf(a.id)).toBe(18); // a quote changes nothing

    const ret = await cashier.post('/api/returns').send({
      receipt_number: sale.receipt_number,
      items: [{ sale_item_id: lineA.id, quantity: 1, restock: true, condition: 'RESALABLE' }],
      reason: 'Changed mind',
    });
    expect(ret.status).toBe(201);
    expect(ret.body.data).toMatchObject({
      kind: 'RETURN',
      refund: 9.84,
      refund_method: 'CARD',
      reason: 'Changed mind',
      receipt_number: sale.receipt_number,
    });
    expect(ret.body.data.return_number).toMatch(/^RET-\d{8}-\d{4}$/);
    expect(ret.body.data.processed_by_name).toMatch(/CASHIER/);
    expect(await stockOf(a.id)).toBe(19);

    const after = await owner.get(`/api/sales/${sale.id}`);
    expect(after.body.data.status).toBe('PARTIALLY_REFUNDED');
    expect(after.body.data.refunded_total).toBe(9.84);
    expect(after.body.data.items.find((i: { id: number }) => i.id === lineA.id).returned_quantity).toBe(1);

    const moves = await owner.get(`/api/movements?product_id=${a.id}&type=RETURN`);
    expect(moves.body.data[0]).toMatchObject({
      quantity_change: 1,
      quantity_before: 18,
      quantity_after: 19,
      reference_id: ret.body.data.return_number,
      sale_id: sale.id,
    });
  });

  it('a return that completes the sale refunds exactly the remaining paid amount', async () => {
    const a = await makeProduct(3.33, 20);
    const sale = await makeSale([{ product_id: a.id, quantity: 3 }]); // 9.99 + 5% = 10.49 (10.4895)
    expect(sale.total).toBe(10.49);
    const line = sale.items[0];

    const first = await cashier
      .post('/api/returns')
      .send({ sale_id: sale.id, items: [{ sale_item_id: line.id, quantity: 1 }] });
    expect(first.status).toBe(201);
    expect(first.body.data.refund).toBe(3.5); // 3.33 * 1.05 = 3.4965 -> 3.50

    const second = await cashier
      .post('/api/returns')
      .send({ sale_id: sale.id, items: [{ sale_item_id: line.id, quantity: 2 }] });
    expect(second.status).toBe(201);
    expect(second.body.data.refund).toBe(6.99); // 10.49 - 3.50, not 2 * 3.50

    const after = await owner.get(`/api/sales/${sale.id}`);
    expect(after.body.data.status).toBe('REFUNDED');
    expect(after.body.data.refunded_total).toBe(10.49);
    expect(await stockOf(a.id)).toBe(20);
  });

  it('write-offs refund without restocking', async () => {
    const a = await makeProduct(5, 10);
    const sale = await makeSale([{ product_id: a.id, quantity: 2 }]);
    const ret = await cashier.post('/api/returns').send({
      sale_id: sale.id,
      items: [{ sale_item_id: sale.items[0].id, quantity: 1, restock: false, condition: 'DAMAGED' }],
    });
    expect(ret.status).toBe(201);
    expect(ret.body.data.items[0]).toMatchObject({ restock: false, condition: 'DAMAGED', refund: 5.25 });
    expect(await stockOf(a.id)).toBe(8);
    const moves = await owner.get(`/api/movements?product_id=${a.id}&type=RETURN`);
    expect(moves.body.data).toHaveLength(0);
  });

  it('refuses over-returns, duplicates, foreign lines, and unknown receipts', async () => {
    const a = await makeProduct(1, 10);
    const sale = await makeSale([{ product_id: a.id, quantity: 2 }]);
    const other = await makeSale([{ product_id: a.id, quantity: 1 }]);
    const line = sale.items[0].id;

    const over = await cashier.post('/api/returns').send({ sale_id: sale.id, items: [{ sale_item_id: line, quantity: 3 }] });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('RETURN_EXCEEDS_SALE');

    const dup = await cashier.post('/api/returns').send({
      sale_id: sale.id,
      items: [
        { sale_item_id: line, quantity: 1 },
        { sale_item_id: line, quantity: 1 },
      ],
    });
    expect(dup.status).toBe(400);

    const foreign = await cashier
      .post('/api/returns')
      .send({ sale_id: sale.id, items: [{ sale_item_id: other.items[0].id, quantity: 1 }] });
    expect(foreign.status).toBe(400);

    const missing = await cashier
      .post('/api/returns')
      .send({ receipt_number: 'REC-19990101-9999', items: [{ sale_item_id: 1, quantity: 1 }] });
    expect(missing.status).toBe(404);

    const noRef = await cashier.post('/api/returns').send({ items: [{ sale_item_id: 1, quantity: 1 }] });
    expect(noRef.status).toBe(400);
  });

  it('large refunds need a manager; the quote says so before the cashier tries', async () => {
    const a = await makeProduct(40, 10);
    const sale = await makeSale([{ product_id: a.id, quantity: 2 }]); // 84.00 total
    const line = sale.items[0].id;

    const quote = await cashier
      .post('/api/returns/quote')
      .send({ sale_id: sale.id, items: [{ sale_item_id: line, quantity: 2 }] });
    expect(quote.body.data.requires_manager).toBe(true);
    expect(quote.body.data.allowed).toBe(false);
    expect(quote.body.data.blocked_reason).toMatch(/manager or owner/);

    const denied = await cashier.post('/api/returns').send({ sale_id: sale.id, items: [{ sale_item_id: line, quantity: 2 }] });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('APPROVAL_REQUIRED');
    expect(await stockOf(a.id)).toBe(8);

    const small = await cashier.post('/api/returns').send({ sale_id: sale.id, items: [{ sale_item_id: line, quantity: 1 }] });
    expect(small.status).toBe(201); // 42.00 is under the 50 threshold

    const rest = await manager.post('/api/returns').send({ sale_id: sale.id, items: [{ sale_item_id: line, quantity: 1 }] });
    expect(rest.status).toBe(201);
    expect(await stockOf(a.id)).toBe(10);
  });

  it('enforces the return window for staff but lets an owner override', async () => {
    const a = await makeProduct(2, 10);
    const sale = await makeSale([{ product_id: a.id, quantity: 1 }]);
    await getPool().query("UPDATE sales SET created_at = now() - interval '45 days' WHERE id = $1", [sale.id]);
    const line = sale.items[0].id;

    const late = await manager.post('/api/returns').send({ sale_id: sale.id, items: [{ sale_item_id: line, quantity: 1 }] });
    expect(late.status).toBe(403);
    expect(late.body.code).toBe('RETURN_WINDOW_CLOSED');

    const override = await owner.post('/api/returns').send({ sale_id: sale.id, items: [{ sale_item_id: line, quantity: 1 }] });
    expect(override.status).toBe(201);
  });

  it('void reverses a whole same-day receipt, manager or owner only', async () => {
    const a = await makeProduct(7, 10);
    const b = await makeProduct(1, 10);
    const sale = await makeSale([
      { product_id: a.id, quantity: 2 },
      { product_id: b.id, quantity: 4 },
    ]);
    expect(await stockOf(a.id)).toBe(8);

    const cashierVoid = await cashier.post(`/api/sales/${sale.id}/void`).send({ reason: 'Wrong customer' });
    expect(cashierVoid.status).toBe(403);

    const noReason = await manager.post(`/api/sales/${sale.id}/void`).send({});
    expect(noReason.status).toBe(400);

    const voided = await manager.post(`/api/sales/${sale.id}/void`).send({ reason: 'Rang up twice' });
    expect(voided.status).toBe(201);
    expect(voided.body.data.kind).toBe('VOID');
    expect(voided.body.data.refund).toBe(sale.total);
    expect(voided.body.data.reason).toBe('Rang up twice');
    expect(await stockOf(a.id)).toBe(10);
    expect(await stockOf(b.id)).toBe(10);

    const after = await owner.get(`/api/sales/${sale.id}`);
    expect(after.body.data.status).toBe('VOIDED');

    const again = await manager.post(`/api/sales/${sale.id}/void`).send({ reason: 'Again' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('SALE_VOIDED');

    const afterVoidReturn = await cashier
      .post('/api/returns')
      .send({ sale_id: sale.id, items: [{ sale_item_id: sale.items[0].id, quantity: 1 }] });
    expect(afterVoidReturn.status).toBe(409);
  });

  it('void is refused after a return or after 24 hours', async () => {
    const a = await makeProduct(1, 10);
    const returned = await makeSale([{ product_id: a.id, quantity: 2 }]);
    await cashier
      .post('/api/returns')
      .send({ sale_id: returned.id, items: [{ sale_item_id: returned.items[0].id, quantity: 1 }] });
    const hasReturns = await manager.post(`/api/sales/${returned.id}/void`).send({ reason: 'Too late' });
    expect(hasReturns.status).toBe(409);
    expect(hasReturns.body.code).toBe('SALE_HAS_RETURNS');

    const old = await makeSale([{ product_id: a.id, quantity: 1 }]);
    await getPool().query("UPDATE sales SET created_at = now() - interval '2 days' WHERE id = $1", [old.id]);
    const stale = await manager.post(`/api/sales/${old.id}/void`).send({ reason: 'Old' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VOID_WINDOW_CLOSED');
  });

  it('lists returns, looks up by receipt, and numbers sequentially', async () => {
    const lookup = await cashier.get('/api/sales/receipt/rec-19990101-0001');
    expect(lookup.status).toBe(404);

    const list = await cashier.get('/api/returns?limit=3');
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBe(3);
    expect(list.body.pagination.total).toBeGreaterThanOrEqual(3);

    const one = await cashier.get(`/api/returns/${list.body.data[0].id}`);
    expect(one.status).toBe(200);
    expect(Array.isArray(one.body.data.items)).toBe(true);

    const numbers = (await owner.get('/api/returns?limit=200')).body.data.map((r: { return_number: string }) =>
      Number(r.return_number.split('-')[2]),
    ) as number[];
    const sorted = [...numbers].sort((x, y) => x - y);
    expect(sorted).toEqual(Array.from({ length: sorted.length }, (_, i) => i + 1));

    const bySale = await cashier.get(`/api/sales/${list.body.data[0].sale_id}/returns`);
    expect(bySale.status).toBe(200);
    expect(bySale.body.data.length).toBeGreaterThanOrEqual(1);
  });
});
