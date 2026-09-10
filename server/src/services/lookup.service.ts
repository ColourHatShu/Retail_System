import { getPool, row, rows } from '../db';
import type { Queryable } from '../db';

/**
 * Barcode enrichment. A barcode is only a number — every piece of product
 * information has to be looked up somewhere — so this asks the public product
 * registries in turn and caches whatever comes back.
 *
 * This runs on the server rather than in the browser because barcodes then stop
 * leaving the shop network from every till, requests can carry a timeout (the
 * browser version had none), and answers are cached so each barcode costs one
 * external call ever. Open Food Facts rate-limits anonymous callers, so the
 * cache is what keeps the feature working through a busy day.
 */

export interface BarcodeLookup {
  found: boolean;
  barcode: string;
  name?: string;
  brand?: string;
  departmentId?: number;
  departmentName?: string;
  unit?: string;
  sku?: string;
  source?: string;
  /** True when this answer came from the cache rather than a registry. */
  cached: boolean;
}

interface CacheRow {
  barcode: string;
  found: boolean;
  name: string | null;
  brand: string | null;
  unit: string | null;
  category: string | null;
  source: string | null;
  looked_up_at: string;
}

/**
 * A hit never expires — a barcode's product name does not change. A miss is
 * retried after this long, in case the registries gain the product later.
 */
const MISS_TTL_DAYS = 30;

/** Per-registry budget; the worst case for a cold barcode is one of these each. */
const REGISTRY_TIMEOUT_MS = 4_000;

/**
 * UPCitemdb is off by default. It has the broadest non-food retail coverage and
 * is the one registry a browser can never reach (it restricts CORS to its own
 * site), but its free trial tier is rate-limited per IP — and Cloud Run's egress
 * IP is shared across customers, so in production it answered HTTP 429 to every
 * single request. Leaving it on only wasted a round trip per lookup.
 *
 * To turn it back on, buy a key and set UPCITEMDB_ENABLED=true. The keyed
 * endpoint also needs the key sent as a `user_key` header, which
 * `queryUpcItemDb` does not do yet.
 *
 * Read per call rather than at module load so tests can toggle it.
 */
function upcItemDbEnabled(): boolean {
  return process.env.UPCITEMDB_ENABLED === 'true';
}

interface DepartmentRow {
  id: number;
  name: string;
  code: string;
}

/**
 * Each rule maps registry category text to one of six standard shop
 * departments. `standard` is what gets created when the rule fires and the shop
 * has no department of that kind yet — deliberately a FIXED list, because
 * registries phrase the same aisle differently every time ("Beverages, Sodas,
 * Colas" for one cola, "Drinks, Soft drinks, Sugary drinks" for the next).
 * Creating departments from that text directly would sprawl into dozens of
 * near-duplicate chips on the register within a hundred scans, and a department
 * cannot be deleted once it holds a sold product. Six is the ceiling.
 *
 * These six match the set in db.ts seedDefaultDepartments(), which only ever
 * runs on a completely empty table.
 */
interface StandardDepartment {
  name: string;
  code: string;
  description: string;
  color: string;
}

const DEPARTMENT_RULES: Array<{ keywords: string[]; deptCodes: string[]; standard: StandardDepartment }> = [
  {
    keywords: [
      'beverage', 'drink', 'water', 'soda', 'cola', 'juice', 'tea', 'coffee',
      'beer', 'wine', 'energy drink', 'bottled water',
    ],
    deptCodes: ['BEV', 'BEVERAGES', 'DRINKS'],
    standard: { name: 'Beverages', code: 'BEV', description: 'Soft drinks, juices, water, energy drinks', color: '#0ea5e9' },
  },
  {
    keywords: [
      'snack', 'bakery', 'bread', 'biscuit', 'cookie', 'chip', 'crisp',
      'cracker', 'cake', 'chocolate', 'candy', 'wafer', 'pastry',
    ],
    deptCodes: ['BAKE', 'SNACK', 'BAKERY'],
    standard: { name: 'Bakery & Snacks', code: 'BAKE', description: 'Breads, cookies, chips, crackers', color: '#f59e0b' },
  },
  {
    keywords: ['dairy', 'milk', 'cheese', 'butter', 'yogurt', 'cream', 'frozen', 'ice cream', 'curd'],
    deptCodes: ['DAIRY', 'FROZEN'],
    standard: { name: 'Dairy & Frozen', code: 'DAIRY', description: 'Milk, cheese, butter, ice cream', color: '#6366f1' },
  },
  {
    keywords: [
      'shampoo', 'soap', 'personal care', 'beauty', 'cosmetic', 'toothpaste',
      'lotion', 'hygiene', 'deodorant', 'skin', 'hair',
    ],
    deptCodes: ['CARE', 'BEAUTY', 'PERSONAL'],
    standard: { name: 'Personal Care', code: 'CARE', description: 'Soap, shampoo, hygiene, cosmetics', color: '#ec4899' },
  },
  {
    keywords: ['electronic', 'tech', 'cable', 'battery', 'charger', 'adapter', 'usb', 'phone', 'headphone', 'earphone'],
    deptCodes: ['ELEC', 'TECH'],
    standard: { name: 'Electronics & Tech', code: 'ELEC', description: 'Cables, chargers, earphones, accessories', color: '#8b5cf6' },
  },
  {
    keywords: ['grocery', 'pantry', 'flour', 'rice', 'spice', 'sauce', 'oil', 'pasta', 'canned', 'cereal', 'noodle'],
    deptCodes: ['GROC', 'PANTRY', 'GROCERY'],
    standard: { name: 'Grocery & Pantry', code: 'GROC', description: 'Flour, rice, spices, canned foods', color: '#10b981' },
  },
];

type DepartmentRule = (typeof DEPARTMENT_RULES)[number];

function matchRule(text: string): DepartmentRule | undefined {
  const lower = text.toLowerCase();
  return DEPARTMENT_RULES.find((rule) => rule.keywords.some((k) => lower.includes(k)));
}

function findExistingDepartment(rule: DepartmentRule, departments: DepartmentRow[]): DepartmentRow | undefined {
  return departments.find(
    (d) =>
      rule.deptCodes.some((code) => d.code.toUpperCase().includes(code)) ||
      rule.keywords.some((k) => d.name.toLowerCase().includes(k)),
  );
}

async function createStandardDepartment(db: Queryable, std: StandardDepartment): Promise<DepartmentRow | undefined> {
  const created = await row<DepartmentRow>(
    db,
    `INSERT INTO departments (name, code, description, color)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING id, name, code`,
    [std.name, std.code, std.description, std.color],
  );
  if (created) {
    console.log(`[lookup] created department ${created.code} (${created.name})`);
    return created;
  }
  // ON CONFLICT means a department with that name or code already exists — most
  // likely another till created it a moment ago. Use theirs.
  return row<DepartmentRow>(db, 'SELECT id, name, code FROM departments WHERE code = $1 OR name = $2', [
    std.code,
    std.name,
  ]);
}

/**
 * Picks the department for a product, creating the standard one if this shop
 * does not have it yet. Returns undefined when no rule recognises the category
 * at all — the form then asks the person to choose, which is better than
 * inventing a department from an aisle we do not understand.
 */
async function resolveDepartment(
  db: Queryable,
  text: string,
  departments: DepartmentRow[],
): Promise<DepartmentRow | undefined> {
  if (!text.trim()) return undefined;
  const rule = matchRule(text);
  if (!rule) return undefined;
  return findExistingDepartment(rule, departments) ?? createStandardDepartment(db, rule.standard);
}

function inferUnit(text: string): string {
  const lower = text.toLowerCase();
  if (/(bottle|\bml\b|litre|liter|fl oz)/.test(lower)) return 'bottle';
  if (/\b(can|tin)\b/.test(lower)) return 'can';
  if (/(\bpack\b|\bbox\b|\bbag\b|pouch|\bkg\b|gram)/.test(lower)) return 'pack';
  return 'pcs';
}

/**
 * Builds the SKU from the department the product actually matched. Falling back
 * to the first department in the list — as the old client code did — stamped
 * every unmatched product with an unrelated department's code.
 */
function buildSku(barcode: string, dept: DepartmentRow | undefined): string {
  const tail = barcode.replace(/\D/g, '').slice(-4) || '0001';
  return `${dept?.code?.toUpperCase() || 'GEN'}-${tail}`;
}

/**
 * A registry producing nothing is a normal outcome, but it must never be a
 * silent one: the browser version swallowed a CORS rejection for months and the
 * feature just quietly stopped filling in names. Every non-answer is logged with
 * its reason so the next failure is diagnosable from the logs alone.
 */
async function fetchJson(url: string, label: string): Promise<FetchResult> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      // Open Food Facts asks callers to identify themselves.
      headers: { 'User-Agent': 'NexusPOS/1.0 (retail point-of-sale; barcode enrichment)' },
    });
    if (!res.ok) {
      // 429 means we asked too often and 5xx means the registry is unwell. Both
      // are "ask again later", not "this product does not exist".
      const transient = res.status === 429 || res.status >= 500;
      console.warn(`[lookup] ${label} returned HTTP ${res.status}${transient ? ' (transient)' : ''}`);
      return { transient };
    }
    return { data: (await res.json()) as Record<string, unknown>, transient: false };
  } catch (err) {
    // Timeout, DNS failure, malformed JSON: never an authoritative answer.
    console.warn(`[lookup] ${label} failed: ${(err as Error).message} (transient)`);
    return { transient: true };
  }
}

interface FetchResult {
  data?: Record<string, unknown>;
  /** True when the registry could not answer, as opposed to answering "no". */
  transient: boolean;
}

interface QueryResult {
  hit?: RegistryHit;
  transient: boolean;
}

interface RegistryHit {
  name: string;
  brand?: string;
  category: string;
  source: string;
}

async function queryOpenFoodFacts(barcode: string): Promise<QueryResult> {
  const { data, transient } = await fetchJson(
    `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json`,
    'Open Food Facts',
  );
  if (!data || data.status !== 1 || !data.product) return { transient };

  const p = data.product as Record<string, string | undefined>;
  const brand = p.brands ? p.brands.split(',')[0].trim() : '';
  const raw = p.product_name || p.product_name_en || p.generic_name || '';
  if (!raw) return { transient };

  let name = brand && !raw.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${raw}` : raw;
  if (p.quantity && !name.includes(p.quantity)) name = `${name} ${p.quantity}`;

  return {
    hit: {
      name: name.trim(),
      brand: brand || undefined,
      category: `${p.categories || ''} ${name}`,
      source: 'Open Food Facts',
    },
    transient: false,
  };
}

async function queryOpenBeautyFacts(barcode: string): Promise<QueryResult> {
  const { data, transient } = await fetchJson(
    `https://world.openbeautyfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json`,
    'Open Beauty Facts',
  );
  if (!data || data.status !== 1 || !data.product) return { transient };

  const p = data.product as Record<string, string | undefined>;
  const brand = p.brands ? p.brands.split(',')[0].trim() : '';
  const raw = p.product_name || p.product_name_en || '';
  if (!raw) return { transient };

  const name = brand && !raw.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${raw}` : raw;
  return {
    hit: {
      name: name.trim(),
      brand: brand || undefined,
      category: `personal care beauty ${p.categories || ''} ${name}`,
      source: 'Open Beauty Facts',
    },
    transient: false,
  };
}

/**
 * The broadest registry for non-food retail, and the one a browser can never
 * reach: it restricts CORS to its own site. The trial tier is rate-limited per
 * IP, which is the other reason results are cached.
 */
async function queryUpcItemDb(barcode: string): Promise<QueryResult> {
  const { data, transient } = await fetchJson(
    `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(barcode)}`,
    'UPCitemdb',
  );
  if (!data || data.code !== 'OK') return { transient };

  const items = data.items as Array<Record<string, string>> | undefined;
  const item = items?.[0];
  if (!item) return { transient };

  const name = (item.title || item.description || '').trim();
  if (!name) return { transient };

  return {
    hit: {
      name,
      brand: item.brand || undefined,
      category: `${item.category || ''} ${name}`,
      source: 'UPCitemdb',
    },
    transient: false,
  };
}

async function shape(
  db: Queryable,
  barcode: string,
  cached: boolean,
  hit: Pick<CacheRow, 'name' | 'brand' | 'unit' | 'category' | 'source'> | null,
  departments: DepartmentRow[],
): Promise<BarcodeLookup> {
  if (!hit || !hit.name) {
    return { found: false, barcode, cached, sku: buildSku(barcode, undefined) };
  }
  const dept = await resolveDepartment(db, hit.category || hit.name, departments);
  return {
    found: true,
    barcode,
    name: hit.name,
    brand: hit.brand || undefined,
    departmentId: dept?.id,
    departmentName: dept?.name,
    unit: hit.unit || inferUnit(hit.category || hit.name),
    sku: buildSku(barcode, dept),
    source: hit.source || undefined,
    cached,
  };
}

/**
 * Looks a barcode up, preferring the cache. Deliberately does NOT suggest a
 * price: UPCitemdb reports `lowest_recorded_price` in US dollars, and quietly
 * writing a US figure into a Canadian shop's price field would be a money bug
 * of exactly the kind the server-authoritative pricing rules exist to prevent.
 * A human types the price.
 */
export async function lookupBarcode(barcode: string, db: Queryable = getPool()): Promise<BarcodeLookup> {
  const clean = barcode.trim();
  const departments = await rows<DepartmentRow>(db, 'SELECT id, name, code FROM departments ORDER BY id');

  if (clean.length < 6) {
    return { found: false, barcode: clean, cached: false, sku: buildSku(clean, undefined) };
  }

  const cached = await row<CacheRow>(
    db,
    `SELECT barcode, found, name, brand, unit, category, source, looked_up_at
       FROM barcode_lookups
      WHERE barcode = $1
        AND (found = true OR looked_up_at > now() - ($2 || ' days')::interval)`,
    [clean, String(MISS_TTL_DAYS)],
  );

  if (cached) {
    return shape(db, clean, true, cached.found ? cached : null, departments);
  }

  const registries = [queryOpenFoodFacts, queryOpenBeautyFacts];
  if (upcItemDbEnabled()) registries.push(queryUpcItemDb);

  let hit: RegistryHit | undefined;
  let anyTransient = false;
  for (const query of registries) {
    const result = await query(clean);
    anyTransient = anyTransient || result.transient;
    if (result.hit) {
      hit = result.hit;
      break;
    }
  }

  console.log(
    hit
      ? `[lookup] ${clean} resolved by ${hit.source}: ${hit.name}`
      : `[lookup] ${clean} not found in any registry`,
  );

  const unit = hit ? inferUnit(hit.category) : null;

  // Only record an answer we can stand behind. A miss caused by a rate limit or
  // an outage would otherwise be frozen in for MISS_TTL_DAYS, leaving a product
  // unresolvable for a month because a registry was briefly unwell.
  if (!hit && anyTransient) {
    console.warn(`[lookup] ${clean} inconclusive — not caching, will retry next scan`);
    return shape(db, clean, false, null, departments);
  }

  await db.query(
    `INSERT INTO barcode_lookups (barcode, found, name, brand, unit, category, source, looked_up_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (barcode) DO UPDATE
        SET found = EXCLUDED.found, name = EXCLUDED.name, brand = EXCLUDED.brand,
            unit = EXCLUDED.unit, category = EXCLUDED.category, source = EXCLUDED.source,
            looked_up_at = now()`,
    [clean, !!hit, hit?.name ?? null, hit?.brand ?? null, unit, hit?.category ?? null, hit?.source ?? null],
  );

  return shape(
    db,
    clean,
    false,
    hit ? { name: hit.name, brand: hit.brand ?? null, unit, category: hit.category, source: hit.source } : null,
    departments,
  );
}
