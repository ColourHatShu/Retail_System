import { Router } from 'express';
import { MANAGER_UP, actor, requireRole } from '../lib/authz';
import { input, validate } from '../lib/validate';
import * as s from '../schemas';
import * as customers from '../services/customers.service';
import * as held from '../services/heldSales.service';
import * as purchasing from '../services/purchasing.service';
import * as reports from '../services/reports.service';
import * as shifts from '../services/shifts.service';

type Id = { id: number };

/** The cash drawer. Anyone at the counter runs it; the shift history is for managers. */
export const shiftsRouter = Router();

shiftsRouter.get('/current', async (_req, res) => {
  res.json({ success: true, data: await shifts.getCurrentShift() });
});

shiftsRouter.get('/', requireRole(...MANAGER_UP), validate({ query: s.shiftList }), async (_req, res) => {
  res.json({ success: true, data: await shifts.listShifts(input<{ limit: number }>(res, 'query').limit) });
});

shiftsRouter.get('/:id', requireRole(...MANAGER_UP), validate({ params: s.idParam }), async (_req, res) => {
  res.json({ success: true, data: await shifts.getShift(input<Id>(res, 'params').id) });
});

shiftsRouter.post('/open', validate({ body: s.shiftOpen }), async (_req, res) => {
  const body = input<{ opening_float: number }>(res, 'body');
  res.status(201).json({ success: true, data: await shifts.openShift(body.opening_float, actor(res)) });
});

shiftsRouter.post('/cash', validate({ body: s.cashMovement }), async (_req, res) => {
  const b = input<{ type: 'PAY_IN' | 'PAY_OUT'; amount: number; reason: string }>(res, 'body');
  res.json({ success: true, data: await shifts.addCashMovement(b.type, b.amount, b.reason, actor(res)) });
});

shiftsRouter.post('/close', validate({ body: s.shiftClose }), async (_req, res) => {
  const b = input<{ counted_cash: number; note?: string }>(res, 'body');
  res.json({ success: true, data: await shifts.closeShift(b.counted_cash, b.note, actor(res)) });
});

/** Parked carts, shared by both counters. */
export const heldSalesRouter = Router();

heldSalesRouter.get('/', async (_req, res) => {
  res.json({ success: true, data: await held.listHeld() });
});

heldSalesRouter.post('/', validate({ body: s.heldSaleCreate }), async (_req, res) => {
  res.status(201).json({ success: true, data: await held.holdSale(input<s.HeldSaleCreate>(res, 'body'), actor(res)) });
});

/** Takes the cart off the shelf: returns it and deletes it in one step. */
heldSalesRouter.post('/:id/resume', validate({ params: s.idParam }), async (_req, res) => {
  res.json({ success: true, data: await held.resumeHeld(input<Id>(res, 'params').id) });
});

/** Customers: the counter can look up and add; changing points is for managers. */
export const customersRouter = Router();

customersRouter.get('/', validate({ query: s.customerQuery }), async (_req, res) => {
  const q = input<{ q?: string; limit: number }>(res, 'query');
  res.json({ success: true, data: await customers.searchCustomers(q.q, q.limit) });
});

customersRouter.get('/:id', validate({ params: s.idParam }), async (_req, res) => {
  res.json({ success: true, data: await customers.getCustomer(input<Id>(res, 'params').id) });
});

customersRouter.post('/', validate({ body: s.customerCreate }), async (_req, res) => {
  res.status(201).json({ success: true, data: await customers.createCustomer(input<s.CustomerCreate>(res, 'body')) });
});

customersRouter.put(
  '/:id',
  requireRole(...MANAGER_UP),
  validate({ params: s.idParam, body: s.customerUpdate }),
  async (_req, res) => {
    const id = input<Id>(res, 'params').id;
    res.json({ success: true, data: await customers.updateCustomer(id, input<s.CustomerUpdate>(res, 'body')) });
  },
);

/** Profit, top sellers and the rest. Managers and owners. */
export const reportsRouter = Router();

reportsRouter.get('/sales', requireRole(...MANAGER_UP), validate({ query: s.reportRange }), async (_req, res) => {
  const r = input<{ from: Date; to: Date }>(res, 'query');
  res.json({ success: true, data: await reports.salesReport(r.from, r.to) });
});

/** Suppliers, purchase orders and receiving. Managers and owners. */
export const purchasingRouter = Router();
purchasingRouter.use(requireRole(...MANAGER_UP));

purchasingRouter.get('/suppliers', async (_req, res) => {
  res.json({ success: true, data: await purchasing.listSuppliers() });
});

purchasingRouter.post('/suppliers', validate({ body: s.supplierCreate }), async (_req, res) => {
  res.status(201).json({ success: true, data: await purchasing.createSupplier(input<s.SupplierCreate>(res, 'body')) });
});

purchasingRouter.put('/suppliers/:id', validate({ params: s.idParam, body: s.supplierUpdate }), async (_req, res) => {
  const id = input<Id>(res, 'params').id;
  res.json({ success: true, data: await purchasing.updateSupplier(id, input<s.SupplierUpdate>(res, 'body')) });
});

purchasingRouter.get('/suggestions', async (_req, res) => {
  res.json({ success: true, data: await purchasing.reorderSuggestions() });
});

purchasingRouter.get('/orders', async (_req, res) => {
  res.json({ success: true, data: await purchasing.listPurchaseOrders() });
});

purchasingRouter.get('/orders/:id', validate({ params: s.idParam }), async (_req, res) => {
  res.json({ success: true, data: await purchasing.getPurchaseOrder(input<Id>(res, 'params').id) });
});

purchasingRouter.post('/orders', validate({ body: s.purchaseOrderCreate }), async (_req, res) => {
  res.status(201).json({
    success: true,
    data: await purchasing.createPurchaseOrder(input<s.PurchaseOrderCreate>(res, 'body'), actor(res)),
  });
});

purchasingRouter.post(
  '/orders/:id/receive',
  validate({ params: s.idParam, body: s.purchaseOrderReceive }),
  async (_req, res) => {
    const id = input<Id>(res, 'params').id;
    res.json({
      success: true,
      data: await purchasing.receivePurchaseOrder(id, input<s.PurchaseOrderReceive>(res, 'body'), actor(res)),
    });
  },
);

purchasingRouter.post('/orders/:id/cancel', validate({ params: s.idParam }), async (_req, res) => {
  res.json({ success: true, data: await purchasing.cancelPurchaseOrder(input<Id>(res, 'params').id) });
});
