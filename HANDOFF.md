# Handoff — Nexus POS (Retail_System)

Last updated: 2026-09-10
Branch: `improve/phase-1-money` — pushed, up to date with `origin/improve/phase-1-money`
Head commit: `27f36c7` "handoff" (parent `fdd3322` "Harden POS into a multi-user Postgres system with returns and voids")
No pull request has been opened.

---

## 1. What this project is

A single-shop retail POS and inventory system. React + Vite client, Express 5 + TypeScript
server, PostgreSQL (hosted on Supabase, used as **storage only** — there is no browser-side
Supabase client any more).

Architecture decisions already made and **not open for re-litigation**:

- **Express owns all business logic.** Supabase is Postgres and nothing else.
- **Scope is one shop with one or two counters.** No multi-location, no stock transfers,
  no SaaS tenancy.

## 2. Where the work stands

The original review found three things that kept this out of enterprise territory: the client
controlled prices, there was no authentication, and there were no tests. All three are closed.

| Step | Status |
|---|---|
| 1. Integer-cent money, server-authoritative pricing | done |
| 2. Move from SQLite to Postgres, remove the public Supabase path | done |
| 3. Users, sessions and roles | done |
| Track A item 1. Returns, refunds and voids | done |
| Track A item 2. Cash drawer and shift close | **next** |
| Track A item 3. Register discounts | **server done, no UI** — see §11 |
| Track A item 4. Reports | **basic AnalyticsPage ships, and is unsound** — see §11 |
| Track B. Engineering hygiene | not started |

Last verified state: `tsc --noEmit` clean on both server and client, client build clean,
**67 of 67 server tests pass** against the live Supabase database.

## 3. Key invariants — do not break these

1. **Money is integer cents everywhere.** Column names end in `_cents`. Tax rates are basis
   points in `_bps` columns. `server/src/lib/money.ts` is the only place that converts, via
   `toCents` / `fromCents` / `applyBps` / `percentToBps`. `toCents` adds a `1e-9` epsilon
   before rounding so `4.35` does not become `434`. Never do money arithmetic in floats and
   never let the client send a total that the server trusts.
2. **The server recomputes every price at checkout.** The client may send `expected_total`;
   if the server's own figure differs it returns **409 `PRICE_CHANGED`** with both numbers and
   writes nothing. The client re-prices the cart and asks the user to confirm again.
3. **Migrations are versioned and forward-only.** `server/src/migrations.ts` holds an array of
   `{ version, name, sql }`; applied versions are recorded in `schema_migrations` and the whole
   run is wrapped in `pg_advisory_lock(7303291)` so two boots cannot race. Add a new migration
   by appending to the array. Never edit a migration that has already been applied to the live
   database. There are 6 today.
4. **Row locks are taken in ascending id order** inside `withTransaction`, with `FOR UPDATE`.
   This is what stops two concurrent checkouts from deadlocking on the same two products.
   Keep the ordering if you add anything that locks multiple rows.
5. **Every error leaves through one envelope**: `{ success: false, code, error, details? }`.
   Postgres codes 23505 / 23503 / 22P02 are mapped to `ALREADY_EXISTS` / `IN_USE` /
   `VALIDATION_ERROR`. The client's `ApiError` reads `code`, never the message text.
6. **Validation happens in middleware, not in handlers.** Zod schemas live in
   `server/src/schemas/index.ts`; the middleware writes the parsed value to `res.locals.input`
   because Express 5 makes `req.query` read-only.
7. **Row Level Security is on for every table with no policies at all.** The owner role the
   server connects as bypasses RLS; anything else — including the old anon key — gets nothing.
   If you add a table, enable RLS on it and add it to the expected list in
   `server/src/tests/migrations.test.ts`.

## 4. Layout

```
server/src/
  app.ts              route wiring; /api/health and /api/auth are public, everything else
                      sits behind requireAuth
  db.ts               pg Pool, type parsers (int8 and numeric come back as numbers),
                      withTransaction, DB_SCHEMA search_path support for tests
  migrations.ts       the 6 migrations and LATEST_SCHEMA_VERSION
  lib/                money.ts, auth.ts (scrypt + tokens), authz.ts (requireRole),
                      errors.ts, validate.ts
  services/           all business logic — sales, returns, products, inventory,
                      departments, movements, settings, users, auth, ledger
  routes/             thin HTTP adapters, one file per resource
  schemas/index.ts    every Zod schema
  tests/              7 vitest files, 67 tests
client/src/
  pages/              POSPage, ReturnsPage, InventoryPage, AnalyticsPage,
                      MovementHistoryPage, QuickScannerPage, LoginPage, UsersPage
  utils/api.ts        the only way the client talks to the server
```

## 5. How the pieces work

**Auth.** Passwords are scrypt hashes stored as `scrypt$N$salt$hash`. Login returns an opaque
bearer token; only its SHA-256 is stored, TTL is 12 hours, with a 60-second in-memory session
cache. Login is throttled at 5 failures per 15 minutes and is timing-equalised through a
`DUMMY_HASH_PROMISE` so a missing user takes as long as a wrong password. Roles are
OWNER / MANAGER / CASHIER, enforced per route by `requireAuth` + `requireRole`. First run
goes through `/api/auth/setup`, which only works while there are zero users.

**Returns.** `services/returns.service.ts` is the densest file in the codebase. A refund is
pro-rated: line gross × (sale total ÷ sale subtotal), so discount and tax come back
proportionally. The line that completes a return is forced to the exact remaining paid amount,
which absorbs rounding drift. `quoteReturn` opens its own client, does an explicit `BEGIN` and
**always** rolls back, so a quote writes nothing and holds no lock. Cashiers are blocked above
the refund threshold (`APPROVAL_REQUIRED`) and outside the return window
(`RETURN_WINDOW_CLOSED`, which an owner can override).

**Voids.** Manager or above, within `VOID_WINDOW_HOURS = 24`, and refused outright if the sale
already has `refunded_cents > 0`.

**Documents.** Receipt and return numbers come from a shared `nextDocumentNumber(tx, 'REC'|'RET')`
backed by an UPSERT on the `sequences` table, so they are gapless per day and safe under
concurrency. Format is `REC-YYYYMMDD-0001`.

## 6. Running it

Run install at the repository **root** — this is an npm workspace and `concurrently` lives
there, not in the sub-packages.

```bash
npm install
```

```bash
npm run dev
```

Tests need a database. They **skip silently** if `DATABASE_URL` is unset, so a green run with
no output means nothing actually ran.

```bash
cd server && npm test
```

Each test file creates a random `test_xxxx` schema, points `search_path` at it through
`DB_SCHEMA`, and drops it in `afterAll`. The migration test carries a 120-second timeout
because every file contends on the same global advisory lock when the suite runs in parallel.

`server/.env` is user-created and gitignored. Do not print it, commit it, or write credentials
into it — the user does that themselves.

## 7. Things that will bite you

- **`npx tsx -e` prints nothing on this machine and then hangs.** Use `node -e` for one-off
  scripts.
- **`npm install` must be run at the repository root**, not just in `server/` and `client/`,
  or `concurrently` is missing and `npm run dev` fails.
- Adding a table means updating the expected RLS list in `migrations.test.ts`.
  Adding a setting means updating the expected object in `products.test.ts`.
- Git warns about CRLF on every new file because of the user's global `core.autocrlf`. It is
  harmless; a `.gitattributes` with `* text=auto eol=lf` would silence it (queued for Track B).

## 8. Outstanding user actions

- **Rotate the Supabase database password.** It was pasted into a chat session and has not been
  changed yet.
- **Create the owner account** through the app's first-run setup screen. The live database had
  zero users at last check. Never create accounts or passwords on the user's behalf.

## 9. Next task in detail — cash drawer and shift close

The agreed next piece of work. Follow the same shape as returns:

- **Migration 7**: `shifts` (opening float, opened and closed timestamps, cashier, counted
  amount, variance) and `cash_movements` (cash in, cash out, reason, actor).
- **`services/shifts.service.ts`**: open a shift, record cash in and out, close with a counted
  amount and compute expected-versus-counted variance from the sales tendered as cash during
  that shift.
- **`/api/shifts` routes**: open, cash movement, close.
- A client Shift page, and a vitest suite alongside the others.

After that: register discounts (line and receipt level, with a reason and role gating), then
reports (daily sales by hour, department, cashier and tender; top movers; dead stock;
shrinkage by reason).

Then Track B: strict TypeScript on the client and removing `any`, replacing the 14
`alert()` and `confirm()` calls with proper toasts and dialogs, splitting the 1,129-line
POSPage, GitHub Actions CI running typecheck and tests, and hosting the Express server so the
Netlify client works again via `VITE_API_BASE`.

## 10. Working agreements

- Commit and push only when the user asks. They asked for the current push; the default is that
  they handle git themselves.
- Never write passwords or secrets into files for the user.
- Git identity in use: ColourHatShu, kampanwalautsav55@gmail.com. Remote is
  `https://github.com/ColourHatShu/Retail_System.git`. `gh` CLI is not installed.

---

## 11. Audit — 2026-09-10

A full-codebase audit was run on 2026-09-10 against head `27f36c7`. 87 findings were raised,
**73 survived an adversarial verification pass** (6 high, 24 medium, 43 low); 14 were refuted
and are not recorded here. Every item below was confirmed by reading the cited source.

**Verified empirically that day:** `tsc --noEmit` clean on server and client; both builds clean
(client bundle 1.25 MB / 370 KB gzip, single chunk); **67/67 server tests pass** in 144 s against
live Postgres; 6 migrations; 12 tables; 14 `alert()`/`confirm()` calls; clean tree in sync with
origin. A 200,000-case fuzz of the refund arithmetic found **zero over-refunds and zero
under-refunds** — the returns money path is sound.

**Verdict:** complete as an engineered foundation, unfinished as a system a shop can run on all
day. The transaction core is essentially done; the shop-operations layer is roughly 40% built.

### 11.1 High — costs money, data, or the shift

| # | Defect | Where |
|---|---|---|
| H1 | Wedge scanner drops the first character when an INPUT has focus, so the buffered code is silently *rejected* by the `/^REC-/i` gate — scanning a receipt on Returns does nothing. The Enter is still `preventDefault()`ed, so the form does not submit either. | `client/src/utils/barcodeListener.ts:48` |
| H2 | Repeat scans of the same item are discarded by a 2.5 s debounce with **no beep, no toast, no visual change** — and the first scan's success toast is still on screen. Three identical bottles ring up as one. | `client/src/pages/POSPage.tsx:177` |
| H3 | Checkout has **no idempotency key**. A response lost after the server commits leaves Confirm re-enabled over an intact cart; pressing it creates a second sale, second receipt number and second stock deduction, undetectable afterwards. | `client/src/pages/POSPage.tsx:392` |
| H4 | `ProductModal` lists `departments` in its form-init effect deps and `App` recreates that array on every `refreshData()`, so an in-progress Add/Edit is blanked mid-entry — including right after the modal's own "Create Department". | `client/src/components/ProductModal.tsx:135` |
| H5 | Service worker applies stale-while-revalidate to **every same-origin GET, including `/api/*`**. `vite.config.ts` sets `host: true`, so a LAN tablet at `http://192.168.x.x:5173` registers the SW and same-origins the API — the intended shop setup. Stale stock/prices, and a cached `/api/auth/me` served to the next cashier on a shared till. | `client/public/sw.js:37` |

### 11.2 Medium — wrong numbers, broken features, missing controls

- **M1 Refund threshold is per-return.** `requires_manager = refund_cents > threshold` never consults `sale.refunded_cents`, which is loaded on the same object. A cashier refused a $180 refund processes four $45 returns against the same receipt and never sees a manager. Bounded by the receipt total and each sub-return is stamped with `processed_by` — a defeated control, not unbounded loss. **One-line fix.** `server/src/services/returns.service.ts:206`
- **M2 Deleting a product destroys its ledger.** `stock_movements.product_id` is `ON DELETE CASCADE` while `sale_items` and `return_items` were deliberately tightened to `RESTRICT`. Products with sales are protected; one only received and written off takes its shrinkage history with it. `server/src/migrations.ts:79`
- **M3 Analytics "Total Revenue"/"Collected Tax" are neither totals nor net** — summed over the last 50 sales, no `status` filter, `refunded_total` never subtracted though both fields are in the payload. `client/src/pages/AnalyticsPage.tsx:43`
- **M4 CSV audit export always 401s** — `window.open` cannot send the bearer header, and it hardcodes `/api` instead of `VITE_API_BASE`. Broken in dev and prod; README advertises it. `client/src/pages/MovementHistoryPage.tsx:76`
- **M5 Receipt reprint renders no line items** — both reprint paths use the list endpoint, which serialises without `items`. `api.getSaleByReceipt` returns them and is unused. `client/src/pages/AnalyticsPage.tsx:53`
- **M6 Excel import can load a catalogue at $0.00** — unrecognised price headers ("MRP", "Rate", "Sell") fall through to `|| 0` and the server accepts it. `client/src/components/ExcelImportModal.tsx:102`
- **M7 Excel import maps SKU into barcode** — `sku`/`code` are in the barcode pattern list and the first match *in sheet order* wins. `client/src/components/ExcelImportModal.tsx:100`
- **M8 Camera stream leaks on fast modal close** — `cleanupScanner` only stops when `isScanning` is already true, which html5-qrcode sets late. `client/src/components/BarcodeScannerModal.tsx:371`
- **M9 `TRUST_PROXY` is undocumented and defaults false.** Behind the reverse proxy this is meant for, `req.ip` is the proxy for everyone, so the (username, IP) lockout key means five wrong passwords lock a real staff member out store-wide. Not in `.env.example`. `server/src/app.ts:20`
- **M10 Login is an unauthenticated CPU amplifier** — one ~16 MB scrypt per request including unknown users, lockout key includes the username so varying it evades the counter, and no rate-limit middleware anywhere.
- **M11 Client TypeScript has strict mode off** — `tsconfig.app.json` has no `"strict"` key and extends nothing; 7,776 lines build with `strictNullChecks` and `noImplicitAny` disabled while the server is strict. 28 `any` remain.
- **M12 Import locks up to 5000 rows in sheet order** for the whole batch, so an arbitrary lock order can deadlock against checkout's ascending-id order. `server/src/services/inventory.service.ts:208`
- **Returns and import violate invariant 4** — both lock product rows in client/sheet order, not ascending id. Sort before locking.
- **`schema_migrations` is the one table without RLS** — it is created outside the migration list and no migration ever enables it.

### 11.3 Low — selected

- **L1 Client and server tax formulas differ.** Client: `round(subtotalCents * percent / 100)`; server: `round(cents * bps / 10000)`. Scanned $0.01–$2,000 across twelve rates: 5.00/6.00/7.00/7.25/8.25/10.00/12.00/18.00/4.50/3.75% are clean; **4.85% produces 45 mismatches (first at exactly $30.00)** and 6.35% produces 2. On a mismatch the cart is permanently un-checkoutable — every attempt 409s with no way forward. `client/src/pages/POSPage.tsx:84`
- **L2 Receipt discount has no authorization** — any authenticated role can pass a discount up to the full subtotal, no reason field, no `discount_approved_by`. Not reachable from the UI today, so it is a control to build *before* the discount UI ships, not a live hole. `server/src/services/sales.service.ts:139`
- **L3** A completing multi-line return can persist a negative per-line `refund_cents` (header stays exactly correct; no screen renders the line figure). `returns.service.ts:167`
- **L4** The approval message formats the *attempted refund* into "Refunds above X must be processed by a manager" — a self-contradictory sentence. `returns.service.ts:224`
- **L5** Session cache is cleared *inside* the transaction, so a request in the window before COMMIT re-caches the pre-commit user for up to 60 s. `auth.service.ts:187`
- **L6** `api.changePassword` has zero callers — complete server endpoint, no screen.
- **L7** An owner resetting their own password signs themselves out; `users.service.ts:67` omits the `exceptTokenHash` argument that exists for this case.
- **L8** SQLSTATE 40P01 / 40001 / 22007 / 23514 are unmapped, so a deadlock victim surfaces as an opaque 500.
- **L9** The app's own import template writes a `Min Stock Alert` column its own parser does not match — re-importing it resets every threshold to 5.
- **L15** `xlsx@0.18.5` is a dead **server** dependency (no import under `server/src`); the parsing risk is real on the client, where it is used.
- Also: `VOID_WINDOW_HOURS` is a module constant while `return_window_days` is a setting; a deleted product stays in the cart forever with an unactionable 404; `alert()`/`confirm()` called inside `setCart` updaters; currency setting ignored throughout the client.

### 11.4 Blocking gaps for a real shop

1. **Cash drawer / shift open-close / reconciliation** — nothing exists. Cash refunds already remove money from a drawer the system does not model. (Already §9's next task.)
2. **Discount at the register** — server done, `POSPage.tsx:359` hardcodes `discount: 0`, no control anywhere, no line-level, no price override.
3. **"What sold today"** — `salesListQuery` accepts only `limit`/`offset`. No date range anywhere, no `/api/reports`, no per-product/department/cashier/hour report, tender breakdown computed and discarded, no margin despite `cost_price_cents`.
4. **Settings screen** — `PUT /api/settings` is complete and owner-only; `api.updateSettings` has zero callers and there is no `settings` tab. The shop trades at whatever migration 3 seeded.
5. **Receipt identity** — `ReceiptModal` hardcodes "Minimal Retail System" / "100 Market St • Store #01", ignores `store_name`, hardcodes `$`, no tax registration number.
6. **A hosted server** — `netlify.toml` publishes the client only with no `/api` rule; root `build` runs `build:client` alone. No Dockerfile, Procfile, host config or CI.
7. **Jurisdictional:** one flat tax added *on top* of price (no exempt goods, no tax-inclusive pricing — blocking in any VAT/GST market); integer-only quantities (blocking for anything sold by weight).

Important but non-blocking: no owner password recovery (forgotten owner password = database surgery); no price-change audit; cart is volatile `useState`; no offline capability; no supplier/PO/goods-received; no split tender; no off-catalogue line; no pagination controls in the client at all; **zero client tests** across 7,776 lines; no CI, error monitoring, structured logging or error boundary; 12-hour session inside a 14-hour trading day; a hidden "seed sample beverages" button that inserts branded products into the live catalogue.

### 11.5 Documentation

`README.md` describes a product two milestones old and states two falsehoods: it says stock is
decreased in "the **SQLite** database" (Postgres-only), and calls the ledger **"tamper-evident"**
(no hash chain, no signature, no append-only trigger, no `REVOKE UPDATE/DELETE` — and per M2, a
deletable table). Its "Sample Barcodes for Immediate Testing" table is **fiction** — there are zero
`INSERT INTO products` statements in `migrations.ts`, so a fresh install has an empty catalogue.
Quick Start never mentions that the first screen is a first-run owner-setup wall. README omits
auth and the role model, returns/voids, Analytics, spreadsheet import, cycle count, department and
user management entirely, and presents "UPI QR" as a payment feature when nothing renders a QR
code. `client/README.md` is the untouched Vite starter template. `.gitignore:9-13` still carries
the dead SQLite block.

Undocumented in both files: the browser sends every unknown barcode to three external registries
(Open Food Facts, Open Beauty Facts, and UPCitemdb's unauthenticated **trial** endpoint) with no
timeout — an undeclared runtime dependency and a data-egress path where scanned barcodes leave the
store network. Also undocumented: spreadsheet import, physical cycle count, the role gating, and
`app.use(cors())` with no origin allowlist.

### 11.6 Recommended order

1. **H1, H2, H4, H5** — four small independent client edits; two of them cost money today. **~1 day**
2. **M1 + L4** — cumulative refund threshold, and print the threshold not the refund. **~2 hours**
3. **H3 checkout idempotency** — client txn id, unique column, service dedupe returning the original sale. The one defect that can silently double-charge. **~1 day**
4. **Migration 7 — protect the ledger and back the invariants:** `stock_movements.product_id` → RESTRICT (M2); `CHECK (refund_cents >= 0)`; `CHECK (stock_quantity >= 0)`; CHECKs on `sales.status` and `stock_movements.type`; index `sales.cashier_id`, `stock_movements.user_id/sale_id`, `return_items.return_id`; RLS on `schema_migrations`. **~1 day, one file**
5. **Cash drawer and shift close** — the largest blocking gap, already §9's plan. **~1.5–2 weeks**
6. **Server-side reporting with date ranges**, then rewire AnalyticsPage onto it (fixes M3, M5). **~1 week**
7. **Discount at the register — build the authorization first** (role gate, threshold, `discount_reason`, `discount_approved_by`) so L2 never ships live. **~4–5 days**
8. **Settings screen + receipt identity + shared `formatMoney`.** **~3 days**
9. **Deploy the server** — host config, `[[redirects]]` for `/api/*` ahead of the SPA catch-all, root `build` running both halves, `TRUST_PROXY` documented (M9). **~2–3 days**
10. **Harden the edge** — rate-limit `/api/auth/*` (M10), helmet, CORS allowlist, the four missing SQLSTATE branches (L8), pool `lock_timeout`. **~1 day**
11. **Track B hygiene** — client `strict` on (M11), CI running typecheck/tests/builds with `setup.ts` failing loudly when `DATABASE_URL` is unset, toast/dialog layer replacing the 14 `alert`/`confirm`, error boundary. **~1 week**
12. **Fix the import path** — M6, M7, L9, plus chunking and sorting locks by id (M12). **~2 days**
13. **First client tests** — cart maths, PRICE_CHANGED retry, returns quote gate, and the barcode listener (which would have caught H1 in ten lines). **~3 days**
14. **Rewrite README against the shipped product.** The SQLite line, the "tamper-evident" claim and the fictional barcode table cost nothing to delete and actively mislead — do those today. **~half a day**

Rough total to close the blocking gaps and confirmed defects: **4–7 weeks of focused
single-developer work.**

### 11.7 Limits of this audit

The client was never run — no browser session, no rendered screen. H1, H2, H4, H5, M4, M5, M8 and
every UX claim are code-reading conclusions, not observations; the camera leak and the
service-worker staleness were not reproduced against a live browser. No HTTP calls by hand, no
load or concurrency testing beyond the suite's own two-writer test, no security testing (the
scrypt amplification and throttle bypass were reasoned from source, not attempted), and no
migration run against a real legacy Supabase database — the suite only exercises fresh throwaway
schemas. The `schema_migrations` RLS gap depends on Supabase platform default grants that are not
code in this repo and could not be confirmed. The live database's current data was not assessed.
