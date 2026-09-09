import { getPool, row, rows, withTransaction } from '../db';
import { hashPassword } from '../lib/auth';
import { badRequest, notFound } from '../lib/errors';
import type { UserCreate, UserUpdate } from '../schemas';
import type { AuthUser, UserRow } from '../types';
import { revokeUserSessions, serializeUser } from './auth.service';

export async function listUsers(): Promise<AuthUser[]> {
  const list = await rows<UserRow>(getPool(), 'SELECT * FROM users ORDER BY role, username');
  return list.map(serializeUser);
}

export async function createUser(input: UserCreate): Promise<AuthUser> {
  const created = await row<UserRow>(
    getPool(),
    `INSERT INTO users (username, display_name, password_hash, role)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [input.username, input.display_name, await hashPassword(input.password), input.role],
  );
  return serializeUser(created!);
}

/**
 * Owner-only edits. Guards: you cannot deactivate or demote yourself, and the
 * last active owner can never be removed. Any change that reduces access
 * (deactivate, role change, password reset) signs the user out everywhere.
 */
export async function updateUser(id: number, input: UserUpdate, by: AuthUser): Promise<AuthUser> {
  return withTransaction(async (tx) => {
    const target = await row<UserRow>(tx, 'SELECT * FROM users WHERE id = $1 FOR UPDATE', [id]);
    if (!target) throw notFound(`User ${id} not found`);

    const deactivating = input.is_active === false && target.is_active;
    const demoting = input.role !== undefined && input.role !== target.role && target.role === 'OWNER';

    if (target.id === by.id && (deactivating || demoting)) {
      throw badRequest('You cannot deactivate or demote your own account');
    }

    if (target.role === 'OWNER' && (deactivating || demoting)) {
      const { count } = (await row<{ count: number }>(
        tx,
        "SELECT COUNT(*) AS count FROM users WHERE role = 'OWNER' AND is_active AND id <> $1",
        [target.id],
      ))!;
      if (count === 0) throw badRequest('There must always be at least one active owner');
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const assign = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (input.display_name !== undefined) assign('display_name', input.display_name);
    if (input.role !== undefined) assign('role', input.role);
    if (input.is_active !== undefined) assign('is_active', input.is_active);
    if (input.password !== undefined) assign('password_hash', await hashPassword(input.password));

    if (sets.length > 0) {
      params.push(id);
      await tx.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    }

    const accessReduced =
      deactivating || (input.role !== undefined && input.role !== target.role) || input.password !== undefined;
    if (accessReduced) await revokeUserSessions(tx, id);

    return serializeUser((await row<UserRow>(tx, 'SELECT * FROM users WHERE id = $1', [id]))!);
  });
}
