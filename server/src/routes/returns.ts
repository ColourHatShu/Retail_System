import { Router } from 'express';
import { actor } from '../lib/authz';
import { input, validate } from '../lib/validate';
import * as s from '../schemas';
import * as returns from '../services/returns.service';

/**
 * Mounted behind requireAuth. Every role may look up and process returns;
 * the service enforces the approval threshold and the return window.
 */
export const returnsRouter = Router();

returnsRouter.get('/', validate({ query: s.salesListQuery }), async (_req, res) => {
  const { limit, offset } = input<{ limit: number; offset: number }>(res, 'query');
  res.json({ success: true, ...(await returns.listReturns(limit, offset)) });
});

returnsRouter.get('/:id', validate({ params: s.idParam }), async (_req, res) => {
  const { id } = input<{ id: number }>(res, 'params');
  res.json({ success: true, data: await returns.getReturn(id) });
});

/** Dry run: refund amount and whether the signed-in user may process it. */
returnsRouter.post('/quote', validate({ body: s.returnCreate }), async (_req, res) => {
  res.json({ success: true, data: await returns.quoteReturn(input<s.ReturnCreate>(res, 'body'), actor(res)) });
});

returnsRouter.post('/', validate({ body: s.returnCreate }), async (_req, res) => {
  res
    .status(201)
    .json({ success: true, data: await returns.processReturn(input<s.ReturnCreate>(res, 'body'), actor(res)) });
});
