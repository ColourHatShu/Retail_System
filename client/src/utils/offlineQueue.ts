import { api, ApiError } from './api';
import type { CheckoutRequest } from './api';

/**
 * Sales rung up while the register cannot reach the server. Each keeps the
 * client_ref it was given at the counter, so an upload that times out and is
 * retried can never record the sale twice (the server returns the first copy).
 * Lives in localStorage: it survives a reload, but only on this device.
 */

const KEY = 'nexus-offline-sales-v1';
const EVENT = 'nexus-offline-queue';

export interface QueuedSale {
  client_ref: string;
  order: CheckoutRequest;
  queued_at: string;
  /** Set when the server refused the upload; the sale stays queued for a person to look at. */
  error?: string;
}

export function loadQueue(): QueuedSale[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as QueuedSale[]) : [];
  } catch {
    return [];
  }
}

function save(queue: QueuedSale[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(queue));
  } catch {
    // Storage full or blocked: nothing more we can do on this device.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function onQueueChange(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

function newRef(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

/** A failure that means "could not reach the server", not "the server said no". */
export function isNetworkError(err: unknown): boolean {
  return !(err instanceof ApiError) || (typeof navigator !== 'undefined' && navigator.onLine === false);
}

/** The id a checkout carries so a retried upload can never record it twice. */
export function newClientRef(): string {
  return newRef();
}

export function enqueue(order: CheckoutRequest, clientRef = order.client_ref ?? newRef()): QueuedSale {
  const entry: QueuedSale = {
    client_ref: clientRef,
    order: { ...order, expected_total: undefined, sold_at: new Date().toISOString() },
    queued_at: new Date().toISOString(),
  };
  save([...loadQueue(), entry]);
  return entry;
}

export function discard(clientRef: string) {
  save(loadQueue().filter((q) => q.client_ref !== clientRef));
}

let flushing = false;

/** Uploads what it can. Stops at the first network failure: still offline. */
export async function flushQueue(): Promise<{ synced: number; failed: number }> {
  if (flushing) return { synced: 0, failed: 0 };
  flushing = true;
  let synced = 0;
  let failed = 0;
  try {
    for (const entry of loadQueue()) {
      try {
        await api.checkout({ ...entry.order, client_ref: entry.client_ref });
        save(loadQueue().filter((q) => q.client_ref !== entry.client_ref));
        synced += 1;
      } catch (err) {
        if (isNetworkError(err)) break;
        failed += 1;
        save(
          loadQueue().map((q) =>
            q.client_ref === entry.client_ref ? { ...q, error: (err as Error).message || 'Upload refused' } : q,
          ),
        );
      }
    }
  } finally {
    flushing = false;
  }
  return { synced, failed };
}
