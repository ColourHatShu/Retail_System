import React, { useCallback, useEffect, useState } from 'react';
import { PauseCircle, PlayCircle, X } from 'lucide-react';
import { api } from '../utils/api';
import type { HeldSale } from '../utils/api';

/**
 * "Hold" parks the current cart on the server and clears the register;
 * "Held" lists parked carts from either counter and resumes one.
 */
export const HeldSalesControls: React.FC<{
  canHold: boolean;
  disabled?: boolean;
  /** Builds what to park from the current register. */
  snapshot: () => HeldSale['payload'] & { total: number };
  onHeld: () => void;
  onResume: (held: HeldSale) => void;
  onError: (message: string) => void;
}> = ({ canHold, disabled, snapshot, onHeld, onResume, onError }) => {
  const [list, setList] = useState<HeldSale[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api.listHeld().then(setList).catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const hold = async () => {
    const label = window.prompt('Name this held sale (optional), e.g. the customer:', '') ?? null;
    if (label === null) return;
    setBusy(true);
    try {
      await api.holdSale({ ...snapshot(), label: label.trim() || undefined });
      onHeld();
      refresh();
    } catch (err) {
      onError((err as Error).message || 'Could not hold the sale');
    } finally {
      setBusy(false);
    }
  };

  const resume = async (id: number) => {
    setBusy(true);
    try {
      const held = await api.resumeHeld(id);
      setOpen(false);
      onResume(held);
    } catch (err) {
      onError((err as Error).message || 'Could not resume that sale');
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const btn =
    'h-10 px-2.5 rounded-xl text-zinc-700 hover:text-zinc-900 hover:bg-zinc-100 disabled:opacity-40 flex items-center gap-1.5 text-[13px] font-semibold';

  return (
    <div className="relative flex items-center">
      <button type="button" className={btn} onClick={hold} disabled={!canHold || disabled || busy} title="Hold this sale">
        <PauseCircle className="w-4 h-4" />
        <span className="hidden xl:inline">Hold</span>
      </button>
      <button
        type="button"
        className={btn}
        onClick={() => {
          refresh();
          setOpen((v) => !v);
        }}
        disabled={disabled || busy}
        aria-expanded={open}
        title="Held sales"
      >
        <PlayCircle className="w-4 h-4" />
        <span>{list.length > 0 ? `Held (${list.length})` : <span className="hidden xl:inline">Held</span>}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-40 w-72 rounded-xl border border-zinc-200 bg-white shadow-lg p-2 flex flex-col gap-1">
          <div className="flex items-center justify-between px-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Held sales</span>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="w-8 h-8 grid place-items-center rounded-lg hover:bg-zinc-100">
              <X className="w-4 h-4" />
            </button>
          </div>
          {list.length === 0 && <p className="px-1 py-2 text-[13px] text-zinc-500">Nothing on hold.</p>}
          {list.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => void resume(h.id)}
              disabled={busy || !canResume(canHold)}
              className="text-left rounded-lg px-2 py-2 hover:bg-zinc-50 disabled:opacity-50"
            >
              <div className="text-[13px] font-semibold text-zinc-900">{h.label || `${h.item_count} item${h.item_count === 1 ? '' : 's'}`}</div>
              <div className="text-xs text-zinc-500">
                ${h.total.toFixed(2)} · {h.created_by_name ?? 'staff'} · {new Date(h.created_at).toLocaleTimeString()}
              </div>
            </button>
          ))}
          {canHold && list.length > 0 && (
            <p className="px-1 pb-1 text-xs text-amber-700">Finish or hold the current sale before resuming another.</p>
          )}
        </div>
      )}
    </div>
  );
};

/** A held sale can only be resumed onto an empty register. */
function canResume(cartHasItems: boolean) {
  return !cartHasItems;
}
