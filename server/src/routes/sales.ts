import { Router } from 'express';
import { MANAGER_UP, actor, requireRole } from '../lib/authz';
import { input, validate } from '../lib/validate';
import * as s from '../schemas';
import * as returns from '../services/returns.service';
import * as sales from '../services/sales.service';

/** Mounted behind requireAuth. Every role can sell and see sales; voiding is manager or owner. */
export const salesRouter = Router();

salesRouter.get('/', validate({ query: s.salesListQuery }), async (_req, res) => {
  const { limit, offset } = input<{ limit: number; offset: number }>(res, 'query');
  res.json({ success: true, ...(await sales.listSales(limit, offset)) });
});

/** Receipt lookup (scan or type the number on the printed receipt). Declared before '/:id'. */
salesRouter.get('/receipt/:receipt_number', validate({ params: s.receiptParam }), async (_req, res) => {
  const { receipt_number } = input<{ receipt_number: string }>(res, 'params');
  res.json({ success: true, data: await sales.getSaleByReceipt(receipt_number) });
});

salesRouter.get('/:id', validate({ params: s.idParam }), async (_req, res) => {
  const { id } = input<{ id: number }>(res, 'params');
  res.json({ success: true, data: await sales.getSale(id) });
});

salesRouter.get('/:id/returns', validate({ params: s.idParam }), async (_req, res) => {
  const { id } = input<{ id: number }>(res, 'params');
  res.json({ success: true, data: await returns.returnsForSale(id) });
});

/** POS checkout. Totals are recomputed server-side; the signed-in user is the cashier of record. */
salesRouter.post('/checkout', validate({ body: s.checkout }), async (_req, res) => {
  res
    .status(201)
    .json({ success: true, data: await sales.checkout(input<s.CheckoutInput>(res, 'body'), actor(res)) });
});

/** Reverse a whole receipt (same day, nothing returned yet). */
salesRouter.post(
  '/:id/void',
  requireRole(...MANAGER_UP),
  validate({ params: s.idParam, body: s.voidSale }),
  async (_req, res) => {
    const { id } = input<{ id: number }>(res, 'params');
    const { reason } = input<s.VoidSale>(res, 'body');
    res.status(201).json({ success: true, data: await returns.voidSale(id, reason, actor(res)) });
  },
);
