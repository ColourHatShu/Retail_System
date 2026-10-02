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
export const forbidden = (code: string, message: string) => new AppError(403, code, message);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);

/**
 * Keyed by constraint name. Postgres withholds the "Key (col)=(val)" detail
 * from any role subject to row-level security — it could leak another
 * tenant's value — but the constraint name is always reported, and ours are
 * named for what they protect.
 */
const UNIQUE_MESSAGES: Record<string, string> = {
  products_tenant_barcode_key: 'A product with this barcode already exists',
  departments_tenant_name_key: 'A department with this name already exists',
  departments_tenant_code_key: 'A department with this code already exists',
  sales_tenant_receipt_number_key: 'Receipt number collision, please retry the sale',
  returns_tenant_return_number_key: 'Return number collision, please retry',
  users_tenant_username_key: 'A user with this username already exists',
  tenants_slug_key: 'A store with this code already exists',
  platform_admins_username_key: 'An administrator with this username already exists',
  // Pre-tenancy names, in case an error arrives from a legacy constraint.
  products_barcode_key: 'A product with this barcode already exists',
  departments_name_key: 'A department with this name already exists',
  departments_code_key: 'A department with this code already exists',
  users_username_key: 'A user with this username already exists',
};

/**
 * Keyed by the table still holding the reference, which Postgres names in
 * err.detail. Says what is protecting the record and what to do instead.
 */
const FK_MESSAGES: Record<string, string> = {
  sale_items:
    'This product has been sold, so deleting it would leave receipts pointing at nothing. Archive it instead — it disappears from the register and the catalogue, and every receipt it appears on stays intact.',
  return_items:
    'This product appears on a refund, so deleting it would break that record. Archive it instead to take it off the register while keeping its history.',
  products: 'This department still has products in it. Move or archive those products first.',
  stock_movements: 'This record still has stock history attached to it.',
  sales: 'This record is still attached to a completed sale.',
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

  // Postgres unique_violation. Identified by constraint name — see UNIQUE_MESSAGES.
  if (code === '23505') {
    res.status(409).json({
      success: false,
      code: 'ALREADY_EXISTS',
      error: UNIQUE_MESSAGES[String(err.constraint ?? '')] || 'A record with these values already exists',
    });
    return;
  }

  // Postgres foreign_key_violation. On a RESTRICT-ed delete the detail reads
  // 'Key (id)=(15) is still referenced from table "sale_items".', which names
  // what is actually protecting the row — far more useful than "other data".
  if (code === '23503') {
    const referencedFrom = /is still referenced from table "([^"]+)"/.exec(String(err.detail ?? ''))?.[1];
    const hasHistory = referencedFrom === 'sale_items' || referencedFrom === 'return_items';
    res.status(409).json({
      success: false,
      code: hasHistory ? 'HAS_HISTORY' : 'IN_USE',
      error:
        (referencedFrom && FK_MESSAGES[referencedFrom]) ||
        'Something else in the system still refers to this record, so it cannot be deleted',
      ...(referencedFrom ? { details: { referencedFrom } } : {}),
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
