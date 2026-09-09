import { Router } from 'express';
import { OWNER_ONLY, requireRole } from '../lib/authz';
import { input, validate } from '../lib/validate';
import * as s from '../schemas';
import * as settings from '../services/settings.service';

/** Mounted behind requireAuth. Anyone may read; only the owner may change tax or currency. */
export const settingsRouter = Router();

settingsRouter.get('/', async (_req, res) => {
  res.json({ success: true, data: await settings.getSettingsApi() });
});

settingsRouter.put('/', requireRole(...OWNER_ONLY), validate({ body: s.settingsUpdate }), async (_req, res) => {
  res.json({ success: true, data: await settings.updateSettings(input<s.SettingsUpdate>(res, 'body')) });
});
