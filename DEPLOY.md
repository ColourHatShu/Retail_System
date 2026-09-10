# Deploying Nexus POS to Firebase

Last updated: 2026-09-10

## The shape of it

Firebase Hosting serves static files. It cannot run Express. So the deployment is two
halves that Firebase stitches into one origin:

| Half | Where it runs | What it is |
|---|---|---|
| `client/dist` | Firebase Hosting (CDN) | the built React app |
| `server` | **Cloud Run** (a container) | the Express API |
| Postgres | **stays on Supabase** | unchanged; Firebase does not replace it |

`firebase.json` rewrites `/api/**` to the Cloud Run service **before** the SPA catch-all.
That ordering matters: reverse them and every API call returns `index.html`.

Because the rewrite makes the API same-origin, **leave `VITE_API_BASE` unset**. The client
already defaults to `/api` (`client/src/utils/api.ts:4`), which is exactly right here.

### Why Cloud Run and not Cloud Functions

Cloud Functions 2nd gen *is* Cloud Run underneath, but deploying an existing Express app to
Cloud Run needs no code restructuring — the container just runs `node dist/index.js`, and
`src/index.ts` already reads `process.env.PORT`, which Cloud Run injects. Nothing to change.

---

## Before you start

Install the two CLIs (neither is on this machine yet) and sign in. **Run these yourself** —
they open a browser for authentication:

```bash
npm install -g firebase-tools
firebase login
```

Install the Google Cloud CLI from https://cloud.google.com/sdk/docs/install, then:

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

Then create a Firebase project (or attach Firebase to an existing GCP project) at
https://console.firebase.google.com, **enable billing** — Cloud Run requires the Blaze plan —
and put the project ID into `.firebaserc`, replacing `REPLACE_WITH_YOUR_FIREBASE_PROJECT_ID`.

---

## Step 1 — the connection string (the step most likely to bite)

Do not reuse the `DATABASE_URL` from `server/.env` without checking it first.

Supabase serves **direct** connections (`db.<ref>.supabase.co`) over IPv6 only on current
projects. Cloud Run's default egress is IPv4. If you paste the direct string, the container
starts, tries to migrate, and dies with a connection timeout that looks like a firewall
problem and is not.

Use the **Supavisor session pooler** instead — in the Supabase dashboard, *Project Settings →
Database → Connection string*, choose **Session mode**. It looks like:

```
postgresql://postgres.<ref>:PASSWORD@aws-0-<region>.pooler.supabase.com:5432/postgres
```

**Session mode (port 5432), not transaction mode (port 6543).** This is not a preference.
`server/src/migrations.ts:304` takes `pg_advisory_lock`, which is *session*-scoped, and
releases it on a later statement (line 328). A transaction-mode pooler can hand that server
connection to someone else in between, so the lock protecting your migrations silently stops
protecting them.

While you are in there: **rotate the password.** It was pasted into a chat session and per
`HANDOFF.md` §8 has still not been changed.

---

## Step 2 — deploy the API to Cloud Run

From the repository root:

```bash
gcloud run deploy nexus-pos-api \
  --source server \
  --region us-central1 \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 3 \
  --memory 512Mi \
  --set-env-vars "PG_POOL_MAX=5,TRUST_PROXY=true"
```

Then set the database URL separately so it never lands in shell history or a file:

```bash
gcloud run services update nexus-pos-api --region us-central1 --set-env-vars DATABASE_URL=...
```

Better still, put it in Secret Manager and reference it with `--set-secrets`.

The service name and region **must match `firebase.json`** (`nexus-pos-api`, `us-central1`).
`--allow-unauthenticated` is required — Firebase Hosting calls the service as an anonymous
client. Cloud Run builds the image remotely from `server/Dockerfile`, so Docker does not need
to be running locally.

### Why those flags

- **`--min-instances 1`** — without it Cloud Run scales to zero and the first scan of the
  morning waits through a cold start *plus* `initDatabase()`, which runs all six migrations
  before the server listens (`src/index.ts:8`). A cashier watching a spinner at 7am is how a
  POS loses its users. This is the one flag that costs money; see Cost below.
- **`PG_POOL_MAX=5` with `--max-instances 3`** — the pool is per instance, so the ceiling is
  5 × 3 = 15 connections. The default of 10 per instance with unbounded instances is how you
  exhaust Postgres.
- **`TRUST_PROXY=true`** — needed for `req.ip`, but verify it rather than trusting it; see
  Gotchas.

Verify the API directly before wiring the client to it:

```bash
curl https://nexus-pos-api-XXXXX-uc.a.run.app/api/health
```

You want `{"status":"ok",...}`. If it hangs or 500s, read the logs — it is almost always
Step 1:

```bash
gcloud run services logs read nexus-pos-api --region us-central1 --limit 50
```

---

## Step 3 — deploy the client

```bash
cd client && npm run build && cd ..
firebase deploy --only hosting
```

Then open the Hosting URL. The first screen should be the **first-run owner setup wall**, not
a login box, because the live database has no users yet. Create the owner account there
yourself — never let anyone else create it for you.

---

## Step 4 — verify the seam

The half that breaks in production is the rewrite, so test it specifically:

1. `curl https://YOUR-PROJECT.web.app/api/health` — must return JSON, not HTML. HTML means
   the SPA catch-all is winning and the rewrite order in `firebase.json` is wrong.
2. Sign in, then hard-refresh. You should stay signed in.
3. Open DevTools → Application → Service Workers. Confirm the active worker is
   `nexus-pos-v3`. Then in the Network tab, confirm `/api/*` requests do **not** say
   "(from ServiceWorker)". See the service worker note below.
4. Ring up a sale and confirm stock decrements on the Inventory page.

---

## Cost

Hosting, and the Postgres you already pay Supabase for, are unchanged. The new line item is
Cloud Run's always-warm instance, which is billed for idle time — on the order of **$10–20 a
month** for 1 vCPU / 512 MiB, but confirm against current Cloud Run pricing rather than
taking that number as given. Dropping `--min-instances 1` makes it nearly free and buys you a
multi-second cold start on the first sale of every quiet period. For a shop, pay the $15.

---

## Gotchas specific to this codebase

**The service worker was a live hazard and is now fixed.** `client/public/sw.js` applied
stale-while-revalidate to *every* same-origin GET despite a comment claiming it was network-
first for the API. Under a Hosting rewrite `/api/**` becomes same-origin, so this would have
cached stock levels, prices, and one cashier's `/api/auth/me` and served it to the next
cashier on a shared till. `sw.js` now returns early for `/api/`, and the cache name moved to
`nexus-pos-v3` so the `activate` handler evicts anything already poisoned. `firebase.json`
sends `no-cache` on `/sw.js` so this fix can actually reach devices — without that header a
stale worker can pin itself. This was audit item **H5**; it is closed.

**`server/package-lock.json` is not the workspace lockfile, and it drifts.** The root
`package.json` declares `workspaces: ["client", "server"]`, so npm hoists every dependency
into the root `node_modules` and records it in the **root** `package-lock.json`. It ignores
nested lockfiles completely. `server/package-lock.json` had gone stale — 126 entries with no
`vitest`, `vite`, `rollup` or `supertest` — which local development never noticed, because
the hoisted root install satisfies `npm test` regardless.

The Docker build copies only `server/`, so `npm ci` read that dead file and failed with
`Missing: @rollup/rollup-linux-x64-gnu ... from lock file`. It was regenerated standalone
(outside the workspace, so npm could not hoist) and now carries 234 entries including all 25
rollup platform variants.

**This can drift again.** After adding or upgrading a server dependency, regenerate it:

```bash
# from a scratch directory containing only a copy of server/package.json
npm install --package-lock-only
```

then copy the result over `server/package-lock.json`. Running `npm install` *inside*
`server/` will not do this — npm detects the workspace root and hoists instead.

**`TRUST_PROXY` needs verifying, not assuming.** `app.ts:20` maps `TRUST_PROXY=true` to
`trust proxy = 1`, meaning one hop. Behind Hosting *and* Cloud Run there are two. If `req.ip`
resolves to a Google frontend address rather than the real client, the login lockout keyed on
(username, IP) collapses onto one address and five wrong passwords can lock staff out
store-wide. Log `req.ip` from a real device and adjust the hop count before you rely on it.
Audit **M9**.

**The Cloud Run URL stays publicly reachable.** The Hosting rewrite does not hide it.
`app.use(cors())` has no origin allowlist and `/api/auth/*` has no rate limiting, while every
login costs a ~16 MB scrypt hash — an unauthenticated CPU amplifier pointed at a service you
now pay for per request. Audit **M10**. Close this soon after launch.

**Migrations run on every cold start.** `initDatabase()` is called before `listen()`. The
advisory lock makes this safe, not fast. With `--min-instances 1` it effectively only happens
on deploy.

**`netlify.toml` is now dead.** It publishes the client with no `/api` rule. Delete it once
Firebase is live, or you will eventually debug the wrong deployment.

---

## What this does not fix

Hosting the app does not make it shop-ready. Per `HANDOFF.md` §11.4 there is still no cash
drawer or shift close, no date-range reporting, no settings screen, and the receipt hardcodes
a fake store name and address. The register-breaking defects H1 (scanner drops the first
character), H2 (repeat scans silently discarded — three bottles ring as one) and H3 (no
checkout idempotency, so a lost response can double-charge) are all still open, and all cost
money the day a real shop uses this.

Deploying first is still the right order: it makes everything after it testable in the place
it will actually run.
