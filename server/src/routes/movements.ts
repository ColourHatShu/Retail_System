import { Router } from 'express';
import { MANAGER_UP, requireRole } from '../lib/authz';
import { input, validate } from '../lib/validate';
import * as s from '../schemas';
import * as movements from '../services/movements.service';

/** Mounted behind requireAuth. The audit ledger is manager or owner only. */
export const movementRouter = Router();

movementRouter.use(requireRole(...MANAGER_UP));

movementRouter.get('/', validate({ query: s.movementsQuery }), async (_req, res) => {
  res.json({ success: true, ...(await movements.listMovements(input<s.MovementsQuery>(res, 'query'))) });
});

/** Same filter as the list: the cards summarise the rows the user is looking at. */
movementRouter.get('/summary', validate({ query: s.movementsFilter }), async (_req, res) => {
  res.json({ success: true, data: await movements.getMovementSummary(input<s.MovementsFilter>(res, 'query')) });
});

movementRouter.get('/export-csv', validate({ query: s.movementsFilter }), async (_req, res) => {
  const csv = await movements.exportMovementsCsv(input<s.MovementsFilter>(res, 'query'));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="stock_movements_ledger.csv"');
  res.status(200).send(csv);
});
