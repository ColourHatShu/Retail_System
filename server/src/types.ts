/** Database row and API shapes. Row types carry *_cents; API types carry decimals. */

export const MOVEMENT_TYPES = [
  'INITIAL',
  'RESTOCK',
  'SALE',
  'ADJUSTMENT_ADD',
  'ADJUSTMENT_REMOVE',
  'RETURN',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

/**
 * Tenders a NEW sale or refund may use. Narrowed to cash and card; UPI_QR was
 * an Indian tender that does not apply to a Canadian shop. Historical rows may
 * still hold other values — nothing validates stored strings, so old receipts
 * keep displaying whatever they were taken with.
 */
export const PAYMENT_METHODS = ['CASH', 'CARD'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const SALE_STATUSES = ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'VOIDED'] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

export const RETURN_CONDITIONS = ['RESALABLE', 'DAMAGED', 'EXPIRED', 'DEFECTIVE', 'OTHER'] as const;
export type ReturnCondition = (typeof RETURN_CONDITIONS)[number];

export const ROLES = ['OWNER', 'MANAGER', 'CASHIER'] as const;
export type Role = (typeof ROLES)[number];

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
  is_active: boolean;
  created_at: string;
  last_login_at: string | null;
}

/** A user as exposed by the API: never carries the password hash. */
export interface AuthUser {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  is_active: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface DepartmentRow {
  id: number;
  name: string;
  code: string;
  description: string | null;
  color: string;
  created_at: string;
  product_count?: number;
  total_stock?: number;
  inventory_value_cents?: number;
}

export interface Department {
  id: number;
  name: string;
  code: string;
  description: string | null;
  color: string;
  created_at: string;
  product_count?: number;
  total_stock?: number;
  inventory_value?: number;
}

export interface ProductRow {
  id: number;
  barcode: string;
  sku: string | null;
  name: string;
  department_id: number;
  price_cents: number;
  cost_price_cents: number;
  stock_quantity: number;
  min_stock_level: number;
  unit: string;
  image_url: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  department_name?: string;
  department_code?: string;
  department_color?: string;
}

export interface Product {
  id: number;
  barcode: string;
  sku: string | null;
  name: string;
  department_id: number;
  department_name?: string;
  department_code?: string;
  department_color?: string;
  price: number;
  cost_price: number;
  stock_quantity: number;
  min_stock_level: number;
  unit: string;
  image_url: string | null;
  /** Archived products keep their receipts but leave the catalogue and register. */
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface StockMovementRow {
  id: number;
  product_id: number;
  type: MovementType;
  quantity_change: number;
  quantity_before: number;
  quantity_after: number;
  reference_id: string | null;
  reason: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  payment_method: string | null;
  sale_id: number | null;
  user_id: number | null;
  created_at: string;
  user_name?: string | null;
  product_name?: string;
  product_barcode?: string;
  product_sku?: string | null;
  product_unit?: string;
  product_price_cents?: number;
  department_id?: number;
  department_name?: string;
  department_code?: string;
  department_color?: string;
}

export interface StockMovement extends Omit<StockMovementRow, 'product_price_cents'> {
  product_price?: number;
}

export interface SaleRow {
  id: number;
  receipt_number: string;
  subtotal_cents: number;
  tax_rate_bps: number;
  tax_cents: number;
  discount_cents: number;
  total_cents: number;
  payment_method: PaymentMethod;
  amount_paid_cents: number;
  change_due_cents: number;
  customer_name: string | null;
  customer_phone: string | null;
  status: SaleStatus;
  cashier_id: number | null;
  cashier_name?: string | null;
  created_at: string;
  item_count?: number;
  refunded_cents?: number;
}

export interface SaleItemRow {
  id: number;
  sale_id: number;
  product_id: number;
  product_name: string;
  barcode: string;
  quantity: number;
  unit_price_cents: number;
  total_price_cents: number;
  unit?: string;
  department_name?: string;
  returned_quantity?: number;
}

export interface SaleItem {
  id: number;
  product_id: number;
  name: string;
  barcode: string;
  quantity: number;
  returned_quantity: number;
  unit_price: number;
  total_price: number;
  unit?: string;
  department_name?: string;
}

export interface ReturnRow {
  id: number;
  return_number: string;
  sale_id: number;
  kind: 'RETURN' | 'VOID';
  refund_cents: number;
  refund_method: PaymentMethod;
  reason: string | null;
  processed_by: number | null;
  created_at: string;
  receipt_number?: string;
  processed_by_name?: string | null;
}

export interface ReturnItemRow {
  id: number;
  return_id: number;
  sale_item_id: number;
  product_id: number | null;
  product_name: string;
  quantity: number;
  unit_price_cents: number;
  refund_cents: number;
  restock: boolean;
  condition: string | null;
}

export interface ReturnRecord {
  id: number;
  return_number: string;
  kind: 'RETURN' | 'VOID';
  sale_id: number;
  receipt_number?: string;
  refund: number;
  refund_method: PaymentMethod;
  reason: string | null;
  processed_by: number | null;
  processed_by_name: string | null;
  created_at: string;
  items?: Array<{
    sale_item_id: number;
    product_id: number | null;
    name: string;
    quantity: number;
    unit_price: number;
    refund: number;
    restock: boolean;
    condition: string | null;
  }>;
}

export interface Sale {
  id: number;
  receipt_number: string;
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  discount: number;
  total: number;
  payment_method: PaymentMethod;
  amount_paid: number;
  change_due: number;
  customer_name: string | null;
  customer_phone: string | null;
  status: SaleStatus;
  cashier_id: number | null;
  cashier_name: string | null;
  refunded_total: number;
  created_at: string;
  item_count?: number;
  items?: SaleItem[];
}

export interface Settings {
  store_name: string;
  currency: string;
  tax_rate_bps: number;
  return_window_days: number;
  refund_approval_threshold_cents: number;
}

export interface Pagination {
  total: number;
  limit: number;
  offset: number;
}
