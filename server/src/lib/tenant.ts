import { AsyncLocalStorage } from 'node:async_hooks';
import type { Queryable } from '../db';

/**
 * Which seller the current request belongs to.
 *
 * Every scoped table has row-level security FORCED on, with a policy that
 * only admits rows whose tenant_id matches what the transaction declared via
 * set_config('app.tenant_id', ..., true). The `true` makes it transaction-
 * local: Postgres discards it at COMMIT or ROLLBACK, so a pooled connection
 * can never carry one request's tenant into the next. A transaction that
 * declares nothing sees nothing.
 *
 * The scope lives in AsyncLocalStorage so services keep their simple
 * `db: Queryable = currentDb()` signature and never have to thread a tenant
 * id through every call. withTransaction() reads it and declares it on each
 * connection it opens.
 */
export interface RequestScope {
  /** The seller whose rows this request may see and write. */
  tenantId: number | null;
  /**
   * Lift row-level security entirely. Only for code that genuinely has to
   * see across tenants: resolving a session token before the tenant is
   * known, migrations, and the platform admin's own screens.
   */
  bypass: boolean;
  /** Set when a platform admin is switched into a seller. */
  actingAdminId: number | null;
}

const storage = new AsyncLocalStorage<RequestScope>();

export function currentScope(): RequestScope | undefined {
  return storage.getStore();
}

/** Run `fn` with the given scope. Nested calls replace the scope for their duration. */
export function runInScope<T>(scope: RequestScope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function asTenant<T>(tenantId: number, fn: () => T, actingAdminId: number | null = null): T {
  return storage.run({ tenantId, bypass: false, actingAdminId }, fn);
}

export function withBypass<T>(fn: () => T): T {
  const outer = storage.getStore();
  return storage.run(
    { tenantId: outer?.tenantId ?? null, bypass: true, actingAdminId: outer?.actingAdminId ?? null },
    fn,
  );
}

/**
 * Declare the current scope on a connection that has just executed BEGIN.
 * Everything here is transaction-local and dies at COMMIT or ROLLBACK.
 *
 * Tenant-scoped work runs as pos_app, a role without BYPASSRLS, so the
 * tenant_isolation policies actually apply. The connection role (Supabase's
 * "postgres") has BYPASSRLS and would ignore them — which is exactly what
 * cross-tenant work wants, so a bypass scope simply stays as that role.
 *
 * No scope at all is treated as a tenant scope with no tenant: pos_app with
 * app.tenant_id unset sees nothing. Failing closed is the whole point.
 */
export async function declareScope(tx: Queryable): Promise<void> {
  const scope = storage.getStore();

  if (scope?.bypass) {
    await tx.query('SET LOCAL ROLE NONE');
    return;
  }

  await tx.query('SET LOCAL ROLE pos_app');
  if (scope && scope.tenantId !== null) {
    await tx.query("SELECT set_config('app.tenant_id', $1, true)", [String(scope.tenantId)]);
  }
}

/** The tenant a request is scoped to, or throws — for code that must never run unscoped. */
export function requireTenantId(): number {
  const scope = storage.getStore();
  if (!scope || scope.tenantId === null) {
    throw new Error('No tenant in scope. This code must run inside an authenticated request.');
  }
  return scope.tenantId;
}
