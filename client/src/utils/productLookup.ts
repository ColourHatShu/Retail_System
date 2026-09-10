import { Department } from '../types';
import { api } from './api';

export interface ProductLookupResult {
  found: boolean;
  name?: string;
  brand?: string;
  departmentId?: number;
  departmentName?: string;
  unit?: string;
  sku?: string;
  source?: string;
  /** True when the server answered from its cache rather than calling a registry. */
  cached?: boolean;
}

/**
 * Asks the server to identify a barcode.
 *
 * This used to call three product registries straight from the browser, which
 * could not work: UPCitemdb — the registry with the broadest non-food coverage —
 * answers with `Access-Control-Allow-Origin: https://www.upcitemdb.com`, so the
 * browser discarded the response and the code fell through to a no-name result
 * that filled in only a SKU. The lookup now runs in `lookup.service.ts`, where
 * there is no cross-origin restriction, requests carry a timeout, answers are
 * cached in Postgres, and scanned barcodes stop leaving the shop network from
 * every till.
 *
 * `departments` is no longer used — the server matches the department itself,
 * against the live department list — but the parameter is kept so callers did
 * not have to change.
 */
export async function lookupBarcodeOnline(
  barcode: string,
  _departments: Department[] = [],
): Promise<ProductLookupResult> {
  const clean = barcode.trim();
  if (clean.length < 6) return { found: false };

  try {
    const result = await api.lookupBarcode(clean);
    return {
      found: result.found,
      name: result.name,
      brand: result.brand,
      departmentId: result.departmentId,
      departmentName: result.departmentName,
      unit: result.unit,
      sku: result.sku,
      source: result.source,
      cached: result.cached,
    };
  } catch {
    // The server is unreachable, or the registries had nothing. Either way the
    // user types the details in by hand, which is the same outcome as a miss.
    return { found: false };
  }
}
