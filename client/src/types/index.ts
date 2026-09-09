export type Role = 'OWNER' | 'MANAGER' | 'CASHIER';

export interface User {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  is_active: boolean;
  created_at: string;
  last_login_at: string | null;
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
  unit_price: number;
}

export interface Sale {
  id: number;
  receipt_number: string;
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  discount: number;
  total: number;
  payment_method: 'CASH' | 'CARD' | 'UPI_QR' | 'SPLIT';
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
  refund_method: 'CASH' | 'CARD' | 'UPI_QR';
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
