import crypto from 'crypto';

/**
 * Password hashing with Node's built-in scrypt (no native dependency), and
 * opaque session tokens. Only hashes are ever stored: a leaked database does
 * not yield usable passwords or session tokens.
 */

const SCRYPT_N = 16384;
const SCRYPT_KEYLEN = 64;

function scrypt(password: string, salt: Buffer, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, { N: n, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key as Buffer),
    );
  });
}

/** Returns "scrypt$N$salt$hash" (all base64) suitable for storing in users.password_hash. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT_N);
  return `scrypt$${SCRYPT_N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt' || !n || !saltB64 || !hashB64) return false;
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), Number(n));
  const expected = Buffer.from(hashB64, 'base64');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

/** A hash of a throwaway password, so failed logins for unknown users take as long as real ones. */
export const DUMMY_HASH_PROMISE = hashPassword(crypto.randomBytes(16).toString('hex'));

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateSessionToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value.trim() : null;
}
