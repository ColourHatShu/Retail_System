import { getPool, row, rows } from '../db';
import type { MovementsQuery } from '../schemas';
import type { Pagination, StockMovement, StockMovementRow } from '../types';
import { serializeMovement } from './ledger';

const MOVEMENT_SELECT = `
  SELECT
    m.*,
    p.name         AS product_name,
    p.barcode      AS product_barcode,
    p.sku          AS product_sku,
    p.unit         AS product_unit,
    p.price_cents  AS product_price_cents,
    d.id           AS department_id,
    d.name         AS department_name,
    d.code         AS department_code,
    d.color        AS department_color,
    u.display_name AS user_name
  FROM stock_movements m
  JOIN products p ON p.id = m.product_id
  JOIN departments d ON d.id = p.department_id
  LEFT JOIN users u ON u.id = m.user_id
`;

function buildWhere(q: MovementsQuery): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (clause: (n: number) => string, value: unknown) => {
    params.push(value);
    clauses.push(clause(params.length));
  };

  if (q.product_id !== undefined) add((n) => `m.product_id = $${n}`, q.product_id);
  if (q.department_id !== undefined) add((n) => `p.department_id = $${n}`, q.department_id);
  if (q.type) add((n) => `m.type = $${n}`, q.type);
  if (q.search) {
    add(
      (n) =>
        `(p.name ILIKE $${n} OR p.barcode ILIKE $${n} OR m.reference_id ILIKE $${n} OR m.reason ILIKE $${n} OR m.customer_name ILIKE $${n})`,
      `%${q.search}%`,
    );
  }
  if (q.start_date) add((n) => `m.created_at >= $${n}::timestamptz`, q.start_date);
  if (q.end_date) add((n) => `m.created_at <= $${n}::timestamptz`, q.end_date);

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export async function listMovements(q: MovementsQuery): Promise<{ data: StockMovement[]; pagination: Pagination }> {
  const db = getPool();
  const { where, params } = buildWhere(q);

  const { total } = (await row<{ total: number }>(
    db,
    `SELECT COUNT(*) AS total FROM stock_movements m JOIN products p ON p.id = m.product_id ${where}`,
    params,
  ))!;

  const list = await rows<StockMovementRow>(
    db,
    `${MOVEMENT_SELECT} ${where} ORDER BY m.created_at DESC, m.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, q.limit, q.offset],
  );

  return { data: list.map(serializeMovement), pagination: { total, limit: q.limit, offset: q.offset } };
}

export interface MovementSummary {
  total_movements: number;
  total_sold_units: number;
  total_restocked_units: number;
  total_adjusted_units: number;
  total_returned_units: number;
}

export async function getMovementSummary(): Promise<MovementSummary> {
  return (await row<MovementSummary>(
    getPool(),
    `SELECT
       COUNT(*) AS total_movements,
       COALESCE(SUM(CASE WHEN type = 'SALE' THEN -quantity_change ELSE 0 END), 0) AS total_sold_units,
       COALESCE(SUM(CASE WHEN type = 'RESTOCK' THEN quantity_change ELSE 0 END), 0) AS total_restocked_units,
       COALESCE(SUM(CASE WHEN type IN ('ADJUSTMENT_ADD', 'ADJUSTMENT_REMOVE') THEN ABS(quantity_change) ELSE 0 END), 0) AS total_adjusted_units,
       COALESCE(SUM(CASE WHEN type = 'RETURN' THEN quantity_change ELSE 0 END), 0) AS total_returned_units
     FROM stock_movements`,
  ))!;
}

/**
 * RFC 4180 cell escaping plus a guard against spreadsheet formula injection
 * (a cell starting with = + - @ would otherwise execute when opened in Excel).
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function exportMovementsCsv(): Promise<string> {
  const list = await rows<StockMovementRow>(getPool(), `${MOVEMENT_SELECT} ORDER BY m.created_at DESC, m.id DESC`);

  const header = [
    'ID', 'Date Time', 'Product Name', 'Barcode', 'Department', 'Type',
    'Quantity Change', 'Before', 'After', 'User', 'Customer', 'Payment', 'Reference', 'Reason',
  ];

  const lines = list.map((m) =>
    [
      m.id, m.created_at, m.product_name, m.product_barcode, m.department_name, m.type,
      m.quantity_change, m.quantity_before, m.quantity_after, m.user_name,
      m.customer_name, m.payment_method, m.reference_id, m.reason,
    ]
      .map(csvCell)
      .join(','),
  );

  return [header.join(','), ...lines].join('\r\n');
}
