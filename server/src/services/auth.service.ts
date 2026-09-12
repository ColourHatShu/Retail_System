import { currentDb, row, rows, withTransaction } from '../db';
import type { Queryable } from '../db';
import { asTenant, withBypass } from '../lib/tenant';
import { DUMMY_HASH_PROMISE, generateSessionToken, hashPassword, hashToken, verifyPassword } from '../lib/auth';
import { AppError, badRequest } from '../lib/errors';
import type { AuthLogin, AuthSetup, ChangePassword } from '../schemas';
import type { AuthUser, UserRow } from '../types';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // one long shift
const AUTH_CACHE_TTL_MS = 60 * 1000;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const SETUP_LOCK_KEY = 7_303_292;

export interface SessionResult {
  user: AuthUser;
  token: string;
  expires_at: string;
}

export function serializeUser(r: UserRow): AuthUser {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    username: r.username,
    display_name: r.display_name,
    role: r.role,
    is_active: r.is_active,
    created_at: r.created_at,
    last_login_at: r.last_login_at,
  };
}

// ---------------------------------------------------------------------------
// Session cache: avoids a database round trip on every request. Entries are
// short-lived and dropped on logout, deactivation, or role change.
// ---------------------------------------------------------------------------

const sessionCache = new Map<string, { user: AuthUser; expiresAt: number; cachedAt: number }>();

export function invalidateSessionCache(tokenHash?: string): void {
  if (tokenHash) sessionCache.delete(tokenHash);
  else sessionCache.clear();
}

// ---------------------------------------------------------------------------
// Login throttling: after MAX_FAILED_LOGINS failures for a username+IP the
// pair is locked for LOCKOUT_MS. In-memory, per server instance.
// ---------------------------------------------------------------------------

const failures = new Map<string, { count: number; lockedUntil: number }>();

function throttleKey(username: string, ip: string): string {
  return `${username}|${ip}`;
}

function assertNotLocked(key: string): void {
  const f = failures.get(key);
  if (f && f.lockedUntil > Date.now()) {
    const minutes = Math.ceil((f.lockedUntil - Date.now()) / 60_000);
    throw new AppError(429, 'LOGIN_LOCKED', `Too many failed sign-in attempts. Try again in ${minutes} minute(s).`);
  }
}

function recordFailure(key: string): void {
  const f = failures.get(key) ?? { count: 0, lockedUntil: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILED_LOGINS) {
    f.lockedUntil = Date.now() + LOCKOUT_MS;
    f.count = 0;
  }
  failures.set(key, f);
}

/** Test hook: forget all throttling state. */
export function resetLoginThrottle(): void {
  failures.clear();
}

// ---------------------------------------------------------------------------

async function createSession(
  tx: Queryable,
  user: Pick<UserRow, 'id' | 'tenant_id'>,
  ip: string | null,
): Promise<{ token: string; expires_at: string }> {
  const { token, tokenHash } = generateSessionToken();
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await tx.query(
    'INSERT INTO sessions (tenant_id, token_hash, user_id, expires_at, ip) VALUES ($1, $2, $3, $4, $5)',
    [user.tenant_id, tokenHash, user.id, expires.toISOString(), ip],
  );
  return { token, expires_at: expires.toISOString() };
}

/** The tenant that existed before multi-tenancy; first-run setup creates its owner. */
const DEFAULT_TENANT_ID = 1;

/** True while no user exists in any tenant — the first-run setup wall. Sees across tenants. */
export async function authStatus(): Promise<{ needs_setup: boolean }> {
  return withBypass(async () => {
    const { count } = (await row<{ count: number }>(currentDb(), 'SELECT COUNT(*) AS count FROM users'))!;
    return { needs_setup: count === 0 };
  });
}

/** Creates the first OWNER of the default tenant. Only allowed while no user exists anywhere. */
export async function setupOwner(input: AuthSetup, ip: string | null): Promise<SessionResult> {
  return withBypass(() =>
    withTransaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [SETUP_LOCK_KEY]);
      const { count } = (await row<{ count: number }>(tx, 'SELECT COUNT(*) AS count FROM users'))!;
      if (count > 0) {
        throw new AppError(409, 'ALREADY_SET_UP', 'An owner account already exists. Sign in instead.');
      }
      const user = (await row<UserRow>(
        tx,
        `INSERT INTO users (tenant_id, username, display_name, password_hash, role, last_login_at)
         VALUES ($1, $2, $3, $4, 'OWNER', now()) RETURNING *`,
        [DEFAULT_TENANT_ID, input.username, input.display_name, await hashPassword(input.password)],
      ))!;
      const session = await createSession(tx, user, ip);
      return { user: serializeUser(user), ...session };
    }),
  );
}

export async function login(input: AuthLogin, ip: string | null): Promise<SessionResult> {
  const key = throttleKey(input.username, ip ?? '');
  assertNotLocked(key);

  // Usernames are unique per tenant, not globally, and the tenant is not known
  // yet — so look across all of them. A store code disambiguates when the same
  // username exists in more than one shop; a single shop never needs one.
  const candidates = await withBypass(() =>
    rows<UserRow & { tenant_active: boolean; tenant_slug: string }>(
      currentDb(),
      `SELECT u.*, t.is_active AS tenant_active, t.slug AS tenant_slug
         FROM users u JOIN tenants t ON t.id = u.tenant_id
        WHERE u.username = $1 AND ($2::text IS NULL OR t.slug = $2)`,
      [input.username, input.tenant ?? null],
    ),
  );

  if (candidates.length > 1) {
    throw new AppError(400, 'TENANT_REQUIRED', 'This username exists in more than one store. Enter your store code.', {
      stores: candidates.map((c) => c.tenant_slug),
    });
  }
  const user = candidates[0];

  // Always run one hash verification so timing does not reveal whether the user exists.
  const ok = user
    ? await verifyPassword(input.password, user.password_hash)
    : await verifyPassword(input.password, await DUMMY_HASH_PROMISE);

  if (!user || !ok || !user.is_active) {
    recordFailure(key);
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect username or password');
  }
  if (!user.tenant_active) {
    recordFailure(key);
    throw new AppError(403, 'TENANT_INACTIVE', 'This store has been deactivated. Contact the platform administrator.');
  }

  failures.delete(key);

  return asTenant(user.tenant_id, () =>
    withTransaction(async (tx) => {
      const updated = (await row<UserRow>(tx, 'UPDATE users SET last_login_at = now() WHERE id = $1 RETURNING *', [
        user.id,
      ]))!;
      const session = await createSession(tx, user, ip);
      return { user: serializeUser(updated), ...session };
    }),
  );
}

/** Resolve a bearer token to its user, or null if unknown, expired, revoked, or deactivated. */
export async function authenticate(token: string): Promise<AuthUser | null> {
  const tokenHash = hashToken(token);
  const cached = sessionCache.get(tokenHash);
  const now = Date.now();
  if (cached && cached.cachedAt + AUTH_CACHE_TTL_MS > now && cached.expiresAt > now) {
    return cached.user;
  }

  // The tenant is not known until the token resolves, so this one lookup
  // sees across tenants. A deactivated store's sessions stop working at once.
  const found = await withBypass(() =>
    row<UserRow & { expires_at: string }>(
      currentDb(),
      `SELECT u.*, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN tenants t ON t.id = u.tenant_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.is_active AND t.is_active`,
      [tokenHash],
    ),
  );
  if (!found) {
    sessionCache.delete(tokenHash);
    return null;
  }
  const user = serializeUser(found);
  sessionCache.set(tokenHash, { user, expiresAt: new Date(found.expires_at).getTime(), cachedAt: now });
  return user;
}

export async function logout(tokenHash: string): Promise<void> {
  await currentDb().query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [
    tokenHash,
  ]);
  sessionCache.delete(tokenHash);
}

/** Revoke every session of a user (deactivation, role change, password reset). */
export async function revokeUserSessions(db: Queryable, userId: number, exceptTokenHash?: string): Promise<void> {
  await db.query(
    `UPDATE sessions SET revoked_at = now()
     WHERE user_id = $1 AND revoked_at IS NULL AND ($2::text IS NULL OR token_hash <> $2)`,
    [userId, exceptTokenHash ?? null],
  );
  sessionCache.clear();
}

export async function changePassword(user: AuthUser, input: ChangePassword, currentTokenHash: string): Promise<void> {
  const stored = (await row<UserRow>(currentDb(), 'SELECT * FROM users WHERE id = $1', [user.id]))!;
  if (!(await verifyPassword(input.current_password, stored.password_hash))) {
    throw badRequest('Current password is incorrect');
  }
  await withTransaction(async (tx) => {
    await tx.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      await hashPassword(input.new_password),
      user.id,
    ]);
    // Other devices signed in with the old password lose access; this one stays signed in.
    await revokeUserSessions(tx, user.id, currentTokenHash);
  });
}
