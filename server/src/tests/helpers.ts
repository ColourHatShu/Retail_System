import type { Express } from 'express';
import request from 'supertest';
import { closePool, getPool, initDatabase } from '../db';
import type { Role } from '../types';

/** True when a database is configured; suites use describe.skipIf(!hasDatabase). */
export const hasDatabase = !!process.env.DATABASE_URL;

const schema = process.env.DB_SCHEMA as string;

/** Create this file's private schema. Pass migrate=false to prepare a legacy layout by hand. */
export async function createTestSchema(migrate = true): Promise<void> {
  await getPool().query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  if (migrate) await initDatabase();
}

export async function dropTestSchema(): Promise<void> {
  try {
    await getPool().query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await closePool();
  }
}

export async function firstDepartmentId(): Promise<number> {
  const { rows } = await getPool().query<{ id: number }>('SELECT id FROM departments ORDER BY id LIMIT 1');
  return rows[0].id;
}

export const OWNER_PASSWORD = 'owner-pass-123';

/** Creates the first owner through the public setup endpoint and returns its token. */
export async function bootstrapOwner(app: Express): Promise<string> {
  const res = await request(app)
    .post('/api/auth/setup')
    .send({ username: 'owner', password: OWNER_PASSWORD, display_name: 'Store Owner' });
  if (res.status !== 201) throw new Error(`owner setup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.token as string;
}

let userSeq = 0;

/** As the owner, creates a user with the given role and signs them in. */
export async function loginAs(app: Express, ownerToken: string, role: Role): Promise<{ token: string; username: string; id: number }> {
  const username = `${role.toLowerCase()}${++userSeq}`;
  const password = `${username}-pass-123`;
  const created = await request(app)
    .post('/api/users')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ username, password, display_name: `${role} ${userSeq}`, role });
  if (created.status !== 201) throw new Error(`create ${role} failed: ${created.status} ${JSON.stringify(created.body)}`);
  const login = await request(app).post('/api/auth/login').send({ username, password });
  if (login.status !== 200) throw new Error(`login ${role} failed: ${login.status} ${JSON.stringify(login.body)}`);
  return { token: login.body.data.token as string, username, id: created.body.data.id as number };
}

/** supertest wrapper that attaches a bearer token to every request. */
export function client(app: Express, token?: string) {
  const auth = (t: request.Test) => (token ? t.set('Authorization', `Bearer ${token}`) : t);
  return {
    get: (url: string) => auth(request(app).get(url)),
    post: (url: string) => auth(request(app).post(url)),
    put: (url: string) => auth(request(app).put(url)),
    delete: (url: string) => auth(request(app).delete(url)),
  };
}
