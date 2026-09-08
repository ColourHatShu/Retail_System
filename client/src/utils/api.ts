import { Department, Product, StockMovement, Sale, CartItem } from '../types';

const API_BASE = '/api';

export async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  });

  const data = await response.json();
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `Request failed with status ${response.status}`);
  }

  return data.data;
}

// Departments API
export const api = {
  // Departments
  async getDepartments(): Promise<Department[]> {
    return fetchJson<Department[]>(`${API_BASE}/departments`);
  },
  async createDepartment(data: Partial<Department>): Promise<Department> {
    return fetchJson<Department>(`${API_BASE}/departments`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  async updateDepartment(id: number, data: Partial<Department>): Promise<Department> {
    return fetchJson<Department>(`${API_BASE}/departments/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  async deleteDepartment(id: number): Promise<{ message: string }> {
    return fetchJson<{ message: string }>(`${API_BASE}/departments/${id}`, {
      method: 'DELETE',
    });
  },

  // Products
  async getProducts(params?: { department_id?: number | string; search?: string; low_stock?: boolean }): Promise<Product[]> {
    const query = new URLSearchParams();
    if (params?.department_id) query.append('department_id', params.department_id.toString());
    if (params?.search) query.append('search', params.search);
    if (params?.low_stock) query.append('low_stock', 'true');
    const qs = query.toString();
    return fetchJson<Product[]>(`${API_BASE}/products${qs ? `?${qs}` : ''}`);
  },
  async getProductByBarcode(barcode: string): Promise<Product> {
    return fetchJson<Product>(`${API_BASE}/products/barcode/${encodeURIComponent(barcode.trim())}`);
  },
  async createProduct(data: Partial<Product>): Promise<Product> {
    return fetchJson<Product>(`${API_BASE}/products`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  async updateProduct(id: number, data: Partial<Product>): Promise<Product> {
    return fetchJson<Product>(`${API_BASE}/products/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  async deleteProduct(id: number): Promise<{ message: string }> {
    return fetchJson<{ message: string }>(`${API_BASE}/products/${id}`, {
      method: 'DELETE',
    });
  },

  // Inventory & Barcode Stock Adjustments
  async scanAdjustStock(data: {
    barcode: string;
    change_quantity: number;
    type: 'RESTOCK' | 'ADJUSTMENT_ADD' | 'ADJUSTMENT_REMOVE' | 'RETURN';
    reason?: string;
    reference_id?: string;
  }): Promise<{ product: Product; movement: StockMovement }> {
    return fetchJson<{ product: Product; movement: StockMovement }>(`${API_BASE}/inventory/scan-adjust`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  async setPhysicalCount(data: {
    barcode: string;
    actual_count: number;
    reason?: string;
  }): Promise<{ product: Product; movement: StockMovement | null }> {
    return fetchJson<{ product: Product; movement: StockMovement | null }>(`${API_BASE}/inventory/set-count`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  async importProductsBatch(items: any[]): Promise<{
    inserted_count: number;
    updated_count: number;
    created_departments: Department[];
    total_processed: number;
  }> {
    return fetchJson<{
      inserted_count: number;
      updated_count: number;
      created_departments: Department[];
      total_processed: number;
    }>(`${API_BASE}/inventory/import-batch`, {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
  },

  // POS Checkout
  async checkout(order: {
    items: Array<{
      product_id: number;
      barcode?: string;
      quantity: number;
      unit_price: number;
    }>;
    subtotal: number;
    tax_rate?: number;
    tax_amount?: number;
    discount?: number;
    total: number;
    payment_method: 'CASH' | 'CARD' | 'UPI_QR' | 'SPLIT';
    amount_paid: number;
    customer_name?: string;
    customer_phone?: string;
  }): Promise<Sale> {
    return fetchJson<Sale>(`${API_BASE}/sales/checkout`, {
      method: 'POST',
      body: JSON.stringify(order),
    });
  },
  async getSales(limit = 50, offset = 0): Promise<Sale[]> {
    return fetchJson<Sale[]>(`${API_BASE}/sales?limit=${limit}&offset=${offset}`);
  },

  // Movement History
  async getMovements(params?: {
    product_id?: number | string;
    department_id?: number | string;
    type?: string;
    search?: string;
    start_date?: string;
    end_date?: string;
    limit?: number;
    offset?: number;
  }): Promise<StockMovement[]> {
    const query = new URLSearchParams();
    if (params?.product_id) query.append('product_id', params.product_id.toString());
    if (params?.department_id) query.append('department_id', params.department_id.toString());
    if (params?.type) query.append('type', params.type);
    if (params?.search) query.append('search', params.search);
    if (params?.start_date) query.append('start_date', params.start_date);
    if (params?.end_date) query.append('end_date', params.end_date);
    if (params?.limit) query.append('limit', params.limit.toString());
    if (params?.offset) query.append('offset', params.offset.toString());
    const qs = query.toString();
    return fetchJson<StockMovement[]>(`${API_BASE}/movements${qs ? `?${qs}` : ''}`);
  },
  async getMovementSummary(): Promise<{
    total_movements: number;
    total_sold_units: number;
    total_restocked_units: number;
    total_adjusted_units: number;
  }> {
    return fetchJson<{
      total_movements: number;
      total_sold_units: number;
      total_restocked_units: number;
      total_adjusted_units: number;
    }>(`${API_BASE}/movements/summary`);
  },
};
