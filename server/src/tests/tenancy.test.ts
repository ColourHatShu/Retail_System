import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { getPool } from '../db';
import { bootstrapOwner, client, createTestSchema, dropTestSchema, firstDepartmentId, hasDatabase } from './helpers';

/**
 * Multi-seller isolation and the platform administrator.
 *
 * The property under test is simple to state and easy to get wrong: a seller
 * can never see, touch, or be counted with another seller's rows — enforced by
 * the database, not by a WHERE clause someone remembered.
 */
describe.skipIf(!hasDatabase)('multi-tenant isolation and platform admin', { timeout: 120_000 }, () => {
  const app = createApp();
  const api = request(app);

  let ownerOneToken: string;
  let adminToken: string;
  let tenantTwoId: number;
  let ownerTwoToken: string;
  let productOneId: number;
  let productTwoId: number;

  const ADMIN = { username: 'admin', password: 'admin-pass-123', display_name: 'Platform Admin' };
  const SHOP_TWO = {
    slug: 'corner-shop',
    name: 'Corner Shop',
    owner_username: 'jane',
    owner_display_name: 'Jane',
    owner_password: 'jane-pass-123',
  };

  beforeAll(async () => {
    await createTestSchema();
    ownerOneToken = await bootstrapOwner(app);
  });
  afterAll(dropTestSchema);

  // ---------------------------------------------------------------- admin

  it('has a one-time admin setup, then refuses a second', async () => {
    expect((await api.get('/api/admin/status')).body.data).toEqual({ needs_setup: true });

    const setup = await api.post('/api/admin/setup').send(ADMIN);
    expect(setup.status).toBe(201);
    adminToken = setup.body.data.token;
    expect(setup.body.data.admin.username).toBe('admin');
    expect(setup.body.data.admin).not.toHaveProperty('password_hash');

    const again = await api.post('/api/admin/setup').send({ ...ADMIN, username: 'admin2' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_SET_UP');
  });

  it('keeps the admin token off tenant routes and the owner token off admin routes', async () => {
    // An admin who has not switched into a store is not a store user.
    expect((await client(app, adminToken).get('/api/products')).status).toBe(401);
    // A store owner, however senior, is not a platform admin.
    expect((await client(app, ownerOneToken).get('/api/admin/tenants')).status).toBe(401);
  });

  it('provisions a seller in one step: tenant, owner, departments, settings', async () => {
    const created = await client(app, adminToken).post('/api/admin/tenants').send(SHOP_TWO);
    expect(created.status).toBe(201);
    tenantTwoId = created.body.data.id;
    expect(created.body.data).toMatchObject({ slug: 'corner-shop', name: 'Corner Shop', is_active: true });
    expect(created.body.data.owner_username).toBe('jane');

    const login = await api.post('/api/auth/login').send({ username: 'jane', password: SHOP_TWO.owner_password });
    expect(login.status).toBe(200);
    expect(login.body.data.user.tenant_id).toBe(tenantTwoId);
    ownerTwoToken = login.body.data.token;

    // The new seller got the six standard departments and its own store name.
    const depts = await client(app, ownerTwoToken).get('/api/departments');
    expect(depts.body.data.map((d: { code: string }) => d.code).sort()).toEqual([
      'BAKE', 'BEV', 'CARE', 'DAIRY', 'ELEC', 'GROC',
    ]);
    const settings = await client(app, ownerTwoToken).get('/api/settings');
    expect(settings.body.data.store_name).toBe('Corner Shop');
    expect(settings.body.data.currency).toBe('CAD');
  });

  // ---------------------------------------------------------------- isolation

  it('keeps each seller blind to the other', async () => {
    const deptOne = await firstDepartmentId();
    const p1 = await client(app, ownerOneToken)
      .post('/api/products')
      .send({ barcode: 'ISO-1', name: 'Tenant One Cola', department_id: deptOne, price: 2, stock_quantity: 5 });
    expect(p1.status).toBe(201);
    productOneId = p1.body.data.id;

    const deptTwo = (await client(app, ownerTwoToken).get('/api/departments')).body.data[0].id;
    const p2 = await client(app, ownerTwoToken)
      .post('/api/products')
      .send({ barcode: 'ISO-2', name: 'Tenant Two Tea', department_id: deptTwo, price: 3, stock_quantity: 5 });
    expect(p2.status).toBe(201);
    productTwoId = p2.body.data.id;

    const seenByOne = (await client(app, ownerOneToken).get('/api/products')).body.data.map(
      (p: { name: string }) => p.name,
    );
    const seenByTwo = (await client(app, ownerTwoToken).get('/api/products')).body.data.map(
      (p: { name: string }) => p.name,
    );
    expect(seenByOne).toContain('Tenant One Cola');
    expect(seenByOne).not.toContain('Tenant Two Tea');
    expect(seenByTwo).toContain('Tenant Two Tea');
    expect(seenByTwo).not.toContain('Tenant One Cola');

    // Reaching across by id is a 404, not a 403: as far as this seller is
    // concerned the other row does not exist.
    expect((await client(app, ownerOneToken).get(`/api/products/${productTwoId}`)).status).toBe(404);
    expect((await client(app, ownerTwoToken).get(`/api/products/${productOneId}`)).status).toBe(404);
    expect(
      (await client(app, ownerOneToken).put(`/api/products/${productTwoId}`).send({ name: 'hijacked' })).status,
    ).toBe(404);

    // Nor can a seller write into the other's space by naming its department.
    const crossDept = await client(app, ownerTwoToken)
      .post('/api/products')
      .send({ barcode: 'ISO-3', name: 'Smuggled', department_id: deptOne, price: 1 });
    expect(crossDept.status).toBe(400);
  });

  it('lets two sellers use the same barcode, username and department code', async () => {
    const deptTwo = (await client(app, ownerTwoToken).get('/api/departments')).body.data[0].id;
    // Same barcode as tenant one's product: fine, uniqueness is per seller.
    const dup = await client(app, ownerTwoToken)
      .post('/api/products')
      .send({ barcode: 'ISO-1', name: 'Same Barcode Elsewhere', department_id: deptTwo, price: 1 });
    expect(dup.status).toBe(201);

    // Same username as tenant one's owner. Signing in then needs a store code.
    const twin = await client(app, ownerTwoToken)
      .post('/api/users')
      .send({ username: 'owner', password: 'twin-pass-123', display_name: 'Twin', role: 'CASHIER' });
    expect(twin.status).toBe(201);

    const ambiguous = await api.post('/api/auth/login').send({ username: 'owner', password: 'twin-pass-123' });
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.code).toBe('TENANT_REQUIRED');
    expect(ambiguous.body.details.stores.sort()).toEqual(['corner-shop', 'default']);

    const resolved = await api
      .post('/api/auth/login')
      .send({ username: 'owner', password: 'twin-pass-123', tenant: 'corner-shop' });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data.user.tenant_id).toBe(tenantTwoId);
  });

  it('fails closed: a transaction that declares no tenant sees nothing', async () => {
    // The test pool carries a connection-level default of tenant 1. Clear it
    // for one transaction and prove the policy admits zero rows, not all rows.
    const c = await getPool().connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE pos_app');
      await c.query("SELECT set_config('app.tenant_id', '', true)");
      const unscoped = await c.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM products');
      expect(unscoped.rows[0].n).toBe(0);

      // And on the insert side: with no declared tenant the row has no home.
      // The policy's WITH CHECK refuses it (42501) before the NOT NULL on
      // tenant_id (23502) is even consulted. Either way the row has no home.
      await expect(c.query("INSERT INTO departments (name, code) VALUES ('Orphan', 'ORPH')")).rejects.toMatchObject({
        code: '42501', // insufficient_privilege: new row violates row-level security
      });
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }

    // Declaring tenant two inside a transaction sees exactly tenant two's rows.
    const d = await getPool().connect();
    try {
      await d.query('BEGIN');
      await d.query('SET LOCAL ROLE pos_app');
      await d.query("SELECT set_config('app.tenant_id', $1, true)", [String(tenantTwoId)]);
      const scoped = await d.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM products');
      expect(scoped.rows[0].n).toBe(2); // Tenant Two Tea + Same Barcode Elsewhere
      await d.query('COMMIT');
    } finally {
      d.release();
    }
  });

  // ---------------------------------------------------------------- impersonation

  it('lets an admin switch into a seller to look, but not to move money', async () => {
    const switched = await client(app, adminToken).post(`/api/admin/impersonate/${tenantTwoId}`);
    expect(switched.status).toBe(200);
    expect(switched.body.data.acting_tenant.slug).toBe('corner-shop');

    // The same admin token now reads tenant two's data — and only tenant two's.
    const asJane = client(app, adminToken);
    const products = await asJane.get('/api/products');
    expect(products.status).toBe(200);
    const names = products.body.data.map((p: { name: string }) => p.name);
    expect(names).toContain('Tenant Two Tea');
    expect(names).not.toContain('Tenant One Cola');

    // Reading sales is fine. Ringing one is not.
    expect((await asJane.get('/api/sales')).status).toBe(200);
    const checkout = await asJane
      .post('/api/sales/checkout')
      .send({ items: [{ product_id: productTwoId, quantity: 1 }], payment_method: 'CARD' });
    expect(checkout.status).toBe(403);
    expect(checkout.body.code).toBe('IMPERSONATION_FORBIDDEN');

    const adjust = await asJane
      .post('/api/inventory/scan-adjust')
      .send({ barcode: 'ISO-2', change_quantity: 1, type: 'RESTOCK' });
    expect(adjust.status).toBe(403);

    // A catalogue fix is allowed — and is written to the audit log against the admin.
    const rename = await asJane.put(`/api/products/${productTwoId}`).send({ name: 'Tenant Two Tea (fixed)' });
    expect(rename.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200)); // the log is written on response finish

    const actions = await client(app, adminToken).get('/api/admin/actions');
    const kinds = actions.body.data.map((a: { action: string }) => a.action);
    expect(kinds).toContain('IMPERSONATION_STARTED');
    expect(kinds).toContain('IMPERSONATED_WRITE');
    const write = actions.body.data.find((a: { action: string }) => a.action === 'IMPERSONATED_WRITE');
    expect(write.tenant_id).toBe(tenantTwoId);
    expect(write.details).toMatchObject({ method: 'PUT', status: 200 });

    const stopped = await client(app, adminToken).post('/api/admin/impersonate/stop');
    expect(stopped.status).toBe(200);
    expect((await client(app, adminToken).get('/api/products')).status).toBe(401);
  });

  // ---------------------------------------------------------------- lifecycle

  it('deactivates a seller without deleting anything, and signs its staff out at once', async () => {
    expect((await client(app, ownerTwoToken).get('/api/products')).status).toBe(200);

    const off = await client(app, adminToken).post(`/api/admin/tenants/${tenantTwoId}/deactivate`);
    expect(off.status).toBe(200);
    expect(off.body.data.is_active).toBe(false);

    // Existing session: dead. Fresh login: refused with a reason. Rows: untouched.
    expect((await client(app, ownerTwoToken).get('/api/products')).status).toBe(401);
    const login = await api.post('/api/auth/login').send({ username: 'jane', password: SHOP_TWO.owner_password });
    expect(login.status).toBe(403);
    expect(login.body.code).toBe('TENANT_INACTIVE');
    const still = await getPool().query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM products WHERE tenant_id = $1',
      [tenantTwoId],
    );
    // The test pool is scoped to tenant 1, so count via a bypass-free tenant-two transaction.
    const e = await getPool().connect();
    try {
      await e.query('BEGIN');
      await e.query('SET LOCAL ROLE pos_app');
      await e.query("SELECT set_config('app.tenant_id', $1, true)", [String(tenantTwoId)]);
      const n = await e.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM products');
      expect(n.rows[0].n).toBe(2);
      await e.query('COMMIT');
    } finally {
      e.release();
    }
    void still;

    // Cannot switch into a deactivated seller either.
    expect((await client(app, adminToken).post(`/api/admin/impersonate/${tenantTwoId}`)).status).toBe(400);

    const on = await client(app, adminToken).post(`/api/admin/tenants/${tenantTwoId}/reactivate`);
    expect(on.body.data.is_active).toBe(true);
    expect(
      (await api.post('/api/auth/login').send({ username: 'jane', password: SHOP_TWO.owner_password })).status,
    ).toBe(200);
  });

  it('lists sellers with counts, and records every admin action', async () => {
    const list = await client(app, adminToken).get('/api/admin/tenants');
    expect(list.status).toBe(200);
    const two = list.body.data.find((t: { id: number }) => t.id === tenantTwoId);
    expect(two).toMatchObject({ slug: 'corner-shop', owner_username: 'jane', product_count: 2, sale_count: 0 });
    expect(two.user_count).toBe(2); // jane + the 'owner' cashier twin

    const kinds = (await client(app, adminToken).get('/api/admin/actions')).body.data.map(
      (a: { action: string }) => a.action,
    );
    for (const expected of [
      'ADMIN_SETUP',
      'TENANT_CREATED',
      'IMPERSONATION_STARTED',
      'IMPERSONATED_WRITE',
      'IMPERSONATION_STOPPED',
      'TENANT_DEACTIVATED',
      'TENANT_REACTIVATED',
    ]) {
      expect(kinds).toContain(expected);
    }
  });
});
