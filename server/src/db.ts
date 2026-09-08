import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.resolve(__dirname, '..', 'retail_pos.db');
export const db = new Database(dbPath);

// Enable WAL mode and foreign keys
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      code TEXT NOT NULL UNIQUE,
      description TEXT,
      color TEXT DEFAULT '#4f46e5',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barcode TEXT NOT NULL UNIQUE,
      sku TEXT,
      name TEXT NOT NULL,
      department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
      price REAL NOT NULL,
      cost_price REAL DEFAULT 0,
      stock_quantity INTEGER NOT NULL DEFAULT 0,
      min_stock_level INTEGER NOT NULL DEFAULT 5,
      unit TEXT DEFAULT 'pcs',
      image_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      type TEXT NOT NULL, -- 'INITIAL', 'RESTOCK', 'SALE', 'ADJUSTMENT_ADD', 'ADJUSTMENT_REMOVE', 'RETURN'
      quantity_change INTEGER NOT NULL,
      quantity_before INTEGER NOT NULL,
      quantity_after INTEGER NOT NULL,
      reference_id TEXT,
      reason TEXT,
      customer_name TEXT,
      customer_phone TEXT,
      payment_method TEXT,
      sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_number TEXT NOT NULL UNIQUE,
      subtotal REAL NOT NULL,
      tax_rate REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      discount REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL,
      payment_method TEXT NOT NULL, -- 'CASH', 'CARD', 'UPI_QR', 'SPLIT'
      amount_paid REAL NOT NULL,
      change_due REAL NOT NULL DEFAULT 0,
      customer_name TEXT,
      customer_phone TEXT,
      status TEXT NOT NULL DEFAULT 'COMPLETED',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sale_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      product_name TEXT NOT NULL,
      barcode TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      total_price REAL NOT NULL
    );

    -- Indices for fast lookups
    CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
    CREATE INDEX IF NOT EXISTS idx_products_department ON products(department_id);
    CREATE INDEX IF NOT EXISTS idx_movements_product ON stock_movements(product_id);
    CREATE INDEX IF NOT EXISTS idx_movements_created ON stock_movements(created_at);
    CREATE INDEX IF NOT EXISTS idx_sales_receipt ON sales(receipt_number);
    CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
  `);

  // Migrations for existing databases
  try { db.exec(`ALTER TABLE stock_movements ADD COLUMN customer_name TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE stock_movements ADD COLUMN customer_phone TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE stock_movements ADD COLUMN payment_method TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE stock_movements ADD COLUMN sale_id INTEGER;`); } catch {}

  // Seed sample data if empty
  seedInitialData();
}

function seedInitialData() {
  const deptCount = db.prepare('SELECT COUNT(*) as count FROM departments').get() as { count: number };
  if (deptCount.count === 0) {
    const insertDept = db.prepare(`
      INSERT INTO departments (name, code, description, color)
      VALUES (@name, @code, @description, @color)
    `);

    const depts = [
      { name: 'Beverages', code: 'BEV', description: 'Soft drinks, juices, water, energy drinks', color: '#0ea5e9' },
      { name: 'Grocery & Pantry', code: 'GROC', description: 'Flour, rice, spices, canned foods', color: '#10b981' },
      { name: 'Dairy & Frozen', code: 'DAIRY', description: 'Milk, cheese, butter, ice cream', color: '#6366f1' },
      { name: 'Bakery & Snacks', code: 'BAKE', description: 'Breads, cookies, chips, crackers', color: '#f59e0b' },
      { name: 'Personal Care', code: 'CARE', description: 'Soap, shampoo, hygiene, cosmetics', color: '#ec4899' },
      { name: 'Electronics & Tech', code: 'ELEC', description: 'Cables, chargers, earphones, accessories', color: '#8b5cf6' },
    ];

    const deptMap: Record<string, number> = {};
    for (const d of depts) {
      const res = insertDept.run(d);
      deptMap[d.code] = Number(res.lastInsertRowid);
    }

    const insertProduct = db.prepare(`
      INSERT INTO products (barcode, sku, name, department_id, price, cost_price, stock_quantity, min_stock_level, unit)
      VALUES (@barcode, @sku, @name, @department_id, @price, @cost_price, @stock_quantity, @min_stock_level, @unit)
    `);

    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (product_id, type, quantity_change, quantity_before, quantity_after, reference_id, reason)
      VALUES (@product_id, 'INITIAL', @quantity_change, 0, @quantity_after, 'INIT-SEED', 'Initial system stock')
    `);

    const sampleProducts = [
      { barcode: '8901234567890', sku: 'BEV-001', name: 'Sparkling Mineral Water 500ml', department_id: deptMap['BEV'], price: 1.99, cost_price: 0.85, stock_quantity: 45, min_stock_level: 10, unit: 'bottle' },
      { barcode: '8901234567891', sku: 'BEV-002', name: 'Cold Pressed Orange Juice 1L', department_id: deptMap['BEV'], price: 4.50, cost_price: 2.20, stock_quantity: 24, min_stock_level: 8, unit: 'bottle' },
      { barcode: '8901234567892', sku: 'GROC-001', name: 'Organic Rolled Oats 1kg', department_id: deptMap['GROC'], price: 5.25, cost_price: 3.10, stock_quantity: 18, min_stock_level: 6, unit: 'pack' },
      { barcode: '8901234567893', sku: 'GROC-002', name: 'Extra Virgin Olive Oil 750ml', department_id: deptMap['GROC'], price: 12.99, cost_price: 7.50, stock_quantity: 12, min_stock_level: 4, unit: 'bottle' },
      { barcode: '8901234567894', sku: 'DAIRY-001', name: 'Greek Plain Yogurt 500g', department_id: deptMap['DAIRY'], price: 3.49, cost_price: 1.80, stock_quantity: 15, min_stock_level: 5, unit: 'tub' },
      { barcode: '8901234567895', sku: 'DAIRY-002', name: 'Artisan Cheddar Block 250g', department_id: deptMap['DAIRY'], price: 4.99, cost_price: 2.75, stock_quantity: 8, min_stock_level: 5, unit: 'pcs' },
      { barcode: '8901234567896', sku: 'BAKE-001', name: 'Sourdough Country Loaf', department_id: deptMap['BAKE'], price: 4.25, cost_price: 1.50, stock_quantity: 10, min_stock_level: 4, unit: 'loaf' },
      { barcode: '8901234567897', sku: 'BAKE-002', name: 'Dark Chocolate Sea Salt Cookies', department_id: deptMap['BAKE'], price: 3.75, cost_price: 1.90, stock_quantity: 30, min_stock_level: 10, unit: 'pack' },
      { barcode: '8901234567898', sku: 'CARE-001', name: 'Herbal Moisturizing Hand Soap 300ml', department_id: deptMap['CARE'], price: 6.50, cost_price: 3.00, stock_quantity: 20, min_stock_level: 5, unit: 'bottle' },
      { barcode: '8901234567899', sku: 'ELEC-001', name: 'Braided USB-C Fast Charging Cable 2m', department_id: deptMap['ELEC'], price: 9.99, cost_price: 3.20, stock_quantity: 35, min_stock_level: 8, unit: 'pcs' },
      { barcode: '8901234567800', sku: 'ELEC-002', name: 'Magnetic Wireless Power Bank 5000mAh', department_id: deptMap['ELEC'], price: 29.99, cost_price: 14.50, stock_quantity: 6, min_stock_level: 3, unit: 'pcs' },
    ];

    for (const p of sampleProducts) {
      const res = insertProduct.run(p);
      insertMovement.run({
        product_id: Number(res.lastInsertRowid),
        quantity_change: p.stock_quantity,
        quantity_after: p.stock_quantity,
      });
    }
  }
}
