import cors from 'cors';
import express from 'express';
import { requireAuth } from './lib/authz';
import { errorHandler, notFoundHandler } from './lib/errors';
import { authRouter } from './routes/auth';
import { departmentRouter } from './routes/departments';
import { inventoryRouter } from './routes/inventory';
import { movementRouter } from './routes/movements';
import { productRouter } from './routes/products';
import { returnsRouter } from './routes/returns';
import { salesRouter } from './routes/sales';
import { settingsRouter } from './routes/settings';
import { usersRouter } from './routes/users';

/** Builds the Express app without listening, so tests can drive it in-process. */
export function createApp() {
  const app = express();

  // Behind a reverse proxy (Render, Railway, nginx) the client IP is in X-Forwarded-For.
  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

  app.use(cors());
  app.use(express.json({ limit: '5mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', system: 'Retail POS & Inventory System', timestamp: new Date().toISOString() });
  });

  // Public: first-run setup, sign in.
  app.use('/api/auth', authRouter);

  // Everything else requires a signed-in user; roles are enforced per route.
  app.use('/api/users', requireAuth, usersRouter);
  app.use('/api/departments', requireAuth, departmentRouter);
  app.use('/api/products', requireAuth, productRouter);
  app.use('/api/inventory', requireAuth, inventoryRouter);
  app.use('/api/sales', requireAuth, salesRouter);
  app.use('/api/returns', requireAuth, returnsRouter);
  app.use('/api/movements', requireAuth, movementRouter);
  app.use('/api/settings', requireAuth, settingsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
