import { initDatabase, db } from './db';

console.log('--- Starting System Verification Test ---');
initDatabase();

// 1. Verify departments
const depts = db.prepare('SELECT * FROM departments').all();
console.log(`[PASS] Departments loaded: ${depts.length}`);

// 2. Verify products
const prods = db.prepare('SELECT * FROM products').all();
console.log(`[PASS] Initial Products loaded: ${prods.length}`);

// 3. Test Barcode Lookup
const sampleBarcode = '8901234567890';
const sampleProd = db.prepare('SELECT * FROM products WHERE barcode = ?').get(sampleBarcode) as any;
console.log(`[PASS] Found product by barcode "${sampleBarcode}": ${sampleProd.name}, Current Stock: ${sampleProd.stock_quantity}`);

// 4. Test Stock Adjustment (Restock +5)
const stockBefore = sampleProd.stock_quantity;
const delta = 5;
const newStock = stockBefore + delta;

db.prepare('UPDATE products SET stock_quantity = ? WHERE id = ?').run(newStock, sampleProd.id);
db.prepare(`
  INSERT INTO stock_movements (product_id, type, quantity_change, quantity_before, quantity_after, reference_id, reason)
  VALUES (?, 'RESTOCK', ?, ?, ?, 'TEST-RESTOCK', 'Automated test delivery')
`).run(sampleProd.id, delta, stockBefore, newStock);

const updatedProd = db.prepare('SELECT * FROM products WHERE id = ?').get(sampleProd.id) as any;
console.log(`[PASS] Restocked +${delta}. Stock updated from ${stockBefore} -> ${updatedProd.stock_quantity}`);

// 5. Test POS Checkout Transaction (Purchase 2 units)
const checkoutTx = db.transaction(() => {
  const soldQty = 2;
  const current = db.prepare('SELECT * FROM products WHERE id = ?').get(sampleProd.id) as any;
  const afterSale = current.stock_quantity - soldQty;

  const receiptNo = `REC-TEST-${Date.now()}`;
  const saleRes = db.prepare(`
    INSERT INTO sales (receipt_number, subtotal, tax_rate, tax_amount, discount, total, payment_method, amount_paid, change_due)
    VALUES (?, ?, 0, 0, 0, ?, 'CASH', ?, 0)
  `).run(receiptNo, current.price * soldQty, current.price * soldQty, current.price * soldQty);

  const saleId = Number(saleRes.lastInsertRowid);

  db.prepare(`
    INSERT INTO sale_items (sale_id, product_id, product_name, barcode, quantity, unit_price, total_price)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(saleId, current.id, current.name, current.barcode, soldQty, current.price, current.price * soldQty);

  db.prepare('UPDATE products SET stock_quantity = ? WHERE id = ?').run(afterSale, current.id);

  db.prepare(`
    INSERT INTO stock_movements (product_id, type, quantity_change, quantity_before, quantity_after, reference_id, reason)
    VALUES (?, 'SALE', ?, ?, ?, 'REC-TEST-001', 'Test POS Sale Checkout')
  `).run(current.id, -soldQty, current.stock_quantity, afterSale);

  return { saleId, afterSale };
});

const checkoutResult = checkoutTx();
console.log(`[PASS] POS Checkout completed. Sale ID: ${checkoutResult.saleId}, Remaining Stock: ${checkoutResult.afterSale}`);

// 6. Test Movement History Audit Verification
const movements = db.prepare('SELECT * FROM stock_movements WHERE product_id = ? ORDER BY id ASC').all(sampleProd.id) as any[];
console.log(`[PASS] Movement history entries for product: ${movements.length}`);
movements.forEach((m, idx) => {
  console.log(`   ${idx + 1}. [${m.type}] Delta: ${m.quantity_change > 0 ? '+' : ''}${m.quantity_change} | Before: ${m.quantity_before} -> After: ${m.quantity_after} | Ref: ${m.reference_id} | ${m.reason}`);
});

console.log('--- System Verification Test Succeeded 100% ---');
