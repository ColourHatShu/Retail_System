import { Router } from 'express';
import { OWNER_ONLY, actor, requireRole } from '../lib/authz';
import { input, validate } from '../lib/validate';
import * as s from '../schemas';
import * as users from '../services/users.service';

/** Staff management. Mounted behind requireAuth; every route is owner-only. */
export const usersRouter = Router();

usersRouter.use(requireRole(...OWNER_ONLY));

usersRouter.get('/', async (_req, res) => {
  res.json({ success: true, data: await users.listUsers() });
});

usersRouter.post('/', validate({ body: s.userCreate }), async (_req, res) => {
  res.status(201).json({ success: true, data: await users.createUser(input<s.UserCreate>(res, 'body')) });
});

usersRouter.put('/:id', validate({ params: s.idParam, body: s.userUpdate }), async (_req, res) => {
  const { id } = input<{ id: number }>(res, 'params');
  res.json({ success: true, data: await users.updateUser(id, input<s.UserUpdate>(res, 'body'), actor(res)) });
});
