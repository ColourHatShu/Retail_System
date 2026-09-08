import { Router, Request, Response } from 'express';
import { db } from '../db';

export const salesRouter = Router();

// GET all sales
salesRouter.get('/', (req: Request, res: Response) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const sales = db.prepare(`
      SELECT s.*, 
        (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) as item_count
      FROM sales s
      ORDER BY s.created_at DESC
      LIMIT ? OFFSET ?
    `).all(Number(limit), Number(offset));

    const totalCount = db.prepare('SELECT COUNT(*) as count FROM sales').get() as { count: number };

    res.json({
      success: true,
      data: sales,
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

// GET single sale with item details
salesRouter.get('/:id', (req: Request, res: Response) => {
  try {
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id) as any;
    if (!sale) {
      return res.status(404).json({ success: false, error: 'Sale record not found' });
    }

    const items = db.prepare(`
      SELECT si.*, p.unit, d.name as department_name
      FROM sale_items si
      JOIN products p ON p.id = si.product_id
      JOIN departments d ON d.id = p.department_id
      WHERE si.sale_id = ?
    `).all(sale.id);

    res.json({ success: true, data: { ...sale, items } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST checkout - processes order, deducts inventory, records movements
salesRouter.post('/checkout', (req: Request, res: Response) => {
  try {
    const {
      items,
      subtotal,
      tax_rate = 0,
      tax_amount = 0,
      discount = 0,
      total,
      payment_method = 'CASH',
      amount_paid,
      customer_name,
      customer_phone
    } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'Checkout requires at least one item' });
    }

    if (total === undefined || amount_paid === undefined) {
      return res.status(400).json({ success: false, error: 'Total and amount_paid are required' });
    }

    const parsedTotal = Math.round(Number(total) * 100) / 100;
    const parsedAmountPaid = Math.round(Number(amount_paid) * 100) / 100;

    if (payment_method === 'CASH' && parsedAmountPaid < parsedTotal) {
      return res.status(400).json({
        success: false,
        error: `Insufficient payment: Received $${parsedAmountPaid.toFixed(2)}, required $${parsedTotal.toFixed(2)}`
      });
    }

    const changeDue = Math.max(0, Math.round((parsedAmountPaid - parsedTotal) * 100) / 100);

    // Generate unique receipt number e.g. REC-20260909-A49F
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randSuffix = Math.random().toString(36).substring(2, 6).toUpperCase();
    const receiptNumber = `REC-${dateStr}-${randSuffix}`;

    const checkoutTx = db.transaction(() => {
      // 1. Verify stock availability for all items first
      const itemDataToProcess: Array<{
        product: any;
        quantity: number;
        unit_price: number;
        total_price: number;
      }> = [];

      for (const itm of items) {
        let product: any;
        if (itm.product_id) {
          product = db.prepare('SELECT * FROM products WHERE id = ?').get(itm.product_id);
        } else if (itm.barcode) {
          product = db.prepare('SELECT * FROM products WHERE barcode = ?').get(itm.barcode);
        }

        if (!product) {
          throw new Error(`Product not found: ${itm.name || itm.barcode || itm.product_id}`);
        }

        const qty = parseInt(itm.quantity, 10);
        if (isNaN(qty) || qty <= 0) {
          throw new Error(`Invalid quantity ${itm.quantity} for "${product.name}"`);
        }

        if (product.stock_quantity < qty) {
          throw new Error(`Insufficient stock for "${product.name}". Available: ${product.stock_quantity}, requested: ${qty}`);
        }

        const unitPrice = parseFloat(itm.unit_price !== undefined ? itm.unit_price : product.price);
        itemDataToProcess.push({
          product,
          quantity: qty,
          unit_price: unitPrice,
          total_price: Math.round(unitPrice * qty * 100) / 100
        });
      }

      // 2. Insert sales record
      const saleInsert = db.prepare(`
        INSERT INTO sales (
          receipt_number, subtotal, tax_rate, tax_amount, discount, 
          total, payment_method, amount_paid, change_due, customer_name, customer_phone
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const saleRes = saleInsert.run(
        receiptNumber,
        subtotal || parsedTotal,
        Number(tax_rate) || 0,
        Number(tax_amount) || 0,
        Number(discount) || 0,
        parsedTotal,
        payment_method,
        parsedAmountPaid,
        changeDue,
        customer_name || 'Walk-in Customer',
        customer_phone || null
      );

      const saleId = Number(saleRes.lastInsertRowid);

      // 3. Process each item: insert sale_item, deduct stock, and log stock_movement
      const insertSaleItem = db.prepare(`
        INSERT INTO sale_items (
          sale_id, product_id, product_name, barcode, quantity, unit_price, total_price
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const updateStock = db.prepare(`
        UPDATE products 
        SET stock_quantity = stock_quantity - ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);

      const insertMovement = db.prepare(`
        INSERT INTO stock_movements (
          product_id, type, quantity_change, quantity_before, quantity_after, 
          reference_id, reason, customer_name, customer_phone, payment_method, sale_id
        ) VALUES (?, 'SALE', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const processedItems = [];

      for (const itm of itemDataToProcess) {
        insertSaleItem.run(
          saleId,
          itm.product.id,
          itm.product.name,
          itm.product.barcode,
          itm.quantity,
          itm.unit_price,
          itm.total_price
        );

        const qtyBefore = itm.product.stock_quantity;
        const qtyAfter = qtyBefore - itm.quantity;

        updateStock.run(itm.quantity, itm.product.id);

        insertMovement.run(
          itm.product.id,
          -itm.quantity,
          qtyBefore,
          qtyAfter,
          receiptNumber,
          `POS Sale #${receiptNumber}`,
          customer_name || 'Walk-in Customer',
          customer_phone || null,
          payment_method,
          saleId
        );

        processedItems.push({
          product_id: itm.product.id,
          name: itm.product.name,
          barcode: itm.product.barcode,
          quantity: itm.quantity,
          unit_price: itm.unit_price,
          total_price: itm.total_price,
          remaining_stock: qtyAfter
        });
      }

      return {
        id: saleId,
        receipt_number: receiptNumber,
        subtotal: subtotal || parsedTotal,
        tax_rate: Number(tax_rate) || 0,
        tax_amount: Number(tax_amount) || 0,
        discount: Number(discount) || 0,
        total: parsedTotal,
        payment_method,
        amount_paid: parsedAmountPaid,
        change_due: changeDue,
        customer_name: customer_name || 'Walk-in Customer',
        customer_phone: customer_phone || null,
        created_at: new Date().toISOString(),
        items: processedItems
      };
    });

    const receipt = checkoutTx();
    res.status(201).json({ success: true, data: receipt });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});
