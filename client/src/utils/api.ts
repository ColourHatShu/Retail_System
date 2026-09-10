import { Department, Product, StockMovement, Sale, User, Role, ReturnRecord, ReturnLineInput, ReturnQuote } from '../types';
import { getToken, notifyUnauthorized } from './auth';

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) || '/api';

/** Sign-in endpoints return 401 for bad credentials; that must not end the current session. */
const AUTH_ENDPOINTS = [`${API_BASE}/auth/login`, `${API_BASE}/auth/setup`];

/**
 * Error thrown for any failed API call. `code` is the machine-readable code
 * from the server envelope (e.g. 'PRICE_CHANGED', 'INSUFFICIENT_STOCK',
 * 'VALIDATION_ERROR') so callers can branch without parsing messages.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  let response: Response;
  const token = getToken();
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options?.headers,
      },
    });
  } catch (err) {
    throw new ApiError('Cannot reach the server. Check the connection and that the server is running.', 'NETWORK_ERROR', 0, err);
  }

  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON body (e.g. a proxy error page); fall through to the status check.
  }

  if (response.status === 401 && !AUTH_ENDPOINTS.includes(url)) {
    notifyUnauthorized();
  }

  if (!response.ok || body?.success === false) {
    throw new ApiError(
      body?.error || `Request failed with status ${response.status}`,
      body?.code || 'HTTP_ERROR',
      response.status,
      body?.details,
    );
  }

  return body.data;
}

function withQuery(path: string, params: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '' && value !== false) query.append(key, String(value));
  }
  const qs = query.toString();
  return `${API_BASE}${path}${qs ? `?${qs}` : ''}`;
}

const post = <T>(path: string, body: unknown) =>
  fetchJson<T>(`${API_BASE}${path}`, { method: 'POST', body: JSON.stringify(body) });
const put = <T>(path: string, body: unknown) =>
  fetchJson<T>(`${API_BASE}${path}`, { method: 'PUT', body: JSON.stringify(body) });
const del = <T>(path: string) => fetchJson<T>(`${API_BASE}${path}`, { method: 'DELETE' });

/** What the server returns for GET /products/lookup/:barcode. */
export interface BarcodeLookupResult {
  found: boolean;
  barcode: string;
  name?: string;
  brand?: string;
  departmentId?: number;
  departmentName?: string;
  unit?: string;
  sku?: string;
  source?: string;
  /** True when the answer came from the server's cache, not a live registry call. */
  cached: boolean;
}

export interface StoreSettings {
  store_name: string;
  currency: string;
  tax_rate_percent: number;
  return_window_days: number;
  refund_approval_threshold: number;
}

export interface ReturnRequest {
  sale_id?: number;
  receipt_number?: string;
  items: ReturnLineInput[];
  reason?: string;
}

export interface ImportResult {
  inserted_count: number;
  updated_count: number;
  created_departments: Department[];
  total_processed: number;
  skipped: Array<{ row: number; reason: string }>;
}

export interface SessionResult {
  user: User;
  token: string;
  expires_at: string;
}

export const api = {
  // Authentication
  getAuthStatus: () => fetchJson<{ needs_setup: boolean }>(`${API_BASE}/auth/status`),
  setupOwner: (data: { username: string; password: string; display_name: string }) =>
    post<SessionResult>('/auth/setup', data),
  login: (data: { username: string; password: string }) => post<SessionResult>('/auth/login', data),
  logout: () => post<{ message: string }>('/auth/logout', {}),
  me: () => fetchJson<User>(`${API_BASE}/auth/me`),
  changePassword: (data: { current_password: string; new_password: string }) =>
    post<{ message: string }>('/auth/change-password', data),

  // Staff (owner only)
  getUsers: () => fetchJson<User[]>(`${API_BASE}/users`),
  createUser: (data: { username: string; password: string; display_name: string; role: Role }) =>
    post<User>('/users', data),
  updateUser: (id: number, data: { display_name?: string; role?: Role; is_active?: boolean; password?: string }) =>
    put<User>(`/users/${id}`, data),

  // Store settings (tax rate, currency)
  getSettings: () => fetchJson<StoreSettings>(`${API_BASE}/settings`),
  updateSettings: (data: Partial<StoreSettings>) => put<StoreSettings>('/settings', data),

  // Departments
  getDepartments: () => fetchJson<Department[]>(`${API_BASE}/departments`),
  createDepartment: (data: Partial<Department>) => post<Department>('/departments', data),
  updateDepartment: (id: number, data: Partial<Department>) => put<Department>(`/departments/${id}`, data),
  deleteDepartment: (id: number) => del<{ message: string }>(`/departments/${id}`),

  // Products
  getProducts: (params?: {
    department_id?: number | string;
    search?: string;
    low_stock?: boolean;
    include_archived?: boolean;
  }) =>
    fetchJson<Product[]>(
      withQuery('/products', {
        department_id: params?.department_id,
        search: params?.search,
        low_stock: params?.low_stock ? 'true' : undefined,
        include_archived: params?.include_archived ? 'true' : undefined,
      }),
    ),
  /**
   * Retires a product that cannot be deleted because it appears on receipts.
   * It leaves the catalogue and the register; its sales history stays intact.
   */
  archiveProduct: (id: number) => put<Product>(`/products/${id}`, { is_active: false }),
  restoreProduct: (id: number) => put<Product>(`/products/${id}`, { is_active: true }),
  getProductByBarcode: (barcode: string) =>
    fetchJson<Product>(`${API_BASE}/products/barcode/${encodeURIComponent(barcode.trim())}`),
  /** Enriches an unknown barcode from the public registries, via the server. */
  lookupBarcode: (barcode: string) =>
    fetchJson<BarcodeLookupResult>(`${API_BASE}/products/lookup/${encodeURIComponent(barcode.trim())}`),
  createProduct: (data: Partial<Product>) => post<Product>('/products', data),
  updateProduct: (id: number, data: Partial<Product>) => put<Product>(`/products/${id}`, data),
  deleteProduct: (id: number) => del<{ message: string }>(`/products/${id}`),

  // Inventory & barcode stock adjustments
  scanAdjustStock: (data: {
    barcode: string;
    change_quantity: number;
    type: 'RESTOCK' | 'ADJUSTMENT_ADD' | 'ADJUSTMENT_REMOVE' | 'RETURN';
    reason?: string;
    reference_id?: string;
  }) => post<{ product: Product; movement: StockMovement }>('/inventory/scan-adjust', data),
  setPhysicalCount: (data: { barcode: string; actual_count: number; reason?: string }) =>
    post<{ product: Product; movement: StockMovement | null }>('/inventory/set-count', data),
  importProductsBatch: (items: any[]) => post<ImportResult>('/inventory/import-batch', { items }),

  // POS checkout. The server recomputes every amount from the catalogue; the
  // price fields below are informational and `expected_total` is the guard.
  checkout: (order: {
    items: Array<{ product_id: number; barcode?: string; quantity: number; unit_price: number }>;
    subtotal: number;
    tax_rate?: number;
    tax_amount?: number;
    discount?: number;
    total: number;
    expected_total?: number;
    payment_method: 'CASH' | 'CARD';
    amount_paid: number;
    customer_name?: string;
    customer_phone?: string;
  }) => post<Sale>('/sales/checkout', order),
  getSales: (limit = 50, offset = 0) => fetchJson<Sale[]>(withQuery('/sales', { limit, offset })),
  getSale: (id: number) => fetchJson<Sale>(`${API_BASE}/sales/${id}`),
  getSaleByReceipt: (receiptNumber: string) =>
    fetchJson<Sale>(`${API_BASE}/sales/receipt/${encodeURIComponent(receiptNumber.trim())}`),
  voidSale: (id: number, reason: string) => post<ReturnRecord>(`/sales/${id}/void`, { reason }),

  // Returns & refunds
  quoteReturn: (req: ReturnRequest) => post<ReturnQuote>('/returns/quote', req),
  createReturn: (req: ReturnRequest) => post<ReturnRecord>('/returns', req),
  getReturns: (limit = 20, offset = 0) => fetchJson<ReturnRecord[]>(withQuery('/returns', { limit, offset })),
  getReturn: (id: number) => fetchJson<ReturnRecord>(`${API_BASE}/returns/${id}`),

  // Movement history
  getMovements: (params?: {
    product_id?: number | string;
    department_id?: number | string;
    type?: string;
    search?: string;
    start_date?: string;
    end_date?: string;
    limit?: number;
    offset?: number;
  }) => fetchJson<StockMovement[]>(withQuery('/movements', { ...params })),
  getMovementSummary: () =>
    fetchJson<{
      total_movements: number;
      total_sold_units: number;
      total_restocked_units: number;
      total_adjusted_units: number;
      total_returned_units: number;
    }>(`${API_BASE}/movements/summary`),
};
