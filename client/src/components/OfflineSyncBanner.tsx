import React, { useCallback, useEffect, useState } from 'react';
import { CloudOff, RefreshCw, TriangleAlert } from 'lucide-react';
import { discard, flushQueue, loadQueue, onQueueChange } from '../utils/offlineQueue';
import type { QueuedSale } from '../utils/offlineQueue';

/**
 * Tells the counter when it is offline or holding sales that have not reached
 * the server, and uploads them as soon as the connection is back.
 */
export const OfflineSyncBanner: React.FC<{ onSynced?: () => void }> = ({ onSynced }) => {
  const [queue, setQueue] = useState<QueuedSale[]>(() => loadQueue());
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [busy, setBusy] = useState(false);

  const sync = useCallback(async () => {
    if (loadQueue().length === 0) return;
    setBusy(true);
    try {
      const { synced } = await flushQueue();
      if (synced > 0) onSynced?.();
    } finally {
      setBusy(false);
    }
  }, [onSynced]);

  useEffect(() => {
    const refresh = () => setQueue(loadQueue());
    const up = () => {
      setOnline(true);
      void sync();
    };
    const down = () => setOnline(false);
    const off = onQueueChange(refresh);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    const timer = window.setInterval(() => void sync(), 30_000);
    void sync();
    return () => {
      off();
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
      window.clearInterval(timer);
    };
  }, [sync]);

  const failed = queue.filter((q) => q.error);
  const waiting = queue.length - failed.length;
  if (online && queue.length === 0) return null;

  return (
    <div className="flex-shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[13px] leading-5 text-amber-900 flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {!online ? (
          <span className="flex items-center gap-1.5 font-semibold">
            <CloudOff className="w-4 h-4" /> Offline — sales are saved on this device and upload when the internet is back.
          </span>
        ) : (
          waiting > 0 && <span className="font-semibold">Uploading sales made offline…</span>
        )}
        {waiting > 0 && (
          <span>
            {waiting} sale{waiting === 1 ? '' : 's'} waiting
          </span>
        )}
        {online && queue.length > 0 && (
          <button
            type="button"
            onClick={() => void sync()}
            disabled={busy}
            className="inline-flex items-center gap-1 font-semibold underline disabled:opacity-60"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} /> Upload now
          </button>
        )}
      </div>
      {failed.map((f) => (
        <div key={f.client_ref} className="flex flex-wrap items-center gap-2 text-rose-800">
          <TriangleAlert className="w-4 h-4" />
          <span>
            Offline sale from {new Date(f.queued_at).toLocaleString()} was refused: {f.error}
          </span>
          <button
            type="button"
            className="font-semibold underline"
            onClick={() => {
              if (window.confirm('Remove this offline sale? It will not be recorded anywhere.')) discard(f.client_ref);
            }}
          >
            Remove
          </button>
        </div>
      ))}
    </div>
  );
};
