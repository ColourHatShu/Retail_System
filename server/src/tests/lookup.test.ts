import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getPool } from '../db';
import { lookupBarcode } from '../services/lookup.service';
import { createTestSchema, dropTestSchema, hasDatabase } from './helpers';

/**
 * The registries are never contacted here. `fetch` is stubbed so these tests
 * assert our own parsing, caching and department matching rather than the
 * availability and contents of three third-party services.
 */

type Reply = { status: number; body: unknown };

function stubFetch(replies: Record<string, Reply>, calls: string[] = []) {
  vi.stubGlobal('fetch', async (url: string | URL) => {
    const href = url.toString();
    calls.push(href);
    const key = Object.keys(replies).find((k) => href.includes(k));
    const reply = key ? replies[key] : { status: 404, body: {} };
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
    } as Response;
  });
  return calls;
}

const OFF = 'openfoodfacts.org';
const OBF = 'openbeautyfacts.org';
const UPC = 'upcitemdb.com';

const offHit = (name: string, brands: string, categories: string) => ({
  status: 200,
  body: { status: 1, product: { product_name: name, brands, categories, quantity: '500 ml' } },
});
const miss = { status: 200, body: { status: 0 } };

describe.skipIf(!hasDatabase)('barcode lookup', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await createTestSchema();
    await getPool().query(
      `INSERT INTO departments (name, code, description, color) VALUES
         ('Beverages', 'BEV', 'drinks', '#0ea5e9'),
         ('Personal Care', 'CARE', 'hygiene', '#ec4899')
       ON CONFLICT DO NOTHING`,
    );
  });
  afterAll(dropTestSchema);
  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.UPCITEMDB_ENABLED;
    await getPool().query('DELETE FROM barcode_lookups');
  });

  it('names a product from the first registry that has it, and files it by department', async () => {
    stubFetch({ [OFF]: offHit('Ginger Ale', 'Canada Dry', 'Beverages, Sodas') });

    const result = await lookupBarcode('0069000019832');

    expect(result.found).toBe(true);
    expect(result.name).toBe('Canada Dry Ginger Ale 500 ml');
    expect(result.brand).toBe('Canada Dry');
    expect(result.departmentName).toBe('Beverages');
    expect(result.source).toBe('Open Food Facts');
    expect(result.cached).toBe(false);
    // The SKU carries the matched department's code plus the barcode tail.
    expect(result.sku).toBe('BEV-9832');
  });

  it('creates the standard department when the shop does not have one yet', async () => {
    // createTestSchema() runs initDatabase(), which seeds all six standard
    // departments into an empty table — so remove one to model a real shop that
    // built its own taxonomy and never got the defaults. This is exactly the
    // live shop's situation: it has only 'Hair' and 'Soup'.
    await getPool().query('DELETE FROM departments WHERE code = $1', ['DAIRY']);
    const before = await getPool().query("SELECT id FROM departments WHERE code = 'DAIRY'");
    expect(before.rowCount).toBe(0);

    stubFetch({ [OFF]: offHit('Whole Milk', 'Dairyland', 'Dairy, Milks') });
    const result = await lookupBarcode('0000000000111');

    expect(result.found).toBe(true);
    expect(result.departmentName).toBe('Dairy & Frozen');
    expect(result.sku).toBe('DAIRY-0111');

    const after = await getPool().query<{ name: string; code: string }>(
      "SELECT name, code FROM departments WHERE code = 'DAIRY'",
    );
    expect(after.rows[0]).toEqual({ name: 'Dairy & Frozen', code: 'DAIRY' });
  });

  it('reuses an existing department instead of creating a duplicate', async () => {
    const { rows: before } = await getPool().query<{ n: number }>('SELECT COUNT(*)::int AS n FROM departments');

    stubFetch({ [OFF]: offHit('Orange Juice', 'Oasis', 'Beverages, Juices') });
    const result = await lookupBarcode('0000000000222');

    expect(result.departmentName).toBe('Beverages');
    const { rows: after } = await getPool().query<{ n: number }>('SELECT COUNT(*)::int AS n FROM departments');
    expect(after[0].n).toBe(before[0].n);
  });

  it('leaves the department unset when no rule recognises the category', async () => {
    // Better to have the person choose than to invent a department from an
    // aisle the rules do not understand — that is how sprawl starts.
    const { rows: before } = await getPool().query<{ n: number }>('SELECT COUNT(*)::int AS n FROM departments');

    stubFetch({ [OFF]: offHit('Galvanised Nails 50mm', 'Acme', 'Hardware, Fasteners') });
    const result = await lookupBarcode('0000000000333');

    expect(result.found).toBe(true);
    expect(result.departmentId).toBeUndefined();
    expect(result.sku).toBe('GEN-0333');

    const { rows: after } = await getPool().query<{ n: number }>('SELECT COUNT(*)::int AS n FROM departments');
    expect(after[0].n).toBe(before[0].n);
  });

  it('falls through the registries in order and stops at the first hit', async () => {
    process.env.UPCITEMDB_ENABLED = 'true';
    const calls: string[] = [];
    stubFetch(
      {
        [OFF]: miss,
        [OBF]: miss,
        [UPC]: {
          status: 200,
          body: { code: 'OK', items: [{ title: 'Bar Soap 125g', brand: 'Pears', category: 'Soap' }] },
        },
      },
      calls,
    );

    const result = await lookupBarcode('8901030771286');

    expect(result.found).toBe(true);
    expect(result.name).toBe('Bar Soap 125g');
    expect(result.source).toBe('UPCitemdb');
    expect(result.departmentName).toBe('Personal Care');
    expect(calls).toHaveLength(3);
  });

  it('serves a repeat scan from the cache without calling any registry', async () => {
    stubFetch({ [OFF]: offHit('Ginger Ale', 'Canada Dry', 'Beverages') });
    const first = await lookupBarcode('0069000019832');
    expect(first.cached).toBe(false);

    const calls: string[] = [];
    stubFetch({}, calls);
    const second = await lookupBarcode('0069000019832');

    expect(second.cached).toBe(true);
    expect(second.name).toBe(first.name);
    expect(second.sku).toBe(first.sku);
    expect(calls).toEqual([]);
  });

  it('caches a miss too, so unlisted stock does not re-query on every scan', async () => {
    stubFetch({ [OFF]: miss, [OBF]: miss, [UPC]: { status: 200, body: { code: 'INVALID_UPC' } } });
    const first = await lookupBarcode('9999999999999');
    expect(first.found).toBe(false);
    // A miss still offers a SKU so the field is not left empty.
    expect(first.sku).toBe('GEN-9999');

    const calls: string[] = [];
    stubFetch({}, calls);
    const second = await lookupBarcode('9999999999999');

    expect(second.found).toBe(false);
    expect(second.cached).toBe(true);
    expect(calls).toEqual([]);
  });

  it('leaves UPCitemdb alone unless it is explicitly enabled', async () => {
    // Its free tier is rate-limited per shared IP, so calling it from Cloud Run
    // only ever bought an HTTP 429 and a wasted round trip.
    const calls: string[] = [];
    stubFetch({ [OFF]: miss, [OBF]: miss }, calls);

    const result = await lookupBarcode('0123456789012');

    expect(result.found).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.includes('upcitemdb'))).toBe(false);
  });

  it('does not cache a miss caused by a rate limit or an outage', async () => {
    // 429 from UPCitemdb and 500 from Open Beauty Facts are exactly what the
    // live service saw: "ask again later", not "no such product".
    stubFetch({ [OFF]: { status: 404, body: {} }, [OBF]: { status: 500, body: {} }, [UPC]: { status: 429, body: {} } });

    const result = await lookupBarcode('0000000000429');
    expect(result.found).toBe(false);

    const { rows } = await getPool().query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM barcode_lookups WHERE barcode = $1',
      ['0000000000429'],
    );
    expect(rows[0].n).toBe(0);

    // The very next scan tries again, and succeeds once the registry recovers.
    stubFetch({ [OFF]: offHit('Recovered Item', 'Someone', 'Beverages') });
    const retry = await lookupBarcode('0000000000429');
    expect(retry.found).toBe(true);
    expect(retry.name).toBe('Someone Recovered Item 500 ml');
  });

  it('retries a miss once it has gone stale', async () => {
    stubFetch({ [OFF]: miss, [OBF]: miss, [UPC]: { status: 404, body: {} } });
    await lookupBarcode('9999999999999');

    // Age the cached miss past its 30-day life.
    await getPool().query(
      "UPDATE barcode_lookups SET looked_up_at = now() - interval '31 days' WHERE barcode = $1",
      ['9999999999999'],
    );

    stubFetch({ [OFF]: offHit('Later Listed', 'Someone', 'Beverages') });
    const retried = await lookupBarcode('9999999999999');

    expect(retried.found).toBe(true);
    expect(retried.name).toBe('Someone Later Listed 500 ml');
  });

  it('survives a registry that times out or returns nonsense', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('The operation was aborted due to timeout');
    });

    const result = await lookupBarcode('0069000019832');

    expect(result.found).toBe(false);
    expect(result.sku).toBe('GEN-9832');
  });

  it('rejects a barcode too short to be real without calling out', async () => {
    const calls: string[] = [];
    stubFetch({}, calls);

    const result = await lookupBarcode('123');

    expect(result.found).toBe(false);
    expect(calls).toEqual([]);
  });

  it('never suggests a price, because the registries quote US dollars', async () => {
    process.env.UPCITEMDB_ENABLED = 'true';
    stubFetch({
      [OFF]: miss,
      [OBF]: miss,
      [UPC]: {
        status: 200,
        body: {
          code: 'OK',
          items: [{ title: 'Imported Thing', lowest_recorded_price: 9.99, category: 'Grocery' }],
        },
      },
    });

    const result = await lookupBarcode('0123456789012');

    expect(result.found).toBe(true);
    expect(result).not.toHaveProperty('suggestedPrice');
  });
});
