# Handoff — Nexus POS (Retail_System)

Last updated: 2026-09-09
Branch: `improve/phase-1-money` — pushed, up to date with `origin/improve/phase-1-money`
Head commit: `fdd3322` "Harden POS into a multi-user Postgres system with returns and voids"
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
| Track A item 3. Register discounts | not started |
| Track A item 4. Reports | not started |
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
   `{ version, name, up }`; applied versions are recorded in `schema_migrations` and the whole
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
`alert()` and `confirm()` calls with proper toasts and dialogs, splitting the 1,076-line
POSPage, GitHub Actions CI running typecheck and tests, and hosting the Express server so the
Netlify client works again via `VITE_API_BASE`.

## 10. Working agreements

- Commit and push only when the user asks. They asked for the current push; the default is that
  they handle git themselves.
- Never write passwords or secrets into files for the user.
- Git identity in use: ColourHatShu, kampanwalautsav55@gmail.com. Remote is
  `https://github.com/ColourHatShu/Retail_System.git`. `gh` CLI is not installed.
