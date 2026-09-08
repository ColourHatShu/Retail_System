import { Router, Request, Response } from 'express';
import { db } from '../db';

export const inventoryRouter = Router();

// POST /api/inventory/scan-adjust
// Adjust stock via barcode scan (Increase / Decrease)
inventoryRouter.post('/scan-adjust', (req: Request, res: Response) => {
  try {
    const { barcode, change_quantity, type, reason, reference_id } = req.body;

    if (!barcode || change_quantity === undefined || !type) {
      return res.status(400).json({
        success: false,
        error: 'Barcode, change_quantity, and type are required'
      });
    }

    const cleanBarcode = barcode.trim();
    const qtyChange = parseInt(change_quantity, 10);
    if (isNaN(qtyChange) || qtyChange === 0) {
      return res.status(400).json({
        success: false,
        error: 'change_quantity must be a non-zero integer'
      });
    }

    const validTypes = ['RESTOCK', 'ADJUSTMENT_ADD', 'ADJUSTMENT_REMOVE', 'RETURN'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        error: `Invalid type. Must be one of: ${validTypes.join(', ')}`
      });
    }

    // Determine sign: If ADJUSTMENT_REMOVE, ensure it's negative delta.
    // If RESTOCK or ADJUSTMENT_ADD or RETURN, ensure positive delta.
    let delta = qtyChange;
    if (type === 'ADJUSTMENT_REMOVE') {
      delta = -Math.abs(qtyChange);
    } else {
      delta = Math.abs(qtyChange);
    }

    const adjustTx = db.transaction(() => {
      const product = db.prepare(`
        SELECT p.*, d.name as department_name, d.color as department_color
        FROM products p
        JOIN departments d ON d.id = p.department_id
        WHERE p.barcode = ?
      `).get(cleanBarcode) as any;

      if (!product) {
        throw new Error(`Product with barcode "${cleanBarcode}" was not found in inventory.`);
      }

      const qtyBefore = product.stock_quantity;
      const qtyAfter = qtyBefore + delta;

      if (qtyAfter < 0) {
        throw new Error(`Cannot reduce stock below 0. Current stock is ${qtyBefore}, attempted deduction is ${Math.abs(delta)}.`);
      }

      // Update product stock
      db.prepare(`
        UPDATE products
        SET stock_quantity = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(qtyAfter, product.id);

      // Insert stock movement record
      const defaultReason = type === 'RESTOCK' 
        ? 'Restock shipment received'
        : type === 'ADJUSTMENT_REMOVE'
        ? (reason || 'Inventory reduction / write-off')
        : (reason || 'Stock adjustment');

      const movRes = db.prepare(`
        INSERT INTO stock_movements (
          product_id, type, quantity_change, quantity_before, quantity_after, reference_id, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        product.id,
        type,
        delta,
        qtyBefore,
        qtyAfter,
        reference_id || (type === 'RESTOCK' ? 'SCAN-IN' : 'SCAN-OUT'),
        defaultReason
      );

      const movement = db.prepare('SELECT * FROM stock_movements WHERE id = ?').get(movRes.lastInsertRowid);

      const updatedProduct = db.prepare(`
        SELECT p.*, d.name as department_name, d.color as department_color
        FROM products p
        JOIN departments d ON d.id = p.department_id
        WHERE p.id = ?
      `).get(product.id);

      return { product: updatedProduct, movement };
    });

    const result = adjustTx();
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /api/inventory/set-count
// Directly update physical stock count from audit
inventoryRouter.post('/set-count', (req: Request, res: Response) => {
  try {
    const { barcode, actual_count, reason } = req.body;

    if (!barcode || actual_count === undefined) {
      return res.status(400).json({ success: false, error: 'Barcode and actual_count are required' });
    }

    const cleanBarcode = barcode.trim();
    const targetCount = parseInt(actual_count, 10);
    if (isNaN(targetCount) || targetCount < 0) {
      return res.status(400).json({ success: false, error: 'actual_count must be a positive integer or 0' });
    }

    const countTx = db.transaction(() => {
      const product = db.prepare(`
        SELECT p.*, d.name as department_name, d.color as department_color
        FROM products p
        JOIN departments d ON d.id = p.department_id
        WHERE p.barcode = ?
      `).get(cleanBarcode) as any;

      if (!product) {
        throw new Error(`Product with barcode "${cleanBarcode}" was not found.`);
      }

      const qtyBefore = product.stock_quantity;
      const delta = targetCount - qtyBefore;

      if (delta === 0) {
        return { product, movement: null, message: 'Stock already matches physical count' };
      }

      const type = delta > 0 ? 'ADJUSTMENT_ADD' : 'ADJUSTMENT_REMOVE';

      db.prepare(`
        UPDATE products
        SET stock_quantity = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(targetCount, product.id);

      const movRes = db.prepare(`
        INSERT INTO stock_movements (
          product_id, type, quantity_change, quantity_before, quantity_after, reference_id, reason
        ) VALUES (?, ?, ?, ?, ?, 'STOCK-AUDIT', ?)
      `).run(
        product.id,
        type,
        delta,
        qtyBefore,
        targetCount,
        reason || 'Physical cycle count adjustment'
      );

      const movement = db.prepare('SELECT * FROM stock_movements WHERE id = ?').get(movRes.lastInsertRowid);
      const updatedProduct = db.prepare(`
        SELECT p.*, d.name as department_name, d.color as department_color
        FROM products p
        JOIN departments d ON d.id = p.department_id
        WHERE p.id = ?
      `).get(product.id);

      return { product: updatedProduct, movement };
    });

    const result = countTx();
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /api/inventory/import-batch
// Bulk import from Excel / CSV with auto-creation of departments
inventoryRouter.post('/import-batch', (req: Request, res: Response) => {
  try {
    const { items } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'No items provided for import' });
    }

    const PRESET_COLORS = ['#0ea5e9', '#10b981', '#6366f1', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#f43f5e'];

    const importTx = db.transaction(() => {
      // 1. Build map of existing departments: lowercase name -> department
      const allDepts = db.prepare('SELECT * FROM departments').all() as any[];
      const deptMapByName = new Map<string, any>();
      const existingCodes = new Set<string>();

      for (const d of allDepts) {
        deptMapByName.set(d.name.trim().toLowerCase(), d);
        existingCodes.add(d.code.toUpperCase());
      }

      const createdDepartments: any[] = [];
      let insertedProductsCount = 0;
      let updatedProductsCount = 0;

      for (const rawItem of items) {
        if (!rawItem.name || !rawItem.barcode) continue;

        const cleanName = String(rawItem.name).trim();
        const cleanBarcode = String(rawItem.barcode).trim();
        const cleanDeptName = String(rawItem.department || 'General').trim();
        const price = parseFloat(rawItem.price) || 0;
        const costPrice = parseFloat(rawItem.cost_price || rawItem.cost) || 0;
        const stockQty = parseInt(rawItem.stock_quantity || rawItem.stock, 10) || 0;
        const minStock = parseInt(rawItem.min_stock_level || rawItem.min_stock, 10) || 5;
        const unit = String(rawItem.unit || 'pcs').trim();
        const sku = rawItem.sku ? String(rawItem.sku).trim() : null;

        // Auto-create department if not exists
        let dept = deptMapByName.get(cleanDeptName.toLowerCase());
        if (!dept) {
          // Generate unique 3-4 letter code
          let baseCode = cleanDeptName.replace(/[^a-zA-Z]/g, '').substring(0, 4).toUpperCase();
          if (baseCode.length < 2) baseCode = 'DEPT';
          let finalCode = baseCode;
          let counter = 1;
          while (existingCodes.has(finalCode)) {
            finalCode = `${baseCode.substring(0, 3)}${counter++}`;
          }
          existingCodes.add(finalCode);

          const randomColor = PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)];

          const insDept = db.prepare(`
            INSERT INTO departments (name, code, description, color)
            VALUES (?, ?, ?, ?)
          `).run(cleanDeptName, finalCode, `Auto-created from Excel import`, randomColor);

          dept = {
            id: Number(insDept.lastInsertRowid),
            name: cleanDeptName,
            code: finalCode,
            color: randomColor
          };

          deptMapByName.set(cleanDeptName.toLowerCase(), dept);
          createdDepartments.push(dept);
        }

        // Check if product already exists by barcode
        const existingProduct = db.prepare('SELECT * FROM products WHERE barcode = ?').get(cleanBarcode) as any;

        if (existingProduct) {
          // Update product details and increment stock
          const newStock = existingProduct.stock_quantity + stockQty;
          db.prepare(`
            UPDATE products
            SET name = ?,
                department_id = ?,
                price = ?,
                cost_price = ?,
                stock_quantity = ?,
                min_stock_level = ?,
                unit = ?,
                sku = COALESCE(?, sku),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(cleanName, dept.id, price, costPrice, newStock, minStock, unit, sku, existingProduct.id);

          if (stockQty > 0) {
            db.prepare(`
              INSERT INTO stock_movements (
                product_id, type, quantity_change, quantity_before, quantity_after, reference_id, reason
              ) VALUES (?, 'RESTOCK', ?, ?, ?, 'EXCEL-IMPORT', 'Restock imported from spreadsheet')
            `).run(existingProduct.id, stockQty, existingProduct.stock_quantity, newStock);
          }

          updatedProductsCount++;
        } else {
          // Insert new product
          const insProd = db.prepare(`
            INSERT INTO products (
              barcode, sku, name, department_id, price, cost_price, stock_quantity, min_stock_level, unit
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(cleanBarcode, sku, cleanName, dept.id, price, costPrice, stockQty, minStock, unit);

          const newProdId = Number(insProd.lastInsertRowid);

          if (stockQty > 0) {
            db.prepare(`
              INSERT INTO stock_movements (
                product_id, type, quantity_change, quantity_before, quantity_after, reference_id, reason
              ) VALUES (?, 'INITIAL', ?, 0, ?, 'EXCEL-IMPORT', 'Initial stock from spreadsheet import')
            `).run(newProdId, stockQty, stockQty);
          }

          insertedProductsCount++;
        }
      }

      return {
        inserted_count: insertedProductsCount,
        updated_count: updatedProductsCount,
        created_departments: createdDepartments,
        total_processed: insertedProductsCount + updatedProductsCount
      };
    });

    const result = importTx();
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

