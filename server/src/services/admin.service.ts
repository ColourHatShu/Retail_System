import { currentDb, row, rows, seedDefaultDepartments, withTransaction } from '../db';
import type { Queryable } from '../db';
import { DUMMY_HASH_PROMISE, generateSessionToken, hashPassword, hashToken, verifyPassword } from '../lib/auth';
import { AppError, badRequest, notFound } from '../lib/errors';
import { asTenant, withBypass } from '../lib/tenant';
import type {
  AdminAction,
  AdminSessionRow,
  AuthUser,
  PlatformAdmin,
  PlatformAdminRow,
  Tenant,
  TenantRow,
  UserRow,
} from '../types';
import { invalidateSessionCache, serializeUser } from './auth.service';

/**
 * The platform administrator: the one person who runs the service that the
 * sellers use. Not a tenant user, not a fourth role — a separate principal
 * with its own table, its own sessions and its own audit log, so nothing here
 * can disturb the per-shop OWNER > MANAGER > CASHIER hierarchy or its
 * invariants.
 *
 * Everything in this file runs with row-level security bypassed, because the
 * admin's whole job is to see across tenants. That is the one place in the
 * codebase where that is true, and it is why every action is written to
 * admin_actions.
 */

const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // shorter than a till session
const ADMIN_SETUP_LOCK_KEY = 7_303_293;

export interface AdminSessionResult {
  admin: PlatformAdmin;
  token: string;
  expires_at: string;
  acting_tenant: TenantRow | null;
}

export function serializeAdmin(r: PlatformAdminRow): PlatformAdmin {
  return {
    id: r.id,
    username: r.username,
    display_name: r.display_name,
    is_active: r.is_active,
    created_at: r.created_at,
    last_login_at: r.last_login_at,
  };
}

// ---------------------------------------------------------------- audit

export async function logAdminAction(
  db: Queryable,
  entry: { admin_id: number; action: string; tenant_id?: number | null; details?: unknown; ip?: string | null },
): Promise<void> {
  await db.query('INSERT INTO admin_actions (admin_id, action, tenant_id, details, ip) VALUES ($1, $2, $3, $4, $5)', [
    entry.admin_id,
    entry.action,
    entry.tenant_id ?? null,
    entry.details ? JSON.stringify(entry.details) : null,
    entry.ip ?? null,
  ]);
}

export async function listAdminActions(limit = 100, tenantId?: number): Promise<AdminAction[]> {
  return withBypass(() =>
    rows<AdminAction>(
      currentDb(),
      `SELECT a.*, p.username AS admin_username, t.name AS tenant_name
         FROM admin_actions a
         JOIN platform_admins p ON p.id = a.admin_id
         LEFT JOIN tenants t ON t.id = a.tenant_id
        WHERE ($2::bigint IS NULL OR a.tenant_id = $2)
        ORDER BY a.created_at DESC
        LIMIT $1`,
      [limit, tenantId ?? null],
    ),
  );
}

// ---------------------------------------------------------------- sessions

async function createAdminSession(
  tx: Queryable,
  adminId: number,
  ip: string | null,
): Promise<{ token: string; expires_at: string }> {
  const { token, tokenHash } = generateSessionToken();
  const expires = new Date(Date.now() + ADMIN_SESSION_TTL_MS);
  await tx.query('INSERT INTO admin_sessions (admin_id, token_hash, expires_at, ip) VALUES ($1, $2, $3, $4)', [
    adminId,
    tokenHash,
    expires.toISOString(),
    ip,
  ]);
  return { token, expires_at: expires.toISOString() };
}

/** True while no platform admin exists — the one-time admin setup wall. */
export async function adminStatus(): Promise<{ needs_setup: boolean }> {
  return withBypass(async () => {
    const { count } = (await row<{ count: number }>(currentDb(), 'SELECT COUNT(*) AS count FROM platform_admins'))!;
    return { needs_setup: count === 0 };
  });
}

/** Creates the first platform admin. Refused once any admin exists. */
export async function setupAdmin(
  input: { username: string; password: string; display_name: string },
  ip: string | null,
): Promise<AdminSessionResult> {
  return withBypass(() =>
    withTransaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_SETUP_LOCK_KEY]);
      const { count } = (await row<{ count: number }>(tx, 'SELECT COUNT(*) AS count FROM platform_admins'))!;
      if (count > 0) {
        throw new AppError(409, 'ALREADY_SET_UP', 'A platform administrator already exists. Sign in instead.');
      }
      const admin = (await row<PlatformAdminRow>(
        tx,
        `INSERT INTO platform_admins (username, display_name, password_hash, last_login_at)
         VALUES ($1, $2, $3, now()) RETURNING *`,
        [input.username, input.display_name, await hashPassword(input.password)],
      ))!;
      await logAdminAction(tx, { admin_id: admin.id, action: 'ADMIN_SETUP', ip });
      const session = await createAdminSession(tx, admin.id, ip);
      return { admin: serializeAdmin(admin), ...session, acting_tenant: null };
    }),
  );
}

export async function adminLogin(
  input: { username: string; password: string },
  ip: string | null,
): Promise<AdminSessionResult> {
  const admin = await withBypass(() =>
    row<PlatformAdminRow>(currentDb(), 'SELECT * FROM platform_admins WHERE username = $1', [input.username]),
  );
  const ok = admin
    ? await verifyPassword(input.password, admin.password_hash)
    : await verifyPassword(input.password, await DUMMY_HASH_PROMISE);
  if (!admin || !ok || !admin.is_active) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect username or password');
  }

  return withBypass(() =>
    withTransaction(async (tx) => {
      await tx.query('UPDATE platform_admins SET last_login_at = now() WHERE id = $1', [admin.id]);
      await logAdminAction(tx, { admin_id: admin.id, action: 'ADMIN_LOGIN', ip });
      const session = await createAdminSession(tx, admin.id, ip);
      return { admin: serializeAdmin(admin), ...session, acting_tenant: null };
    }),
  );
}

export interface ResolvedAdminSession {
  admin: PlatformAdmin;
  session: AdminSessionRow;
  acting_tenant: TenantRow | null;
}

/** Resolve an admin bearer token, or null. Sees across tenants by nature. */
export async function authenticateAdmin(token: string): Promise<ResolvedAdminSession | null> {
  const tokenHash = hashToken(token);
  return withBypass(async () => {
    const found = await row<PlatformAdminRow & { session: AdminSessionRow }>(
      currentDb(),
      `SELECT p.*, row_to_json(s.*) AS session
         FROM admin_sessions s
         JOIN platform_admins p ON p.id = s.admin_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND p.is_active`,
      [tokenHash],
    );
    if (!found) return null;

    const acting_tenant = found.session.acting_tenant_id
      ? ((await row<TenantRow>(currentDb(), 'SELECT * FROM tenants WHERE id = $1 AND is_active', [
          found.session.acting_tenant_id,
        ])) ?? null)
      : null;

    return { admin: serializeAdmin(found), session: found.session, acting_tenant };
  });
}

export async function adminLogout(tokenHash: string): Promise<void> {
  await withBypass(() =>
    currentDb().query('UPDATE admin_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [
      tokenHash,
    ]),
  );
}

// ---------------------------------------------------------------- tenants

export async function listTenants(): Promise<Tenant[]> {
  return withBypass(() =>
    rows<Tenant>(
      currentDb(),
      `SELECT t.*,
              (SELECT u.username FROM users u WHERE u.tenant_id = t.id AND u.role = 'OWNER' ORDER BY u.id LIMIT 1) AS owner_username,
              (SELECT COUNT(*)::int FROM users u WHERE u.tenant_id = t.id AND u.is_active)    AS user_count,
              (SELECT COUNT(*)::int FROM products p WHERE p.tenant_id = t.id AND p.is_active) AS product_count,
              (SELECT COUNT(*)::int FROM sales s WHERE s.tenant_id = t.id)                    AS sale_count,
              (SELECT MAX(s.created_at) FROM sales s WHERE s.tenant_id = t.id)                AS last_sale_at
         FROM tenants t
        ORDER BY t.created_at`,
    ),
  );
}

export async function getTenant(id: number): Promise<Tenant> {
  const found = (await listTenants()).find((t) => t.id === id);
  if (!found) throw notFound(`Store ${id} not found`);
  return found;
}

export interface CreateTenantInput {
  slug: string;
  name: string;
  owner_username: string;
  owner_display_name: string;
  owner_password: string;
  currency?: string;
}

/**
 * Provisions a seller in one step: the tenant row, its first OWNER, the six
 * standard departments and its own settings. The departments are seeded as
 * that tenant so row-level security stamps every row correctly.
 */
export async function createTenant(input: CreateTenantInput, admin: PlatformAdmin, ip: string | null): Promise<Tenant> {
  const tenant = await withBypass(() =>
    withTransaction(async (tx) => {
      const t = (await row<TenantRow>(tx, 'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING *', [
        input.slug,
        input.name,
      ]))!;
      await tx.query(
        `INSERT INTO users (tenant_id, username, display_name, password_hash, role)
         VALUES ($1, $2, $3, $4, 'OWNER')`,
        [t.id, input.owner_username, input.owner_display_name, await hashPassword(input.owner_password)],
      );
      await tx.query(
        `INSERT INTO settings (tenant_id, key, value) VALUES
           ($1, 'store_name', $2), ($1, 'currency', $3)
         ON CONFLICT DO NOTHING`,
        [t.id, input.name, (input.currency ?? 'CAD').toUpperCase()],
      );
      await logAdminAction(tx, {
        admin_id: admin.id,
        action: 'TENANT_CREATED',
        tenant_id: t.id,
        details: { slug: t.slug, name: t.name, owner_username: input.owner_username },
        ip,
      });
      return t;
    }),
  );

  await asTenant(tenant.id, () => seedDefaultDepartments(tenant.id));
  return getTenant(tenant.id);
}

/**
 * Deactivation, never deletion: sales records must be kept (six years, per
 * the CRA) and every receipt line points at a product and a cashier. Revokes
 * every session so staff are signed out immediately.
 */
export async function setTenantActive(
  id: number,
  active: boolean,
  admin: PlatformAdmin,
  ip: string | null,
): Promise<Tenant> {
  await withBypass(() =>
    withTransaction(async (tx) => {
      const t = await row<TenantRow>(tx, 'SELECT * FROM tenants WHERE id = $1 FOR UPDATE', [id]);
      if (!t) throw notFound(`Store ${id} not found`);
      if (t.is_active === active) return;
      await tx.query(
        'UPDATE tenants SET is_active = $2, deactivated_at = CASE WHEN $2 THEN NULL ELSE now() END WHERE id = $1',
        [id, active],
      );
      if (!active) {
        await tx.query('UPDATE sessions SET revoked_at = now() WHERE tenant_id = $1 AND revoked_at IS NULL', [id]);
        await tx.query('UPDATE admin_sessions SET acting_tenant_id = NULL WHERE acting_tenant_id = $1', [id]);
        // The revoked rows are only half of it: authenticate() caches sessions
        // in memory for a minute. Drop that too, so staff are out immediately.
        invalidateSessionCache();
      }
      await logAdminAction(tx, {
        admin_id: admin.id,
        action: active ? 'TENANT_REACTIVATED' : 'TENANT_DEACTIVATED',
        tenant_id: id,
        ip,
      });
    }),
  );
  return getTenant(id);
}

export async function updateTenant(
  id: number,
  input: { name?: string; slug?: string },
  admin: PlatformAdmin,
  ip: string | null,
): Promise<Tenant> {
  await withBypass(() =>
    withTransaction(async (tx) => {
      const t = await row<TenantRow>(tx, 'SELECT * FROM tenants WHERE id = $1 FOR UPDATE', [id]);
      if (!t) throw notFound(`Store ${id} not found`);
      const sets: string[] = [];
      const params: unknown[] = [];
      if (input.name !== undefined) {
        params.push(input.name);
        sets.push(`name = $${params.length}`);
      }
      if (input.slug !== undefined) {
        params.push(input.slug);
        sets.push(`slug = $${params.length}`);
      }
      if (!sets.length) return;
      params.push(id);
      await tx.query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      await logAdminAction(tx, { admin_id: admin.id, action: 'TENANT_UPDATED', tenant_id: id, details: input, ip });
    }),
  );
  return getTenant(id);
}

/** Resets a seller's owner password when they are locked out — the one support action that touches credentials. */
export async function resetTenantOwnerPassword(
  id: number,
  newPassword: string,
  admin: PlatformAdmin,
  ip: string | null,
): Promise<{ username: string }> {
  return withBypass(() =>
    withTransaction(async (tx) => {
      const owner = await row<UserRow>(
        tx,
        "SELECT * FROM users WHERE tenant_id = $1 AND role = 'OWNER' ORDER BY id LIMIT 1 FOR UPDATE",
        [id],
      );
      if (!owner) throw badRequest('This store has no owner account');
      await tx.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(newPassword), owner.id]);
      await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [owner.id]);
      await logAdminAction(tx, {
        admin_id: admin.id,
        action: 'OWNER_PASSWORD_RESET',
        tenant_id: id,
        details: { username: owner.username },
        ip,
      });
      return { username: owner.username };
    }),
  );
}

// ---------------------------------------------------------------- impersonation

/**
 * Switch this admin session into a seller. From then on the admin's token
 * resolves — via lib/authz.requireAuth — to that seller's OWNER, with
 * acting_admin_id set. Money operations refuse such a user and every write is
 * logged. Switching is itself logged, both ways.
 */
export async function startImpersonation(
  session: AdminSessionRow,
  admin: PlatformAdmin,
  tenantId: number,
  ip: string | null,
): Promise<TenantRow> {
  return withBypass(() =>
    withTransaction(async (tx) => {
      const t = await row<TenantRow>(tx, 'SELECT * FROM tenants WHERE id = $1', [tenantId]);
      if (!t) throw notFound(`Store ${tenantId} not found`);
      if (!t.is_active) throw badRequest('This store is deactivated. Reactivate it first.');
      const owner = await row<{ id: number }>(
        tx,
        "SELECT id FROM users WHERE tenant_id = $1 AND role = 'OWNER' AND is_active LIMIT 1",
        [tenantId],
      );
      if (!owner) throw badRequest('This store has no active owner to act as');
      await tx.query('UPDATE admin_sessions SET acting_tenant_id = $2 WHERE id = $1', [session.id, tenantId]);
      await logAdminAction(tx, { admin_id: admin.id, action: 'IMPERSONATION_STARTED', tenant_id: tenantId, ip });
      return t;
    }),
  );
}

export async function stopImpersonation(
  session: AdminSessionRow,
  admin: PlatformAdmin,
  ip: string | null,
): Promise<void> {
  if (!session.acting_tenant_id) return;
  await withBypass(() =>
    withTransaction(async (tx) => {
      await tx.query('UPDATE admin_sessions SET acting_tenant_id = NULL WHERE id = $1', [session.id]);
      await logAdminAction(tx, {
        admin_id: admin.id,
        action: 'IMPERSONATION_STOPPED',
        tenant_id: session.acting_tenant_id,
        ip,
      });
    }),
  );
}

/** The seller's OWNER, marked as being driven by an admin. */
export async function impersonatedUser(tenantId: number, adminId: number): Promise<AuthUser | null> {
  const owner = await withBypass(() =>
    row<UserRow>(
      currentDb(),
      "SELECT * FROM users WHERE tenant_id = $1 AND role = 'OWNER' AND is_active ORDER BY id LIMIT 1",
      [tenantId],
    ),
  );
  if (!owner) return null;
  return { ...serializeUser(owner), acting_admin_id: adminId };
}
