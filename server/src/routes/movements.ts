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

movementRouter.get('/summary', async (_req, res) => {
  res.json({ success: true, data: await movements.getMovementSummary() });
});

movementRouter.get('/export-csv', async (_req, res) => {
  const csv = await movements.exportMovementsCsv();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="stock_movements_ledger.csv"');
  res.status(200).send(csv);
});
