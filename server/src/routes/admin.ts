import { Router } from 'express';
import type { Response } from 'express';
import { clientIp, currentTokenHash, requireAdmin } from '../lib/authz';
import { input, validate } from '../lib/validate';
import * as s from '../schemas';
import * as admin from '../services/admin.service';
import type { AdminSessionRow, PlatformAdmin, TenantRow } from '../types';

/**
 * The platform administrator's own API. Manages its own authentication:
 * status, setup and login are public; everything else sits behind
 * requireAdmin, which runs the request with row-level security bypassed.
 */
export const adminRouter = Router();

const who = (res: Response) => res.locals.admin as PlatformAdmin;
const session = (res: Response) => res.locals.adminSession as AdminSessionRow;
const actingTenant = (res: Response) => (res.locals.actingTenant as TenantRow | null) ?? null;

// ---- public --------------------------------------------------------------

adminRouter.get('/status', async (_req, res) => {
  res.json({ success: true, data: await admin.adminStatus() });
});

adminRouter.post('/setup', validate({ body: s.adminSetup }), async (req, res) => {
  res
    .status(201)
    .json({ success: true, data: await admin.setupAdmin(input<s.AdminSetup>(res, 'body'), clientIp(req)) });
});

adminRouter.post('/login', validate({ body: s.adminLogin }), async (req, res) => {
  res.json({ success: true, data: await admin.adminLogin(input<s.AdminLogin>(res, 'body'), clientIp(req)) });
});

// ---- authenticated -------------------------------------------------------

adminRouter.use(requireAdmin);

adminRouter.get('/me', (_req, res) => {
  res.json({ success: true, data: { admin: who(res), acting_tenant: actingTenant(res) } });
});

adminRouter.post('/logout', async (_req, res) => {
  await admin.adminLogout(currentTokenHash(res));
  res.json({ success: true, message: 'Signed out' });
});

// ---- tenants -------------------------------------------------------------

adminRouter.get('/tenants', async (_req, res) => {
  res.json({ success: true, data: await admin.listTenants() });
});

adminRouter.post('/tenants', validate({ body: s.tenantCreate }), async (req, res) => {
  res.status(201).json({
    success: true,
    data: await admin.createTenant(input<s.TenantCreate>(res, 'body'), who(res), clientIp(req)),
  });
});

adminRouter.get('/tenants/:id', validate({ params: s.idParam }), async (_req, res) => {
  const { id } = input<{ id: number }>(res, 'params');
  res.json({ success: true, data: await admin.getTenant(id) });
});

adminRouter.put('/tenants/:id', validate({ params: s.idParam, body: s.tenantUpdate }), async (req, res) => {
  const { id } = input<{ id: number }>(res, 'params');
  res.json({
    success: true,
    data: await admin.updateTenant(id, input<s.TenantUpdate>(res, 'body'), who(res), clientIp(req)),
  });
});

adminRouter.post('/tenants/:id/deactivate', validate({ params: s.idParam }), async (req, res) => {
  const { id } = input<{ id: number }>(res, 'params');
  res.json({ success: true, data: await admin.setTenantActive(id, false, who(res), clientIp(req)) });
});

adminRouter.post('/tenants/:id/reactivate', validate({ params: s.idParam }), async (req, res) => {
  const { id } = input<{ id: number }>(res, 'params');
  res.json({ success: true, data: await admin.setTenantActive(id, true, who(res), clientIp(req)) });
});

adminRouter.post(
  '/tenants/:id/reset-owner-password',
  validate({ params: s.idParam, body: s.ownerPasswordReset }),
  async (req, res) => {
    const { id } = input<{ id: number }>(res, 'params');
    const { new_password } = input<s.OwnerPasswordReset>(res, 'body');
    res.json({
      success: true,
      data: await admin.resetTenantOwnerPassword(id, new_password, who(res), clientIp(req)),
    });
  },
);

// ---- switching into a seller --------------------------------------------

// Declared before '/impersonate/:id' so "stop" is never parsed as an id.
adminRouter.post('/impersonate/stop', async (req, res) => {
  await admin.stopImpersonation(session(res), who(res), clientIp(req));
  res.json({ success: true, data: { acting_tenant: null } });
});

adminRouter.post('/impersonate/:id', validate({ params: s.idParam }), async (req, res) => {
  const { id } = input<{ id: number }>(res, 'params');
  const tenant = await admin.startImpersonation(session(res), who(res), id, clientIp(req));
  res.json({ success: true, data: { acting_tenant: tenant } });
});

// ---- audit ---------------------------------------------------------------

adminRouter.get('/actions', validate({ query: s.adminActionsQuery }), async (_req, res) => {
  const q = input<s.AdminActionsQuery>(res, 'query');
  res.json({ success: true, data: await admin.listAdminActions(q.limit, q.tenant_id) });
});
