import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import type { Tender } from '../utils/api';

const METHODS: Array<{ value: Tender; label: string }> = [
  { value: 'CASH', label: 'Cash' },
  { value: 'DEBIT', label: 'Debit' },
  { value: 'CREDIT', label: 'Credit' },
];

const toCents = (v: string) => Math.round((parseFloat(v) || 0) * 100);
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Take one sale in several tenders. Card tenders are charged exactly and may
 * not exceed the total; only cash can be more, and the difference is change.
 */
export const SplitPaymentDialog: React.FC<{
  open: boolean;
  total: number;
  onClose: () => void;
  onConfirm: (payments: Array<{ method: Tender; amount: number }>) => void;
}> = ({ open, total, onClose, onConfirm }) => {
  const totalCents = Math.round(total * 100);
  const [rows, setRows] = useState<Array<{ method: Tender; amount: string }>>([]);

  useEffect(() => {
    if (open) setRows([{ method: 'DEBIT', amount: '' }, { method: 'CASH', amount: '' }]);
  }, [open]);

  const { paid, card, remaining, change, error } = useMemo(() => {
    const cardCents = rows.filter((r) => r.method !== 'CASH').reduce((a, r) => a + toCents(r.amount), 0);
    const paidCents = rows.reduce((a, r) => a + toCents(r.amount), 0);
    return {
      paid: paidCents,
      card: cardCents,
      remaining: Math.max(totalCents - paidCents, 0),
      change: Math.max(paidCents - totalCents, 0),
      error: cardCents > totalCents ? 'Card payments cannot be more than the total.' : null,
    };
  }, [rows, totalCents]);

  if (!open) return null;
  const ready = paid >= totalCents && card <= totalCents;

  const setRow = (i: number, patch: Partial<{ method: Tender; amount: string }>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-zinc-950/50 p-0 sm:p-4" role="dialog" aria-modal="true" aria-label="Split payment">
      <div className="w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl shadow-xl p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-zinc-950">Split payment · {money(totalCents)}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="w-10 h-10 grid place-items-center rounded-xl hover:bg-zinc-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex flex-col gap-2">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                value={r.method}
                onChange={(e) => setRow(i, { method: e.target.value as Tender })}
                className="h-11 px-2 rounded-xl border border-zinc-200 bg-white text-sm"
                aria-label="Payment type"
              >
                {METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
              <input
                type="number"
                step="0.01"
                min="0"
                inputMode="decimal"
                value={r.amount}
                onChange={(e) => setRow(i, { amount: e.target.value })}
                placeholder="0.00"
                aria-label="Amount"
                className="flex-1 min-w-0 h-11 px-3 rounded-xl border border-zinc-200 text-sm tabular-nums"
              />
              <button
                type="button"
                onClick={() => setRow(i, { amount: ((toCents(r.amount) + remaining) / 100).toFixed(2) })}
                disabled={remaining === 0}
                className="h-11 px-2.5 rounded-xl border border-zinc-200 text-xs font-semibold text-zinc-700 disabled:opacity-40"
              >
                Rest
              </button>
              <button
                type="button"
                onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                disabled={rows.length <= 1}
                aria-label="Remove payment"
                className="w-11 h-11 grid place-items-center rounded-xl text-zinc-500 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-30"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setRows((rs) => [...rs, { method: 'CREDIT', amount: '' }])}
            disabled={rows.length >= 6}
            className="self-start inline-flex items-center gap-1.5 h-9 px-2 text-[13px] font-semibold text-zinc-700 hover:bg-zinc-100 rounded-lg"
          >
            <Plus className="w-4 h-4" /> Add payment
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2 text-center text-[13px]">
          <div className="rounded-xl bg-zinc-50 p-2">
            <div className="text-zinc-500">Paid</div>
            <div className="font-bold tabular-nums">{money(paid)}</div>
          </div>
          <div className="rounded-xl bg-zinc-50 p-2">
            <div className="text-zinc-500">Still due</div>
            <div className={`font-bold tabular-nums ${remaining > 0 ? 'text-rose-600' : ''}`}>{money(remaining)}</div>
          </div>
          <div className="rounded-xl bg-emerald-50 p-2">
            <div className="text-emerald-700">Change</div>
            <div className="font-bold tabular-nums text-emerald-800">{money(change)}</div>
          </div>
        </div>
        {error && <p className="text-[13px] text-rose-600">{error}</p>}

        <button
          type="button"
          disabled={!ready}
          onClick={() =>
            onConfirm(
              rows
                .filter((r) => toCents(r.amount) > 0)
                .map((r) => ({ method: r.method, amount: toCents(r.amount) / 100 })),
            )
          }
          className="h-12 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:bg-zinc-200 disabled:text-zinc-500 text-zinc-950 font-bold"
        >
          Charge {money(totalCents)}
        </button>
      </div>
    </div>
  );
};
