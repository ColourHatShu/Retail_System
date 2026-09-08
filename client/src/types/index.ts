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
  created_at: string;
  items?: Array<{
    product_id: number;
    name: string;
    barcode: string;
    quantity: number;
    unit_price: number;
    total_price: number;
    unit?: string;
  }>;
}
