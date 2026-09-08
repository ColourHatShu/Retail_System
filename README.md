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
- **Backend**: Node.js, Express, SQLite (`better-sqlite3`), ACID transactions.

---

## Quick Start Guide

### 1. Start Both Backend & Frontend
From the root directory (`c:\Code\Retail system`):
```bash
npm run dev
```
- **Web App**: `http://localhost:5173`
- **Mobile Access**: `http://<YOUR-LOCAL-IP>:5173` (e.g. `http://192.168.1.5:5173`)
- **API Server**: `http://localhost:5000`

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
