import { z } from 'zod';
import { MOVEMENT_TYPES, PAYMENT_METHODS, RETURN_CONDITIONS, ROLES } from '../types';

// ---------- shared primitives ----------

/** Decimal money amount coming from a client (number or numeric string). */
const money = z.coerce.number().finite().min(0).max(1_000_000_000);

const optionalText = (max: number) =>
  z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(max).optional());

/** Optional text that may be explicitly cleared by sending null. */
const nullableText = (max: number) => z.union([z.string().trim().max(max), z.null()]).optional();

/** Optional numeric id; treats '', 'ALL' and null as "not provided". */
const optionalId = z.preprocess(
  (v) => (v === '' || v === 'ALL' || v === null ? undefined : v),
  z.coerce.number().int().positive().optional(),
);

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a hex colour like #4f46e5');

export const idParam = z.object({ id: z.coerce.number().int().positive() });
export const barcodeParam = z.object({ barcode: z.string().trim().min(1).max(64) });

export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---------- departments ----------

export const departmentCreate = z.object({
  name: z.string().trim().min(1).max(80),
  code: z
    .string()
    .trim()
    .min(2)
    .max(10)
    .transform((s) => s.toUpperCase()),
  description: nullableText(300),
  color: hexColor.optional(),
});
export type DepartmentCreate = z.infer<typeof departmentCreate>;

export const departmentUpdate = departmentCreate.partial();
export type DepartmentUpdate = z.infer<typeof departmentUpdate>;

// ---------- products ----------

export const productCreate = z.object({
  barcode: z.string().trim().min(3).max(64),
  sku: nullableText(64),
  name: z.string().trim().min(1).max(160),
  department_id: z.coerce.number().int().positive(),
  price: money,
  cost_price: money.default(0),
  stock_quantity: z.coerce.number().int().min(0).default(0),
  min_stock_level: z.coerce.number().int().min(0).default(5),
  unit: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().min(1).max(20).default('pcs')),
  image_url: nullableText(500),
});
export type ProductCreate = z.infer<typeof productCreate>;

/**
 * Stock is intentionally NOT editable here; it only changes through movements.
 * is_active is update-only — a product is never created archived — and is how a
 * sold product is retired, since deleting one would orphan its receipt lines.
 */
export const productUpdate = productCreate
  .omit({ stock_quantity: true })
  .partial()
  .extend({ is_active: z.boolean().optional() });
export type ProductUpdate = z.infer<typeof productUpdate>;

export const productListQuery = z.object({
  department_id: optionalId,
  search: optionalText(100),
  low_stock: z.enum(['true', 'false']).optional(),
  /** Archived products are hidden unless asked for explicitly. */
  include_archived: z.enum(['true', 'false']).optional(),
});
export type ProductListQuery = z.infer<typeof productListQuery>;

// ---------- inventory ----------

export const scanAdjust = z.object({
  barcode: z.string().trim().min(1).max(64),
  change_quantity: z.coerce
    .number()
    .int()
    .refine((n) => n !== 0, 'must be a non-zero integer'),
  type: z.enum(['RESTOCK', 'ADJUSTMENT_ADD', 'ADJUSTMENT_REMOVE', 'RETURN']),
  reason: optionalText(300),
  reference_id: optionalText(64),
});
export type ScanAdjust = z.infer<typeof scanAdjust>;

export const setCount = z.object({
  barcode: z.string().trim().min(1).max(64),
  actual_count: z.coerce.number().int().min(0),
  reason: optionalText(300),
});
export type SetCount = z.infer<typeof setCount>;

/** Spreadsheet rows are messy; keep the schema loose and normalise per row in the service. */
export const importBatch = z.object({
  items: z.array(z.record(z.unknown())).min(1).max(5000),
});
export type ImportBatch = z.infer<typeof importBatch>;

// ---------- sales ----------

export const checkout = z.object({
  items: z
    .array(
      z
        .object({
          product_id: z.coerce.number().int().positive().optional(),
          barcode: optionalText(64),
          quantity: z.coerce.number().int().positive().max(100_000),
        })
        .refine((i) => i.product_id !== undefined || i.barcode !== undefined, {
          message: 'each item needs a product_id or barcode',
        }),
    )
    .min(1)
    .max(500),
  payment_method: z.enum(PAYMENT_METHODS).default('CASH'),
  /** Required for CASH. Ignored for other methods (charged exactly the total). */
  amount_paid: money.optional(),
  discount: money.default(0),
  /**
   * What the register displayed to the cashier. If the server's recomputed
   * total differs (price changed, tax changed), the sale is refused with
   * PRICE_CHANGED so the cashier can re-confirm with the customer.
   */
  expected_total: money.optional(),
  customer_name: optionalText(120),
  customer_phone: optionalText(30),
});
export type CheckoutInput = z.infer<typeof checkout>;

export const salesListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const receiptParam = z.object({ receipt_number: z.string().trim().min(3).max(40) });

// ---------- returns & voids ----------

export const returnCreate = z
  .object({
    sale_id: z.coerce.number().int().positive().optional(),
    receipt_number: optionalText(40),
    items: z
      .array(
        z.object({
          sale_item_id: z.coerce.number().int().positive(),
          quantity: z.coerce.number().int().positive().max(100_000),
          /** Put the goods back on the shelf (true) or write them off (false). */
          restock: z.boolean().default(true),
          condition: z.enum(RETURN_CONDITIONS).default('RESALABLE'),
        }),
      )
      .min(1)
      .max(200),
    reason: optionalText(300),
    /** Defaults to the tender the customer originally paid with. */
    refund_method: z.enum(PAYMENT_METHODS).optional(),
  })
  .refine((r) => r.sale_id !== undefined || r.receipt_number !== undefined, {
    message: 'sale_id or receipt_number is required',
  });
export type ReturnCreate = z.infer<typeof returnCreate>;

export const voidSale = z.object({ reason: z.string().trim().min(3).max(300) });
export type VoidSale = z.infer<typeof voidSale>;

// ---------- movements ----------

export const movementsQuery = pagination.extend({
  product_id: optionalId,
  department_id: optionalId,
  type: z.preprocess((v) => (v === '' || v === 'ALL' ? undefined : v), z.enum(MOVEMENT_TYPES).optional()),
  search: optionalText(100),
  start_date: optionalText(30),
  end_date: optionalText(30),
});
export type MovementsQuery = z.infer<typeof movementsQuery>;

// ---------- auth & users ----------

const username = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9._-]+$/, 'may contain letters, digits, dots, underscores and dashes only');
const newPassword = z.string().min(8, 'must be at least 8 characters').max(200);
const displayName = z.string().trim().min(1).max(80);

export const authSetup = z.object({ username, password: newPassword, display_name: displayName });
export type AuthSetup = z.infer<typeof authSetup>;

export const authLogin = z.object({ username, password: z.string().min(1).max(200) });
export type AuthLogin = z.infer<typeof authLogin>;

export const changePassword = z.object({ current_password: z.string().min(1).max(200), new_password: newPassword });
export type ChangePassword = z.infer<typeof changePassword>;

export const userCreate = z.object({ username, password: newPassword, display_name: displayName, role: z.enum(ROLES) });
export type UserCreate = z.infer<typeof userCreate>;

export const userUpdate = z.object({
  display_name: displayName.optional(),
  role: z.enum(ROLES).optional(),
  is_active: z.boolean().optional(),
  password: newPassword.optional(),
});
export type UserUpdate = z.infer<typeof userUpdate>;

// ---------- settings ----------

export const settingsUpdate = z.object({
  store_name: z.string().trim().min(1).max(120).optional(),
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((s) => s.toUpperCase())
    .optional(),
  tax_rate_percent: z.coerce.number().min(0).max(100).optional(),
  /** Days after a sale during which cashiers and managers may accept returns (owners always can). */
  return_window_days: z.coerce.number().int().min(0).max(3650).optional(),
  /** Refunds above this amount must be processed by a manager or owner. */
  refund_approval_threshold: money.optional(),
});
export type SettingsUpdate = z.infer<typeof settingsUpdate>;
