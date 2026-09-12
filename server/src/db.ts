import { Pool, types } from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';
import { asTenant, declareScope } from './lib/tenant';
import { runMigrations } from './migrations';

// node-postgres hands back int8 (BIGINT ids, COUNT, SUM) and numeric as strings
// to avoid precision loss. Our values are far below 2^53, so parse to numbers.
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));
// timestamptz / timestamp -> ISO 8601 strings, always UTC.
types.setTypeParser(1184, (v) => new Date(v).toISOString());
types.setTypeParser(1114, (v) => new Date(`${v}Z`).toISOString());

/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Queryable = Pick<PoolClient, 'query'>;

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy server/.env.example to server/.env and fill in your Postgres connection string.',
    );
  }

  const schema = process.env.DB_SCHEMA;
  if (schema && !/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error(`DB_SCHEMA "${schema}" is not a safe identifier`);
  }

  // A connection-level tenant for code that runs outside any request scope —
  // the test suite, chiefly. A request always declares its own tenant
  // transaction-locally, which overrides this. Never set in production: an
  // unscoped query there must see nothing, not tenant 1.
  const defaultTenant = process.env.DB_DEFAULT_TENANT;
  if (defaultTenant && !/^\d+$/.test(defaultTenant)) {
    throw new Error(`DB_DEFAULT_TENANT "${defaultTenant}" is not a number`);
  }
  const connectionOptions = [
    ...(schema ? [`-c search_path=${schema}`] : []),
    ...(defaultTenant ? [`-c app.tenant_id=${defaultTenant}`] : []),
  ];

  const isLocal = /@(localhost|127\.0\.0\.1)(:|\/)/.test(url);
  const sslDisabled = isLocal || process.env.PGSSL === 'disable';

  pool = new Pool({
    connectionString: url,
    // Hosted Postgres (Supabase, RDS, ...) requires TLS. Their chains are not
    // in Node's default store, so certificate verification is off unless a CA
    // is supplied via PGSSL_CA. Traffic is still encrypted either way.
    ssl: sslDisabled
      ? undefined
      : process.env.PGSSL_CA
        ? { ca: process.env.PGSSL_CA, rejectUnauthorized: true }
        : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX) || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Tests point every connection at a throwaway schema.
    ...(connectionOptions.length ? { options: connectionOptions.join(' ') } : {}),
  });

  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
  });

  return pool;
}

export async function rows<T extends QueryResultRow>(
  db: Queryable,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await db.query<T>(text, params);
  return result.rows;
}

export async function row<T extends QueryResultRow>(
  db: Queryable,
  text: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  return (await rows<T>(db, text, params))[0];
}

/**
 * Runs fn inside BEGIN/COMMIT on a dedicated client; rolls back on any throw.
 * The current request scope (tenant or bypass) is declared on the connection
 * right after BEGIN, transaction-locally, so row-level security admits exactly
 * this request's rows and the setting dies with the transaction.
 */
export async function withTransaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await declareScope(client);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; releasing it below discards it.
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * What services use instead of getPool(). Every query runs in its own short
 * transaction with the current scope declared, so a plain read sees the right
 * tenant — or, with no scope at all, nothing. Only migrations and tests reach
 * for getPool() directly, and they know they are the connection role.
 */
const scopedQueryable: Queryable = {
  query: ((text: string, params?: unknown[]) =>
    withTransaction((tx) => tx.query(text, params as never))) as Queryable['query'],
};

export function currentDb(): Queryable {
  return scopedQueryable;
}

export async function initDatabase(): Promise<void> {
  await runMigrations(getPool());
  // The shop that existed before multi-tenancy is tenant 1. Newer tenants are
  // seeded by the admin service at creation; this covers a fresh database.
  await asTenant(1, () => seedDefaultDepartments(1));
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export const DEFAULT_DEPARTMENTS: ReadonlyArray<readonly [string, string, string, string]> = [
  ['Beverages', 'BEV', 'Soft drinks, juices, water, energy drinks', '#0ea5e9'],
  ['Grocery & Pantry', 'GROC', 'Flour, rice, spices, canned foods', '#10b981'],
  ['Dairy & Frozen', 'DAIRY', 'Milk, cheese, butter, ice cream', '#6366f1'],
  ['Bakery & Snacks', 'BAKE', 'Breads, cookies, chips, crackers', '#f59e0b'],
  ['Personal Care', 'CARE', 'Soap, shampoo, hygiene, cosmetics', '#ec4899'],
  ['Electronics & Tech', 'ELEC', 'Cables, chargers, earphones, accessories', '#8b5cf6'],
];

/** Gives a tenant the six standard departments if it has none. Must run inside that tenant's scope. */
export async function seedDefaultDepartments(tenantId: number): Promise<void> {
  await withTransaction(async (tx) => {
    const existing = await row<{ count: number }>(tx, 'SELECT COUNT(*) AS count FROM departments');
    if (existing && existing.count > 0) return;
    for (const [name, code, description, color] of DEFAULT_DEPARTMENTS) {
      await tx.query(
        `INSERT INTO departments (tenant_id, name, code, description, color)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [tenantId, name, code, description, color],
      );
    }
  });
}
