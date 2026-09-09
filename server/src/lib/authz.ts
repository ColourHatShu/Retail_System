import type { RequestHandler, Response } from 'express';
import { authenticate } from '../services/auth.service';
import type { AuthUser, Role } from '../types';
import { bearerToken, hashToken } from './auth';
import { AppError } from './errors';

export const MANAGER_UP: Role[] = ['OWNER', 'MANAGER'];
export const OWNER_ONLY: Role[] = ['OWNER'];

/** Requires a valid session; stores the user on res.locals.user. */
export const requireAuth: RequestHandler = async (req, res, next) => {
  const token = bearerToken(req.headers.authorization);
  if (!token) {
    return next(new AppError(401, 'UNAUTHENTICATED', 'Sign in required'));
  }
  const user = await authenticate(token);
  if (!user) {
    return next(new AppError(401, 'SESSION_EXPIRED', 'Your session is invalid or has expired. Sign in again.'));
  }
  res.locals.user = user;
  res.locals.tokenHash = hashToken(token);
  next();
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

/** The signed-in user for the current request (after requireAuth). */
export function actor(res: Response): AuthUser {
  return res.locals.user as AuthUser;
}

export function currentTokenHash(res: Response): string {
  return res.locals.tokenHash as string;
}
