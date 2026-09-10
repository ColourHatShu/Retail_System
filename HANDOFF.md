# Handoff — Nexus POS (Retail_System)

Last updated: 2026-09-10 (end of day)
Branch: `improve/phase-1-money` — pushed, up to date with `origin/improve/phase-1-money`
Head commit: `ad77491` "Stop the service worker serving a stale page shell"
No pull request has been opened.

**The application is live** at **https://corpos---retail-pos.web.app**

---

## 1. What this project is

A single-shop retail POS and inventory system for a shop **in Canada** (see §9 — the province
is still unconfirmed and it matters). React + Vite client, Express 5 + TypeScript server,
PostgreSQL hosted on Supabase and used as **storage only** — there is no browser-side Supabase
client.

Roughly 13,200 lines across both halves. 8 migrations, 80 server tests.

Architecture decisions already made and **not open for re-litigation**:

- **Express owns all business logic.** Supabase is Postgres and nothing else.
- **Scope is one shop with one or two counters.** No multi-location, no stock transfers, no
  SaaS tenancy.

## 2. Where it runs

Three services. This is the single most useful thing to hold in mind.

| Piece | Where | Detail |
|---|---|---|
| Client | Firebase Hosting | project `corpos---retail-pos` |
| Server | Google **Cloud Run** | service `nexus-pos-api`, region `northamerica-northeast1` (Montreal) |
| Database | Supabase PostgreSQL 17.6 | AWS `ca-central-1` (Montreal), via the **session pooler** |

Firebase Hosting cannot run Express — it serves files only. `firebase.json` rewrites `/api/**`
to Cloud Run **before** the SPA catch-all; reverse that order and every API call returns
`index.html` with a valid 200 and the register silently sits empty.

Cloud Run is in Montreal deliberately, to sit beside the database. `VITE_API_BASE` is
deliberately unset — the rewrite makes the API same-origin, so the client's `/api` default is
already correct.

**The full deployment runbook is in `DEPLOY.md`.** Read it before deploying anything.

## 3. Where the work stands

| Step | Status |
|---|---|
| 1. Integer-cent money, server-authoritative pricing | done |
| 2. Postgres, no public Supabase path | done |
| 3. Users, sessions and roles | done |
| Track A 1. Returns, refunds and voids | done |
| Track A 2. Cash drawer and shift close | **not started — largest remaining gap** |
| Track A 3. Register discounts | server done, no UI |
| Track A 4. Reports | basic AnalyticsPage ships, and is unsound — see §10 |
| Deployment (Firebase + Cloud Run) | done, live |
| Barcode enrichment with caching | done, live |
| Auto-created departments | done, live |
| Product archiving | done, live |
| Track B. Engineering hygiene | not started |

Last verified: `tsc --noEmit` clean on both halves, client build clean, **80/80 server tests
pass** against live Postgres.

## 4. Key invariants — do not break these

1. **Money is integer cents everywhere.** Columns end in `_cents`, tax rates are basis points
   in `_bps`. `server/src/lib/money.ts` is the only place that converts. `toCents` adds a
   `1e-9` epsilon before rounding so `4.35` does not become `434`. Never do money arithmetic in
   floats, and never let the client send a total the server trusts.
2. **The server recomputes every price at checkout.** If its figure differs from the client's
   `expected_total` it returns **409 `PRICE_CHANGED`** and writes nothing.
3. **Migrations are versioned and forward-only.** `server/src/migrations.ts` holds
   `{ version, name, sql }`; applied versions live in `schema_migrations`, and the run is
   wrapped in `pg_advisory_lock(7303291)`. Never edit an applied migration. There are 8.
4. **Row locks are taken in ascending id order** inside `withTransaction`, with `FOR UPDATE`.
5. **Every error leaves through one envelope**: `{ success: false, code, error, details? }`.
   The client's `ApiError` reads `code`, never the message text.
6. **Validation happens in middleware, not handlers.** Zod schemas in
   `server/src/schemas/index.ts`; the parsed value goes to `res.locals.input` because Express 5
   makes `req.query` read-only.
7. **RLS is on for every table with no policies.** The owner role the server connects as
   bypasses it. Adding a table means enabling RLS **and** adding it to the expected list in
   `server/src/tests/migrations.test.ts`.
8. **Sold products are never deleted, only archived.** `sale_items.product_id` is
   `ON DELETE RESTRICT`, which is what keeps receipt lines pointing at something real. See §6.
9. **The service worker must never cache the page shell or the API.** See §8 — this one took
   the whole site down once already.

## 5. Layout

```
server/src/
  app.ts              route wiring; /api/health and /api/auth are public
  db.ts               pg Pool, type parsers, withTransaction, DB_SCHEMA for tests
  migrations.ts       the 8 migrations and LATEST_SCHEMA_VERSION
  lib/                money.ts, auth.ts, authz.ts, errors.ts, validate.ts
  services/           auth, departments, inventory, ledger, lookup, movements,
                      products, returns, sales, settings, users
  routes/             thin HTTP adapters, one file per resource
  schemas/index.ts    every Zod schema
  tests/              8 vitest files, 80 tests
  Dockerfile          two-stage Node 22 build for Cloud Run
client/src/
  pages/              POSPage, ReturnsPage, InventoryPage, AnalyticsPage,
                      MovementHistoryPage, QuickScannerPage, LoginPage, UsersPage
  utils/api.ts        the only way the client talks to the server
  public/sw.js        service worker — read §8 before touching it
```

## 6. How the newer pieces work

**Barcode enrichment** (`services/lookup.service.ts`, `GET /api/products/lookup/:barcode`).
A barcode is only a number, so every piece of product information comes from a lookup. This
runs server-side because UPCitemdb — the registry with the broadest non-food coverage —
answers browsers with `Access-Control-Allow-Origin` restricted to its own site, so the old
client-side version could never work and failed silently.

- Registries tried in order: **Open Food Facts**, then **Open Beauty Facts**. UPCitemdb is
  **disabled** behind `UPCITEMDB_ENABLED=true` — its free tier is rate-limited per IP and Cloud
  Run's egress IP is shared, so it returned HTTP 429 to every request in production.
  Re-enabling also needs a paid key sent as a `user_key` header, which is not written yet.
- Answers are cached in `barcode_lookups`, so a barcode costs one external call ever. Misses
  expire after 30 days.
- **A transient failure is never cached.** A 429, a 5xx or a timeout means retry next scan;
  only an authoritative 404 is recorded. Without this a rate limit would freeze a product out
  for a month.
- Each registry logs why it produced nothing. Never make this silent again.
- **Price is never autofilled** — the registries quote US dollars.
- Coverage for Canada is good for food and grocery: Open Food Facts has roughly 126,000
  products tagged Canada, against about 23,000 for India. Non-food retail is the gap, and it is
  a quota problem rather than a data problem.

**Auto-created departments.** When a lookup identifies a product, `resolveDepartment` maps the
registry's category text to one of **six fixed standard departments** (Beverages, Grocery &
Pantry, Dairy & Frozen, Bakery & Snacks, Personal Care, Electronics & Tech), creates it if the
shop does not have it, and reuses it if it does. An unrecognised category leaves the field
empty so a person chooses.

The fixed list is deliberate. Registries phrase the same aisle differently every time —
`"Beverages, Sodas, Colas"` for one cola, `"Drinks, Soft drinks, Sugary drinks"` for the next —
so creating departments from that text would sprawl into dozens of near-duplicate chips on the
register, and a department cannot be deleted once it holds a sold product.
**There is no cap on departments created manually.**

**Product archiving** (migration 8, `products.is_active`). A sold product cannot be deleted, so
archiving is how it is retired: it leaves the catalogue and the register, stays reachable with
`include_archived=true`, and keeps every receipt. Attempting to delete one returns
**409 `HAS_HISTORY`** (distinct from the generic `IN_USE`) with a message naming the reason,
and Inventory offers "Archive it instead?".

## 7. Running it

Install at the repository **root** — this is an npm workspace and `concurrently` lives there.

```bash
npm install
npm run dev
```

Tests need a database and **skip silently** if `DATABASE_URL` is unset, so a green run with no
output means nothing ran.

```bash
cd server && npm test
```

`server/.env` is user-created and gitignored. Do not print it, commit it, or write credentials
into it.

## 8. Things that will bite you

- **The service worker took the whole site down on 2026-09-10.** It was applying
  stale-while-revalidate to navigation requests, so after a deploy it served an `index.html`
  cached from the previous deploy — and `index.html` names a content-hashed bundle. The result
  was a blank white screen, an empty `#root`, no console error, and every asset returning 200.
  It is now network-first for the page shell and only falls back to cache when offline.
  **Never make the page shell or `/api/` cacheable.** After any deploy, an already-open tab
  needs one reload before the new worker takes over.
- **Firebase header sources are literal.** `"source": "/index.html"` does **not** match a
  request for `/`. Both are declared now.
- **`server/package-lock.json` is not the workspace lockfile and it drifts.** The root
  `package.json` declares workspaces, so npm hoists to the root lockfile and ignores nested
  ones. The server lockfile had gone stale and broke the container build. To regenerate: copy
  `server/package.json` alone into an empty scratch directory, run
  `npm install --package-lock-only`, and copy the result back. Running `npm install` *inside*
  `server/` does not work — npm detects the workspace root and hoists.
- **Use the Supabase session pooler, not the direct connection.** The direct host is IPv6-only
  and Cloud Run's egress is IPv4, so it times out in a way that looks like a firewall problem.
  Session mode (port 5432), never transaction mode (6543) — `pg_advisory_lock` in
  `migrations.ts` is session-scoped and spans transaction boundaries.
- **gcloud's `^DELIM^` escaping does not survive Windows.** `gcloud.cmd` is a batch file and
  cmd.exe treats `^` as its escape character, so the prefix is eaten and you silently get one
  malformed environment variable. Use plain commas.
- **Cloud Build does not read git.** `--source server` uploads the local directory, so a deploy
  can succeed from uncommitted files.
- **`npx tsx -e` prints nothing on this machine and hangs.** Use `node -e`.
- Adding a table means updating the expected RLS list in `migrations.test.ts`. Adding a setting
  means updating the expected object in `products.test.ts`.
- Git warns about CRLF on every file because of the user's global `core.autocrlf`. Harmless; a
  `.gitattributes` with `* text=auto eol=lf` would silence it.

## 9. Outstanding — needs the owner, not a developer

1. **Which province is the shop in?** This gates all tax work. Canada is not one tax regime:
   Alberta is GST only at 5%, Ontario is 13% HST, BC is 5% GST plus 7% PST, Quebec is GST plus
   9.975% QST and law requires them shown as separate lines. Basic groceries are zero-rated
   federally, so a shop selling food and non-food needs per-product tax categories, which the
   schema does not have. The app currently applies **one flat 5% on top of price** — correct in
   Alberta and nowhere else.
2. **Rotate the Supabase database password**, then update the service with
   `gcloud run services update nexus-pos-api --region northamerica-northeast1 --set-env-vars ...`
   (about 40 seconds, no rebuild). Better still, move it into Secret Manager.
3. **Add `--min-instances 1`** before a shop trades on this. Right now the service scales to
   zero, so the first sale after a quiet period pays a cold start plus a migration check.
   Roughly USD 10–20 a month.

## 10. Known defects and gaps

**Fixed on 2026-09-10:** H4 (form wiped by background refresh), H5 (service worker caching the
API), the barcode lookup failing silently, one scan adding ten units of stock, unmatched
products being filed into whichever department sorted first, the "Barcode Detected" box staying
open behind the Add Product form, and deleting a sold product being a dead end.

**Still open, in rough priority order:**

- **H1** The wedge scanner drops the first character when an input has focus, so scanning a
  receipt on Returns does nothing. `client/src/utils/barcodeListener.ts:48`
- **H2** Repeat scans of the same item are discarded by a 2.5s debounce with no beep and no
  visual change — three identical bottles ring up as one. Silent revenue loss.
  `client/src/pages/POSPage.tsx`
- **H3** Checkout has **no idempotency key**. A lost response leaves Confirm re-enabled over an
  intact cart; pressing it creates a second sale, second receipt and second stock deduction.
- **Receipt dating.** Receipt numbers are minted in UTC and displayed locally, so
  `REC-20260908-…` shows as "Sep 9". In Canada that is a 4–8 hour offset, which puts evening
  sales on the following trading day.
- **No settings screen.** `PUT /api/settings` is complete and owner-only, but nothing calls it.
  The shop trades on seeded defaults, the receipt hardcodes a fake store name and address, and
  currency is hardcoded `$` in the client while a currency setting sits unused.
- **No cash drawer, shift open/close or reconciliation.** Cash refunds already remove money
  from a drawer the system does not model. This is the largest remaining feature gap.
- **Analytics is unsound.** Revenue is summed over the last 50 sales with no status filter and
  refunds are never subtracted. `salesListQuery` accepts only `limit`/`offset` — there is no
  date range anywhere, so "what sold today" cannot be answered.
- **Stock Scan does not offer to register an unknown barcode.** Scanning something absent from
  the catalogue on the stock in/out screen should prompt to add it, as the POS does. Requested,
  not built.
- **M2** `stock_movements.product_id` is still `ON DELETE CASCADE` while `sale_items` and
  `return_items` are `RESTRICT`. A product only ever received and written off takes its
  shrinkage history with it.
- **M9/M10** `TRUST_PROXY` maps to one proxy hop but there are two behind Hosting and Cloud
  Run; if `req.ip` resolves to a Google frontend, the login lockout keyed on (username, IP)
  could lock staff out store-wide. `/api/auth/*` has no rate limiting while each attempt costs
  a ~16 MB scrypt hash, and `app.use(cors())` has no origin allowlist. The Cloud Run URL is
  publicly reachable; the Hosting rewrite does not hide it.
- **Engineering hygiene:** client TypeScript has `strict` off, there are zero client tests
  across roughly 7,800 lines, 14 raw `alert()`/`confirm()` calls, no CI, no error boundary, and
  POSPage is a single 1,100-line component.
- `netlify.toml` is dead and should be deleted.

## 11. Design review — 2026-09-10

A four-voice council plus seven specialist reviewers examined the live screens; 22 findings
survived three-vote adversarial verification. **The council was briefed before the market was
confirmed as Canada**, so its currency, tax-inclusive-pricing and UPI conclusions are void.

What survives and is market-independent:

- All three external voices independently rejected a visual restyle. The screens are the most
  finished part of the product; the numbers on them are the weak part.
- The absence of a Settings screen is the root cause of most of it — the shop cannot put its own
  name, currency or tax into its own software.
- **Stock Scan is the best screen in the product** — persistent focused scan field, quantity
  chips, explicit mode toggle, running session log. POS has none of that and leads with a Camera
  Scan button almost nobody uses. Copying Stock Scan onto POS is the cheapest good design
  decision available.
- Quick wins, each roughly a minute: stat-card figures sit at about 2.1:1 contrast; "1 products"
  needs a plural; the Returns placeholder shows `REC-20260909-0001` while real receipts look
  like `REC-20260908-3CDB`, so a cashier typing what they see will never find a refund; "Reset"
  on Staff should say "Reset password"; the sidebar footer is sliced off at the viewport bottom.
- The council flagged the Owner role dropdown as a self-lockout risk. **This was a false
  positive** — the guard already exists in the client (`disabled={isSelf}`) and the server
  (which refuses self-demotion and refuses to leave zero owners). It was read from a screenshot,
  where a disabled select looks enabled.

**The strongest dissent, worth keeping in mind:** this system has not traded a real day. Two
products, twelve units, two receipts, one account. Every ergonomic claim in that review — the
council's own included — is educated guesswork. One trading hour with the real catalogue would
settle more arguments than a design sprint.

## 12. Working agreements

- Commit and push only when the user asks.
- Never write passwords or secrets into files.
- Git identity: ColourHatShu, kampanwalautsav55@gmail.com. Remote is
  `https://github.com/ColourHatShu/Retail_System.git`. `gh` CLI is not installed.
