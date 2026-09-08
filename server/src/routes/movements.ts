import { Router, Request, Response } from 'express';
import { db } from '../db';

export const movementRouter = Router();

// GET all stock movements with filtering
movementRouter.get('/', (req: Request, res: Response) => {
  try {
    const {
      product_id,
      department_id,
      type,
      search,
      start_date,
      end_date,
      limit = 100,
      offset = 0
    } = req.query;

    let whereClause = 'WHERE 1=1';
    const params: any[] = [];

    if (product_id) {
      whereClause += ' AND m.product_id = ?';
      params.push(product_id);
    }

    if (department_id) {
      whereClause += ' AND p.department_id = ?';
      params.push(department_id);
    }

    if (type) {
      whereClause += ' AND m.type = ?';
      params.push(type);
    }

    if (search) {
      whereClause += ' AND (p.name LIKE ? OR p.barcode LIKE ? OR m.reference_id LIKE ? OR m.reason LIKE ? OR m.customer_name LIKE ?)';
      const q = `%${search}%`;
      params.push(q, q, q, q, q);
    }

    if (start_date) {
      whereClause += ' AND m.created_at >= ?';
      params.push(start_date);
    }

    if (end_date) {
      whereClause += ' AND m.created_at <= ?';
      params.push(end_date);
    }

    const countSql = `
      SELECT COUNT(*) as count 
      FROM stock_movements m
      JOIN products p ON p.id = m.product_id
      ${whereClause}
    `;
    const totalCount = db.prepare(countSql).get(...params) as { count: number };

    const dataSql = `
      SELECT 
        m.*,
        p.name as product_name,
        p.barcode as product_barcode,
        p.sku as product_sku,
        p.unit as product_unit,
        p.price as product_price,
        d.id as department_id,
        d.name as department_name,
        d.code as department_code,
        d.color as department_color
      FROM stock_movements m
      JOIN products p ON p.id = m.product_id
      JOIN departments d ON d.id = p.department_id
      ${whereClause}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ? OFFSET ?
    `;

    const movements = db.prepare(dataSql).all(...params, Number(limit), Number(offset));

    res.json({
      success: true,
      data: movements,
      pagination: {
        total: totalCount.count,
        limit: Number(limit),
        offset: Number(offset)
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET summary metrics for movements
movementRouter.get('/summary', (req: Request, res: Response) => {
  try {
    const summary = db.prepare(`
      SELECT
        COUNT(*) as total_movements,
        COALESCE(SUM(CASE WHEN type = 'SALE' THEN ABS(quantity_change) ELSE 0 END), 0) as total_sold_units,
        COALESCE(SUM(CASE WHEN type = 'RESTOCK' THEN quantity_change ELSE 0 END), 0) as total_restocked_units,
        COALESCE(SUM(CASE WHEN type IN ('ADJUSTMENT_ADD', 'ADJUSTMENT_REMOVE') THEN ABS(quantity_change) ELSE 0 END), 0) as total_adjusted_units
      FROM stock_movements
    `).get();

    res.json({ success: true, data: summary });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET export CSV
movementRouter.get('/export-csv', (req: Request, res: Response) => {
  try {
    const movements = db.prepare(`
      SELECT 
        m.id,
        m.created_at,
        p.name as product_name,
        p.barcode as barcode,
        d.name as department,
        m.type,
        m.quantity_change,
        m.quantity_before,
        m.quantity_after,
        m.reference_id,
        m.customer_name,
        m.payment_method,
        m.reason
      FROM stock_movements m
      JOIN products p ON p.id = m.product_id
      JOIN departments d ON d.id = p.department_id
      ORDER BY m.created_at DESC, m.id DESC
    `).all() as any[];

    const headers = ['ID', 'Date Time', 'Product Name', 'Barcode', 'Department', 'Type', 'Quantity Change', 'Before', 'After', 'Customer / Purchaser', 'Payment', 'Reference / Receipt', 'Reason'];
    const rows = movements.map(m => [
      m.id,
      `"${m.created_at}"`,
      `"${m.product_name.replace(/"/g, '""')}"`,
      `"${m.barcode}"`,
      `"${m.department}"`,
      m.type,
      m.quantity_change,
      m.quantity_before,
      m.quantity_after,
      `"${(m.customer_name || '').replace(/"/g, '""')}"`,
      `"${(m.payment_method || '').replace(/"/g, '""')}"`,
      `"${(m.reference_id || '').replace(/"/g, '""')}"`,
      `"${(m.reason || '').replace(/"/g, '""')}"`
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="stock_movements_ledger.csv"');
    res.status(200).send(csvContent);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});
