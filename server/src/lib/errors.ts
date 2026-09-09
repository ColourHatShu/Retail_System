import type { ErrorRequestHandler, RequestHandler } from 'express';

/**
 * Typed application error. Services throw these; the central errorHandler
 * turns them into a consistent JSON envelope:
 *   { success: false, code: 'SOME_CODE', error: 'human message', details?: any }
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);
export const notFound = (message: string) => new AppError(404, 'NOT_FOUND', message);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);

const UNIQUE_MESSAGES: Record<string, string> = {
  'products.barcode': 'A product with this barcode already exists',
  'departments.name': 'A department with this name already exists',
  'departments.code': 'A department with this code already exists',
  'sales.receipt_number': 'Receipt number collision, please retry the sale',
  'users.username': 'A user with this username already exists',
};

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN',
  '28P01', // invalid_password
  '3D000', // invalid_catalog_name (database does not exist)
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
]);

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    success: false,
    code: 'NOT_FOUND',
    error: `Route ${req.method} ${req.path} does not exist`,
  });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({
      success: false,
      code: err.code,
      error: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    });
    return;
  }

  const code: string | undefined = err?.code;

  // Postgres unique_violation. err.table + err.detail ("Key (barcode)=(x) already exists.")
  if (code === '23505') {
    const column = /Key \(([^)]+)\)/.exec(String(err.detail ?? ''))?.[1];
    const key = `${err.table}.${column}`;
    res.status(409).json({
      success: false,
      code: 'ALREADY_EXISTS',
      error: UNIQUE_MESSAGES[key] || 'A record with these values already exists',
    });
    return;
  }

  // Postgres foreign_key_violation
  if (code === '23503') {
    res.status(409).json({
      success: false,
      code: 'IN_USE',
      error: 'This record is referenced by other data and cannot be changed',
    });
    return;
  }

  // Postgres invalid_text_representation / numeric_value_out_of_range
  if (code === '22P02' || code === '22003') {
    res.status(400).json({ success: false, code: 'BAD_REQUEST', error: 'A value has the wrong type or is out of range' });
    return;
  }

  if (code && CONNECTION_ERROR_CODES.has(code)) {
    console.error(`[${new Date().toISOString()}] Database unavailable on ${req.method} ${req.originalUrl}:`, err.message);
    res.status(503).json({ success: false, code: 'DATABASE_UNAVAILABLE', error: 'Database is unavailable, please retry' });
    return;
  }

  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ success: false, code: 'INVALID_JSON', error: 'Request body is not valid JSON' });
    return;
  }

  if (err?.type === 'entity.too.large') {
    res.status(413).json({ success: false, code: 'PAYLOAD_TOO_LARGE', error: 'Request body is too large' });
    return;
  }

  // Unknown failure: log the real error server-side, never leak it to clients.
  console.error(`[${new Date().toISOString()}] Unhandled error on ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ success: false, code: 'INTERNAL_ERROR', error: 'Internal server error' });
};
