import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { resetLoginThrottle } from '../services/auth.service';
import {
  OWNER_PASSWORD,
  bootstrapOwner,
  client,
  createTestSchema,
  dropTestSchema,
  firstDepartmentId,
  hasDatabase,
  loginAs,
} from './helpers';

const app = createApp();
let ownerToken: string;
let owner: ReturnType<typeof client>;
let deptId: number;

describe.skipIf(!hasDatabase)('auth and roles', () => {
  beforeAll(async () => {
    await createTestSchema();
  });
  afterAll(dropTestSchema);

  describe('first-run setup', () => {
    it('reports needs_setup until the first owner exists, then refuses a second setup', async () => {
      const before = await request(app).get('/api/auth/status');
      expect(before.body.data).toEqual({ needs_setup: true });

      const weak = await request(app)
        .post('/api/auth/setup')
        .send({ username: 'owner', password: 'short', display_name: 'Store Owner' });
      expect(weak.status).toBe(400);

      ownerToken = await bootstrapOwner(app);
      owner = client(app, ownerToken);
      deptId = await firstDepartmentId();

      const after = await request(app).get('/api/auth/status');
      expect(after.body.data).toEqual({ needs_setup: false });

      const again = await request(app)
        .post('/api/auth/setup')
        .send({ username: 'owner2', password: 'another-pass-123', display_name: 'Intruder' });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('ALREADY_SET_UP');
    });
  });

  describe('sign in', () => {
    it('returns the user and a token, and /me resolves it', async () => {
      const res = await request(app).post('/api/auth/login').send({ username: 'OWNER', password: OWNER_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.data.user).toMatchObject({ username: 'owner', role: 'OWNER', display_name: 'Store Owner' });
      expect(res.body.data.user.password_hash).toBeUndefined();
      expect(typeof res.body.data.token).toBe('string');
      expect(res.body.data.expires_at).toMatch(/Z$/);

      const me = await client(app, res.body.data.token).get('/api/auth/me');
      expect(me.status).toBe(200);
      expect(me.body.data.username).toBe('owner');
    });

    it('rejects wrong passwords and unknown users identically', async () => {
      const wrong = await request(app).post('/api/auth/login').send({ username: 'owner', password: 'nope-nope-nope' });
      expect(wrong.status).toBe(401);
      expect(wrong.body.code).toBe('INVALID_CREDENTIALS');

      const unknown = await request(app).post('/api/auth/login').send({ username: 'ghost', password: 'nope-nope-nope' });
      expect(unknown.status).toBe(401);
      expect(unknown.body.code).toBe('INVALID_CREDENTIALS');
      expect(unknown.body.error).toBe(wrong.body.error);
    });

    it('locks a username after five failures', async () => {
      resetLoginThrottle();
      for (let i = 0; i < 5; i++) {
        await request(app).post('/api/auth/login').send({ username: 'owner', password: 'wrong-wrong-wrong' });
      }
      const locked = await request(app).post('/api/auth/login').send({ username: 'owner', password: OWNER_PASSWORD });
      expect(locked.status).toBe(429);
      expect(locked.body.code).toBe('LOGIN_LOCKED');
      resetLoginThrottle();
    });

    it('requires a token on protected routes and rejects garbage tokens', async () => {
      const none = await request(app).get('/api/products');
      expect(none.status).toBe(401);
      expect(none.body.code).toBe('UNAUTHENTICATED');

      const bad = await client(app, 'not-a-real-token').get('/api/products');
      expect(bad.status).toBe(401);
      expect(bad.body.code).toBe('SESSION_EXPIRED');
    });

    it('logout revokes the token', async () => {
      const login = await request(app).post('/api/auth/login').send({ username: 'owner', password: OWNER_PASSWORD });
      const c = client(app, login.body.data.token);
      expect((await c.get('/api/auth/me')).status).toBe(200);
      expect((await c.post('/api/auth/logout')).status).toBe(200);
      expect((await c.get('/api/auth/me')).status).toBe(401);
    });
  });

  describe('roles', () => {
    let cashier: ReturnType<typeof client>;
    let manager: ReturnType<typeof client>;
    let cashierId: number;

    beforeAll(async () => {
      const c = await loginAs(app, ownerToken, 'CASHIER');
      cashier = client(app, c.token);
      cashierId = c.id;
      manager = client(app, (await loginAs(app, ownerToken, 'MANAGER')).token);
    });

    it('cashier can read the catalogue and sell, but not change stock or see the ledger', async () => {
      const product = await manager
        .post('/api/products')
        .send({ barcode: 'AUTH-1', name: 'Chips', department_id: deptId, price: 1.5, stock_quantity: 10 });
      expect(product.status).toBe(201);

      expect((await cashier.get('/api/products')).status).toBe(200);
      expect((await cashier.get('/api/settings')).status).toBe(200);

      const sale = await cashier
        .post('/api/sales/checkout')
        .send({ items: [{ product_id: product.body.data.id, quantity: 1 }], payment_method: 'CARD' });
      expect(sale.status).toBe(201);
      expect(sale.body.data.cashier_id).toBe(cashierId);

      const forbidden = await cashier
        .post('/api/products')
        .send({ barcode: 'AUTH-2', name: 'x', department_id: deptId, price: 1 });
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.code).toBe('FORBIDDEN');

      expect(
        (await cashier.post('/api/inventory/scan-adjust').send({ barcode: 'AUTH-1', change_quantity: 1, type: 'RESTOCK' })).status,
      ).toBe(403);
      expect((await cashier.get('/api/movements')).status).toBe(403);
      expect((await cashier.put('/api/settings').send({ tax_rate_percent: 0 })).status).toBe(403);
      expect((await cashier.get('/api/users')).status).toBe(403);
    });

    it('manager can manage stock and products but not settings or users', async () => {
      expect(
        (await manager.post('/api/inventory/scan-adjust').send({ barcode: 'AUTH-1', change_quantity: 2, type: 'RESTOCK' })).status,
      ).toBe(200);
      expect((await manager.get('/api/movements')).status).toBe(200);
      expect((await manager.put('/api/settings').send({ tax_rate_percent: 5 })).status).toBe(403);
      expect((await manager.get('/api/users')).status).toBe(403);
      expect(
        (await manager.post('/api/users').send({ username: 'x1', password: 'password-123', display_name: 'X', role: 'CASHIER' })).status,
      ).toBe(403);
    });

    it('owner can do everything', async () => {
      expect((await owner.put('/api/settings').send({ tax_rate_percent: 5 })).status).toBe(200);
      const list = await owner.get('/api/users');
      expect(list.status).toBe(200);
      expect(list.body.data.map((u: { role: string }) => u.role).sort()).toEqual(['CASHIER', 'MANAGER', 'OWNER']);
      expect(list.body.data.every((u: Record<string, unknown>) => !('password_hash' in u))).toBe(true);
    });
  });

  describe('user management', () => {
    it('validates usernames and refuses duplicates', async () => {
      const bad = await owner
        .post('/api/users')
        .send({ username: 'Bad Name!', password: 'password-123', display_name: 'B', role: 'CASHIER' });
      expect(bad.status).toBe(400);

      const dup = await owner
        .post('/api/users')
        .send({ username: 'owner', password: 'password-123', display_name: 'Dup', role: 'CASHIER' });
      expect(dup.status).toBe(409);
      expect(dup.body.error).toMatch(/username already exists/);
    });

    it('deactivating a user kills their session and blocks sign-in', async () => {
      const u = await loginAs(app, ownerToken, 'CASHIER');
      const c = client(app, u.token);
      expect((await c.get('/api/auth/me')).status).toBe(200);

      const off = await owner.put(`/api/users/${u.id}`).send({ is_active: false });
      expect(off.status).toBe(200);
      expect(off.body.data.is_active).toBe(false);

      expect((await c.get('/api/auth/me')).status).toBe(401);
      const login = await request(app)
        .post('/api/auth/login')
        .send({ username: u.username, password: `${u.username}-pass-123` });
      expect(login.status).toBe(401);
    });

    it('a role change takes effect immediately', async () => {
      const u = await loginAs(app, ownerToken, 'CASHIER');
      expect((await client(app, u.token).get('/api/movements')).status).toBe(403);

      await owner.put(`/api/users/${u.id}`).send({ role: 'MANAGER' });
      // Promotion revokes old sessions; sign in again with the new role.
      const login = await request(app)
        .post('/api/auth/login')
        .send({ username: u.username, password: `${u.username}-pass-123` });
      expect(login.body.data.user.role).toBe('MANAGER');
      expect((await client(app, login.body.data.token).get('/api/movements')).status).toBe(200);
    });

    it('protects the owner account from lockout', async () => {
      const me = await owner.get('/api/auth/me');
      const self = await owner.put(`/api/users/${me.body.data.id}`).send({ is_active: false });
      expect(self.status).toBe(400);
      expect(self.body.error).toMatch(/own account/);

      const demote = await owner.put(`/api/users/${me.body.data.id}`).send({ role: 'CASHIER' });
      expect(demote.status).toBe(400);
    });

    it('change-password verifies the current one and keeps this session alive', async () => {
      const u = await loginAs(app, ownerToken, 'CASHIER');
      const c = client(app, u.token);
      const otherLogin = await request(app)
        .post('/api/auth/login')
        .send({ username: u.username, password: `${u.username}-pass-123` });
      const other = client(app, otherLogin.body.data.token);

      const wrong = await c
        .post('/api/auth/change-password')
        .send({ current_password: 'nope-nope-nope', new_password: 'brand-new-pass-1' });
      expect(wrong.status).toBe(400);

      const ok = await c
        .post('/api/auth/change-password')
        .send({ current_password: `${u.username}-pass-123`, new_password: 'brand-new-pass-1' });
      expect(ok.status).toBe(200);

      expect((await c.get('/api/auth/me')).status).toBe(200); // this device stays signed in
      expect((await other.get('/api/auth/me')).status).toBe(401); // the other device is signed out

      const relogin = await request(app).post('/api/auth/login').send({ username: u.username, password: 'brand-new-pass-1' });
      expect(relogin.status).toBe(200);
    });
  });
});
