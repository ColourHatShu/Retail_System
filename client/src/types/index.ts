import type { TaxClass } from '../utils/tax';

export type Role = 'OWNER' | 'MANAGER' | 'CASHIER';

export interface User {
  id: number;
  tenant_id: number;
  username: string;
  display_name: string;
  role: Role;
  is_active: boolean;
  created_at: string;
  last_login_at: string | null;
  /** Present when a platform admin is switched into this store. */
  acting_admin_id?: number;
}

// ---------- platform admin ----------

export interface Tenant {
  id: number;
  slug: string;
  name: string;
  is_active: boolean;
  created_at: string;
  deactivated_at: string | null;
  owner_username?: string;
  user_count?: number;
  product_count?: number;
  sale_count?: number;
  last_sale_at?: string | null;
}

export interface PlatformAdmin {
  id: number;
  username: string;
  display_name: string;
  is_active: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface AdminAction {
  id: number;
  admin_id: number;
  admin_username?: string;
  action: string;
  tenant_id: number | null;
  tenant_name?: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  created_at: string;
}

export interface Department {
  id: number;
  name: string;
  code: string;
  description?: string;
  color?: string;
  product_count?: number;
  total_stock?: number;
  inventory_value?: number;
}

export interface Product {
  id: number;
  barcode: string;
  sku?: string;
  name: string;
  department_id: number;
  department_name?: string;
  department_code?: string;
  department_color?: string;
  price: number;
  cost_price?: number;
  stock_quantity: number;
  min_stock_level: number;
  unit: string;
  image_url?: string;
  /** Archived products keep their receipts but leave the catalogue and register. */
  is_active?: boolean;
  /** STANDARD = full tax, GST_ONLY = no provincial part, EXEMPT = no tax. */
  tax_class?: TaxClass;
  created_at?: string;
  updated_at?: string;
}

export type MovementType = 'INITIAL' | 'RESTOCK' | 'SALE' | 'ADJUSTMENT_ADD' | 'ADJUSTMENT_REMOVE' | 'RETURN';

export interface StockMovement {
  id: number;
  product_id: number;
  type: MovementType;
  quantity_change: number;
  quantity_before: number;
  quantity_after: number;
  reference_id?: string;
  reason?: string;
  created_at: string;
  product_name?: string;
  product_barcode?: string;
  product_sku?: string;
  product_unit?: string;
  product_price?: number;
  customer_name?: string;
  customer_phone?: string;
  payment_method?: string;
  sale_id?: number;
  user_id?: number | null;
  user_name?: string | null;
  department_id?: number;
  department_name?: string;
  department_code?: string;
  department_color?: string;
}

export interface CartItem {
  product: Product;
  quantity: number;
  /** Catalogue price; kept in step with the product list. */
  unit_price: number;
  /** A manager's price for this line, per unit. */
  price_override?: number;
  /** Money off the whole line. */
  line_discount?: number;
}

export interface Sale {
  id: number;
  receipt_number: string;
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  /** GST or HST (CRA). Equals tax_amount on receipts from before the province split. */
  gst_amount?: number;
  /** PST / QST / RST (province). */
  pst_amount?: number;
  gst_rate?: number;
  pst_rate?: number;
  tax_labels?: { gst: string; pst: string | null };
  gst_number?: string | null;
  pst_number?: string | null;
  discount: number;
  total: number;
  payment_method: 'CASH' | 'CARD' | 'DEBIT' | 'CREDIT' | 'UPI_QR' | 'SPLIT';
  /** Every tender on the sale; cash as handed over (change_due went back). */
  payments?: Array<{ method: string; amount: number }>;
  customer_id?: number | null;
  points_earned?: number;
  /** Present when the register rang this up offline. */
  client_ref?: string | null;
  /** Local-only: queued offline and not yet on the server. */
  pending_sync?: boolean;
  amount_paid: number;
  change_due: number;
  customer_name?: string;
  customer_phone?: string;
  cashier_id?: number | null;
  cashier_name?: string | null;
  status?: SaleStatus;
  refunded_total?: number;
  created_at: string;
  items?: Array<{
    id: number;
    product_id: number;
    name: string;
    barcode: string;
    quantity: number;
    returned_quantity?: number;
    unit_price: number;
    total_price: number;
    list_price?: number;
    line_discount?: number;
    unit?: string;
  }>;
}

export type SaleStatus = 'COMPLETED' | 'PARTIALLY_REFUNDED' | 'REFUNDED' | 'VOIDED';

export type ReturnCondition = 'RESALABLE' | 'DAMAGED' | 'EXPIRED' | 'DEFECTIVE' | 'OTHER';

export interface ReturnRecord {
  id: number;
  return_number: string;
  kind: 'RETURN' | 'VOID';
  sale_id: number;
  receipt_number?: string;
  refund: number;
  gst_amount?: number;
  pst_amount?: number;
  refund_method: 'CASH' | 'CARD' | 'DEBIT' | 'CREDIT' | 'UPI_QR';
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

export interface ReturnLineInput {
  sale_item_id: number;
  quantity: number;
  restock: boolean;
  condition: ReturnCondition;
}

export interface ReturnQuote {
  sale: Sale;
  lines: Array<{ sale_item_id: number; name: string; quantity: number; restock: boolean; condition: string; refund: number }>;
  refund: number;
  refund_method: 'CASH' | 'CARD' | 'UPI_QR';
  completes_sale: boolean;
  requires_manager: boolean;
  window_closed: boolean;
  allowed: boolean;
  blocked_reason: string | null;
}
