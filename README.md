# Nexus POS & Inventory Management System

A minimalistic, professional, and responsive Point of Sale (POS) and Inventory Management web application designed for both **mobile devices** (smartphones/tablets with camera barcode scanning) and **desktop/web terminals** (with hardware USB/Bluetooth barcode scanner integration).

---

## Key Features

- **POS Register & Checkout Terminal**:
  - Scan product barcodes using your device camera or plug-and-play hardware barcode scanners.
  - Department catalog filtering (Beverages, Grocery, Dairy, Bakery, Electronics, etc.) and instant live search.
  - Active cart management with quantity steppers and real-time total calculations.
  - Multi-payment support: **Cash** (with quick bill presets and change due calculation), **Card**, and **Digital / UPI QR**.
  - **Automated Inventory Reduction**: Checkout atomically decreases product stock in the SQLite database and logs a tamper-evident `SALE` movement.
  - **Thermal Receipt Generation**: Itemized receipt with printable Code 128 barcode, timestamp, and financial breakdown.

- **Department-Wise Inventory Management**:
  - Add and organize products categorized by department.
  - Full product specifications: Barcode, SKU, Department, Retail Price, Cost Price, Stock Count, Low Stock Threshold, and Unit.
  - Stock health alerts: **In Stock** (emerald), **Low Stock** (amber), and **Out of Stock** (rose).
  - Quick inline stock adjustments (+1 / -1) directly from the inventory table.
  - Barcode Shelf Label generator: Print shelf tags with scannable barcodes.

- **Dedicated Barcode Stock Adjuster (Rapid Stock In / Out)**:
  - **Stock In (+) [Restock]**: Rapidly scan shipments to increase stock.
  - **Stock Out (-) [Deduct]**: Scan items to deduct stock with reasons (Damaged, Expired, Defective Return, Floor Sample, Shrinkage).
  - Real-time visual feedback card displaying previous balance, delta, and new balance.
  - Native Web Audio sound effects: Success beep and error alert.

- **Movement History Audit Ledger**:
  - Complete, chronologically ordered audit log of every stock movement (`SALE`, `RESTOCK`, `ADJUSTMENT_ADD`, `ADJUSTMENT_REMOVE`, `INITIAL`, `RETURN`).
  - Records timestamp, product name, barcode, department, quantity change, balance before, balance after, and reference receipt ID.
  - Filterable by department, movement type, and keywords.
  - One-click **Export to CSV** for store accounting and inventory audit compliance.

- **Minimalistic & Professional UI**:
  - Scandinavian/modern aesthetic with high contrast typography, subtle borders, and zero clutter.
  - Responsive dual layout: Handheld mobile scanner navigation + dual-pane widescreen desktop POS terminal.

---

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS, Lucide Icons, `html5-qrcode`, `jsbarcode`, `canvas-confetti`.
- **Backend**: Node.js, Express 5, PostgreSQL (`pg`), Zod validation. The Express server is the only thing that talks to the database; the browser never holds database credentials.

### Design rules worth knowing

- **Money is integer cents in the database and in every calculation.** Decimal numbers (`19.99`) exist only in the JSON API. Tax rates are stored in basis points.
- **The server is the authority on prices.** Checkout ignores any price or total sent by the client, recomputes everything from the catalogue, and refuses with `PRICE_CHANGED` if the register's displayed total is stale.
- **Stock only changes through the ledger.** Every change to a product's quantity writes a `stock_movements` row with the balance before and after.
- **Schema changes are migrations** in `server/src/migrations.ts`, applied automatically at server start and tracked in `schema_migrations`.
- **Errors are one envelope**: `{ success: false, code, error, details? }`.

---

## Quick Start Guide

### 1. Configure the database
Copy `server/.env.example` to `server/.env` and set `DATABASE_URL` to your Postgres connection string (Supabase: Project Settings → Database → Connection string, URI). Migrations run automatically on first start, including upgrading a database created by the earlier Supabase-only version.

### 2. Start Both Backend & Frontend
From the repository root:
```bash
npm install
npm run dev
```
- **Web App**: `http://localhost:5173`
- **Mobile Access**: `http://<YOUR-LOCAL-IP>:5173` (e.g. `http://192.168.1.5:5173`)
- **API Server**: `http://localhost:5000`

### 3. Run the tests
```bash
cd server && npm test
```
Tests run against the database in `server/.env` (or `TEST_DATABASE_URL`), each file inside its own throwaway schema that is dropped afterwards. Without a database configured, the database-backed suites are skipped with a warning.

### Deploying
The client is static (Netlify config included); set `VITE_API_BASE` to the public URL of the Express server. The server needs a Node host (Render, Railway, Fly, a VPS) with `DATABASE_URL` set.

---

## Sample Barcodes for Immediate Testing

Use these pre-loaded barcodes to test camera scanning or manual entry:

| Barcode | Product Name | Department | Price | Initial Stock |
| :--- | :--- | :--- | :--- | :--- |
| `8901234567890` | Sparkling Mineral Water 500ml | Beverages | $1.99 | 45 |
| `8901234567891` | Cold Pressed Orange Juice 1L | Beverages | $4.50 | 24 |
| `8901234567892` | Organic Rolled Oats 1kg | Grocery & Pantry | $5.25 | 18 |
| `8901234567893` | Extra Virgin Olive Oil 750ml | Grocery & Pantry | $12.99 | 12 |
| `8901234567894` | Greek Plain Yogurt 500g | Dairy & Frozen | $3.49 | 15 |
| `8901234567896` | Sourdough Country Loaf | Bakery & Snacks | $4.25 | 10 |
| `8901234567898` | Herbal Moisturizing Hand Soap | Personal Care | $6.50 | 20 |
| `8901234567899` | Braided USB-C Fast Charging Cable | Electronics & Tech | $9.99 | 35 |
