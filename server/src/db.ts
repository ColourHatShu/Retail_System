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

    for (const d of depts) {
      insertDept.run(d);
    }
  }
}
