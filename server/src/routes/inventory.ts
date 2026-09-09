import { Router } from 'express';
import { MANAGER_UP, actor, requireRole } from '../lib/authz';
import { input, validate } from '../lib/validate';
import * as s from '../schemas';
import * as inventory from '../services/inventory.service';

/** Mounted behind requireAuth. Stock changes are manager or owner only. */
export const inventoryRouter = Router();

inventoryRouter.use(requireRole(...MANAGER_UP));

/** Barcode-driven stock in / stock out. */
inventoryRouter.post('/scan-adjust', validate({ body: s.scanAdjust }), async (_req, res) => {
  res.json({
    success: true,
    data: await inventory.adjustStockByBarcode(input<s.ScanAdjust>(res, 'body'), actor(res)),
  });
});

/** Physical cycle count: set the absolute quantity. */
inventoryRouter.post('/set-count', validate({ body: s.setCount }), async (_req, res) => {
  res.json({ success: true, data: await inventory.setPhysicalCount(input<s.SetCount>(res, 'body'), actor(res)) });
});

/** Bulk spreadsheet import (upsert by barcode). */
inventoryRouter.post('/import-batch', validate({ body: s.importBatch }), async (_req, res) => {
  const { items } = input<s.ImportBatch>(res, 'body');
  res.json({ success: true, data: await inventory.importProductsBatch(items, actor(res)) });
});
