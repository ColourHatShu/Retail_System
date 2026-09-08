import { Router, Request, Response } from 'express';
import { db } from '../db';

export const productRouter = Router();

// GET all products with filtering options
productRouter.get('/', (req: Request, res: Response) => {
  try {
    const { department_id, search, low_stock } = req.query;

    let sql = `
      SELECT 
        p.*,
        d.name as department_name,
        d.code as department_code,
        d.color as department_color
      FROM products p
      JOIN departments d ON d.id = p.department_id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (department_id) {
      sql += ' AND p.department_id = ?';
      params.push(department_id);
    }

    if (search) {
      sql += ' AND (p.name LIKE ? OR p.barcode LIKE ? OR p.sku LIKE ?)';
      const query = `%${search}%`;
      params.push(query, query, query);
    }

    if (low_stock === 'true') {
      sql += ' AND p.stock_quantity <= p.min_stock_level';
    }

    sql += ' ORDER BY p.name ASC';

    const products = db.prepare(sql).all(...params);
    res.json({ success: true, data: products });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET product by barcode (primary lookup for scanners)
productRouter.get('/barcode/:barcode', (req: Request, res: Response) => {
  try {
    const { barcode } = req.params;
    const product = db.prepare(`
      SELECT 
        p.*,
        d.name as department_name,
        d.code as department_code,
        d.color as department_color
      FROM products p
      JOIN departments d ON d.id = p.department_id
      WHERE p.barcode = ?
    `).get(barcode.trim());

    if (!product) {
      return res.status(404).json({ success: false, error: `Product with barcode ${barcode} not found` });
    }

    res.json({ success: true, data: product });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET product by id
productRouter.get('/:id', (req: Request, res: Response) => {
  try {
    const product = db.prepare(`
      SELECT 
        p.*,
        d.name as department_name,
        d.code as department_code,
        d.color as department_color
      FROM products p
      JOIN departments d ON d.id = p.department_id
      WHERE p.id = ?
    `).get(req.params.id);

    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    res.json({ success: true, data: product });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST create product (and log initial stock movement in transaction)
productRouter.post('/', (req: Request, res: Response) => {
  try {
    const {
      barcode,
      sku,
      name,
      department_id,
      price,
      cost_price = 0,
      stock_quantity = 0,
      min_stock_level = 5,
      unit = 'pcs',
      image_url = null
    } = req.body;

    if (!barcode || !name || !department_id || price === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Barcode, Name, Department, and Price are required fields'
      });
    }

    const cleanBarcode = barcode.trim();
    const cleanName = name.trim();
    const deptId = Number(department_id);
    const parsedPrice = parseFloat(price);
    const parsedCost = parseFloat(cost_price) || 0;
    const parsedStock = parseInt(stock_quantity, 10) || 0;
    const parsedMinStock = parseInt(min_stock_level, 10) || 5;

    // Check department exists
    const dept = db.prepare('SELECT id FROM departments WHERE id = ?').get(deptId);
    if (!dept) {
      return res.status(400).json({ success: false, error: 'Selected Department does not exist' });
    }

    // Execute product creation and initial movement log in transaction
    const createTx = db.transaction(() => {
      const insertProduct = db.prepare(`
        INSERT INTO products (
          barcode, sku, name, department_id, price, cost_price, 
          stock_quantity, min_stock_level, unit, image_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const res = insertProduct.run(
        cleanBarcode,
        sku ? sku.trim() : null,
        cleanName,
        deptId,
        parsedPrice,
        parsedCost,
        parsedStock,
        parsedMinStock,
        unit ? unit.trim() : 'pcs',
        image_url
      );

      const newProductId = Number(res.lastInsertRowid);

      if (parsedStock > 0) {
        db.prepare(`
          INSERT INTO stock_movements (
            product_id, type, quantity_change, quantity_before, quantity_after, reference_id, reason
          ) VALUES (?, 'INITIAL', ?, 0, ?, 'INIT-CREATE', 'Initial stock on product creation')
        `).run(newProductId, parsedStock, parsedStock);
      }

      return newProductId;
    });

    const newProductId = createTx();
    const createdProduct = db.prepare(`
      SELECT 
        p.*,
        d.name as department_name,
        d.code as department_code,
        d.color as department_color
      FROM products p
      JOIN departments d ON d.id = p.department_id
      WHERE p.id = ?
    `).get(newProductId);

    res.status(201).json({ success: true, data: createdProduct });
  } catch (error: any) {
    if (error.message.includes('UNIQUE constraint failed: products.barcode')) {
      return res.status(409).json({ success: false, error: 'A product with this barcode already exists' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT update product
productRouter.put('/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      barcode,
      sku,
      name,
      department_id,
      price,
      cost_price,
      min_stock_level,
      unit,
      image_url
    } = req.body;

    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as any;
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    const update = db.prepare(`
      UPDATE products 
      SET barcode = COALESCE(?, barcode),
          sku = COALESCE(?, sku),
          name = COALESCE(?, name),
          department_id = COALESCE(?, department_id),
          price = COALESCE(?, price),
          cost_price = COALESCE(?, cost_price),
          min_stock_level = COALESCE(?, min_stock_level),
          unit = COALESCE(?, unit),
          image_url = COALESCE(?, image_url),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    update.run(
      barcode !== undefined ? barcode.trim() : null,
      sku !== undefined ? (sku ? sku.trim() : null) : null,
      name !== undefined ? name.trim() : null,
      department_id !== undefined ? Number(department_id) : null,
      price !== undefined ? parseFloat(price) : null,
      cost_price !== undefined ? parseFloat(cost_price) : null,
      min_stock_level !== undefined ? parseInt(min_stock_level, 10) : null,
      unit !== undefined ? unit.trim() : null,
      image_url !== undefined ? image_url : null,
      id
    );

    const updated = db.prepare(`
      SELECT 
        p.*,
        d.name as department_name,
        d.code as department_code,
        d.color as department_color
      FROM products p
      JOIN departments d ON d.id = p.department_id
      WHERE p.id = ?
    `).get(id);

    res.json({ success: true, data: updated });
  } catch (error: any) {
    if (error.message.includes('UNIQUE constraint failed: products.barcode')) {
      return res.status(409).json({ success: false, error: 'A product with this barcode already exists' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE product
productRouter.delete('/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT id FROM products WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    db.prepare('DELETE FROM products WHERE id = ?').run(id);
    res.json({ success: true, message: 'Product deleted successfully' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});
