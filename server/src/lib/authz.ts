import type { Request, RequestHandler, Response } from 'express';
import { currentDb } from '../db';
import { authenticateAdmin, impersonatedUser, logAdminAction } from '../services/admin.service';
import { authenticate } from '../services/auth.service';
import type { AuthUser, Role } from '../types';
import { bearerToken, hashToken } from './auth';
import { AppError } from './errors';
import { asTenant, withBypass } from './tenant';

export const MANAGER_UP: Role[] = ['OWNER', 'MANAGER'];
export const OWNER_ONLY: Role[] = ['OWNER'];

export function clientIp(req: Request): string | null {
  return req.ip ?? null;
}

/**
 * Requires a valid seller session and scopes the rest of the request to that
 * seller's tenant. Everything downstream — every service call, every query —
 * sees only that tenant's rows, enforced by the database.
 *
 * A platform admin who has switched into a seller passes too: their token
 * resolves to that seller's OWNER with acting_admin_id set. Every mutating
 * request they make is written to admin_actions when it completes.
 */
export const requireAuth: RequestHandler = async (req, res, next) => {
  const token = bearerToken(req.headers.authorization);
  if (!token) {
    return next(new AppError(401, 'UNAUTHENTICATED', 'Sign in required'));
  }

  let user = await authenticate(token);

  if (!user) {
    const admin = await authenticateAdmin(token);
    if (admin?.acting_tenant) {
      user = await impersonatedUser(admin.acting_tenant.id, admin.admin.id);
      if (user && req.method !== 'GET' && req.method !== 'HEAD') {
        const { admin: who, acting_tenant } = admin;
        res.on('finish', () => {
          withBypass(() =>
            logAdminAction(currentDb(), {
              admin_id: who.id,
              action: 'IMPERSONATED_WRITE',
              tenant_id: acting_tenant.id,
              details: { method: req.method, path: req.originalUrl, status: res.statusCode },
              ip: clientIp(req),
            }),
          ).catch((err: Error) => console.error('[authz] failed to log impersonated write:', err.message));
        });
      }
    }
  }

  if (!user) {
    return next(new AppError(401, 'SESSION_EXPIRED', 'Your session is invalid or has expired. Sign in again.'));
  }

  res.locals.user = user;
  res.locals.tokenHash = hashToken(token);
  asTenant(user.tenant_id, () => next(), user.acting_admin_id ?? null);
};

/**
 * Requires a platform-admin session. The request runs with row-level
 * security bypassed, because the admin's screens are about every tenant.
 * Never mount tenant routes behind this.
 */
export const requireAdmin: RequestHandler = async (req, res, next) => {
  const token = bearerToken(req.headers.authorization);
  if (!token) {
    return next(new AppError(401, 'UNAUTHENTICATED', 'Administrator sign in required'));
  }
  const resolved = await authenticateAdmin(token);
  if (!resolved) {
    return next(new AppError(401, 'SESSION_EXPIRED', 'Your administrator session is invalid or has expired.'));
  }
  res.locals.admin = resolved.admin;
  res.locals.adminSession = resolved.session;
  res.locals.actingTenant = resolved.acting_tenant;
  res.locals.tokenHash = hashToken(token);
  withBypass(() => next());
};

/** Requires one of the given roles. Must run after requireAuth. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (_req, res, next) => {
    const user = res.locals.user as AuthUser | undefined;
    if (!user) return next(new AppError(401, 'UNAUTHENTICATED', 'Sign in required'));
    if (!roles.includes(user.role)) {
      return next(
        new AppError(403, 'FORBIDDEN', `This action requires the ${roles.join(' or ')} role; you are ${user.role}`),
      );
    }
    next();
  };
}

/**
 * Refuses a request made by a platform admin switched into a seller. Mount on
 * anything that moves money or stock — checkout, refunds, voids, adjustments.
 * Support means seeing what the seller sees and fixing their setup, not
 * ringing their sales; a sale rung this way would name a cashier who was
 * never there, and the audit trail is the product's promise.
 */
export const forbidImpersonation: RequestHandler = (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const user = res.locals.user as AuthUser | undefined;
  if (user?.acting_admin_id) {
    return next(
      new AppError(
        403,
        'IMPERSONATION_FORBIDDEN',
        "This action is not available while switched into a store. Sales, refunds, voids and stock changes must be made by the store's own staff.",
      ),
    );
  }
  next();
};

/** The signed-in user for the current request (after requireAuth). */
export function actor(res: Response): AuthUser {
  return res.locals.user as AuthUser;
}

export function currentTokenHash(res: Response): string {
  return res.locals.tokenHash as string;
}
