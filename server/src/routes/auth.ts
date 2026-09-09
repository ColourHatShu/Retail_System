import { Router } from 'express';
import { actor, currentTokenHash, requireAuth } from '../lib/authz';
import { input, validate } from '../lib/validate';
import * as s from '../schemas';
import * as auth from '../services/auth.service';

export const authRouter = Router();

/** Public: does the store still need its first owner account? */
authRouter.get('/status', async (_req, res) => {
  res.json({ success: true, data: await auth.authStatus() });
});

/** Public, one-shot: create the first OWNER. Refused once any user exists. */
authRouter.post('/setup', validate({ body: s.authSetup }), async (req, res) => {
  res
    .status(201)
    .json({ success: true, data: await auth.setupOwner(input<s.AuthSetup>(res, 'body'), req.ip ?? null) });
});

authRouter.post('/login', validate({ body: s.authLogin }), async (req, res) => {
  res.json({ success: true, data: await auth.login(input<s.AuthLogin>(res, 'body'), req.ip ?? null) });
});

authRouter.post('/logout', requireAuth, async (_req, res) => {
  await auth.logout(currentTokenHash(res));
  res.json({ success: true, message: 'Signed out' });
});

authRouter.get('/me', requireAuth, (_req, res) => {
  res.json({ success: true, data: actor(res) });
});

authRouter.post('/change-password', requireAuth, validate({ body: s.changePassword }), async (_req, res) => {
  await auth.changePassword(actor(res), input<s.ChangePassword>(res, 'body'), currentTokenHash(res));
  res.json({ success: true, message: 'Password changed' });
});
