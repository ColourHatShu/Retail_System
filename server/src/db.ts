import { Pool, types } from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';
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
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
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

/** Runs fn inside BEGIN/COMMIT on a dedicated client; rolls back on any throw. */
export async function withTransaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
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

export async function initDatabase(): Promise<void> {
  await runMigrations(getPool());
  await seedDefaultDepartments();
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

async function seedDefaultDepartments(): Promise<void> {
  const db = getPool();
  const existing = await row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM departments');
  if (existing && existing.count > 0) return;

  const defaults = [
    ['Beverages', 'BEV', 'Soft drinks, juices, water, energy drinks', '#0ea5e9'],
    ['Grocery & Pantry', 'GROC', 'Flour, rice, spices, canned foods', '#10b981'],
    ['Dairy & Frozen', 'DAIRY', 'Milk, cheese, butter, ice cream', '#6366f1'],
    ['Bakery & Snacks', 'BAKE', 'Breads, cookies, chips, crackers', '#f59e0b'],
    ['Personal Care', 'CARE', 'Soap, shampoo, hygiene, cosmetics', '#ec4899'],
    ['Electronics & Tech', 'ELEC', 'Cables, chargers, earphones, accessories', '#8b5cf6'],
  ];
  await withTransaction(async (tx) => {
    for (const d of defaults) {
      await tx.query(
        'INSERT INTO departments (name, code, description, color) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        d,
      );
    }
  });
}
