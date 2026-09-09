import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Undo2, AlertTriangle, CheckCircle2, ShieldAlert, Ban, RotateCcw, Receipt } from 'lucide-react';
import { ReturnCondition, ReturnLineInput, ReturnQuote, ReturnRecord, Sale, User } from '../types';
import { api, ApiError } from '../utils/api';
import { useHardwareBarcodeScanner } from '../utils/barcodeListener';
import { playScanErrorSound, playScanSuccessSound } from '../utils/audio';

interface ReturnsPageProps {
  currentUser: User;
  refreshData: () => Promise<void>;
}

const CONDITIONS: Array<{ value: ReturnCondition; label: string; restock: boolean }> = [
  { value: 'RESALABLE', label: 'Resalable, back to shelf', restock: true },
  { value: 'DAMAGED', label: 'Damaged, write off', restock: false },
  { value: 'EXPIRED', label: 'Expired, write off', restock: false },
  { value: 'DEFECTIVE', label: 'Defective, write off', restock: false },
  { value: 'OTHER', label: 'Other, write off', restock: false },
];

const STATUS_LABEL: Record<string, string> = {
  COMPLETED: 'Completed',
  PARTIALLY_REFUNDED: 'Partially refunded',
  REFUNDED: 'Fully refunded',
  VOIDED: 'Voided',
};

const money = (n: number) => `$${n.toFixed(2)}`;

type LineState = { quantity: number; condition: ReturnCondition };

export const ReturnsPage: React.FC<ReturnsPageProps> = ({ currentUser, refreshData }) => {
  const [receiptInput, setReceiptInput] = useState('');
  const [sale, setSale] = useState<Sale | null>(null);
  const [lines, setLines] = useState<Record<number, LineState>>({});
  const [reason, setReason] = useState('');
  const [quote, setQuote] = useState<ReturnQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReturnRecord | null>(null);
  const [recent, setRecent] = useState<ReturnRecord[]>([]);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const canVoid = currentUser.role !== 'CASHIER';

  const loadRecent = useCallback(async () => {
    try {
      setRecent(await api.getReturns(10));
    } catch {
      // Not critical; the list is informational.
    }
  }, []);

  useEffect(() => {
    loadRecent();
    inputRef.current?.focus();
  }, [loadRecent]);

  const lookup = useCallback(async (raw: string) => {
    const code = raw.trim();
    if (!code) return;
    setError(null);
    setResult(null);
    setQuote(null);
    setLines({});
    setReason('');
    setVoidOpen(false);
    setBusy(true);
    try {
      const found = await api.getSaleByReceipt(code);
      setSale(found);
      setReceiptInput(found.receipt_number);
      playScanSuccessSound();
    } catch (err) {
      setSale(null);
      playScanErrorSound();
      setError(err instanceof ApiError ? err.message : 'Receipt not found');
    } finally {
      setBusy(false);
    }
  }, []);

  // Receipts carry a Code 128 barcode of the receipt number; a hardware scanner types it.
  useHardwareBarcodeScanner((code) => {
    if (/^REC-/i.test(code)) lookup(code);
  });

  const requestLines: ReturnLineInput[] = useMemo(
    () =>
      Object.entries(lines)
        .filter(([, l]) => l.quantity > 0)
        .map(([id, l]) => ({
          sale_item_id: Number(id),
          quantity: l.quantity,
          condition: l.condition,
          restock: CONDITIONS.find((c) => c.value === l.condition)?.restock ?? true,
        })),
    [lines],
  );

  // Ask the server what this return is worth whenever the lines change.
  useEffect(() => {
    if (!sale || requestLines.length === 0) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const q = await api.quoteReturn({ sale_id: sale.id, items: requestLines });
        if (!cancelled) {
          setQuote(q);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setQuote(null);
          setError(err instanceof ApiError ? err.message : 'Could not calculate refund');
        }
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [sale, requestLines]);

  const setLine = (id: number, patch: Partial<LineState>) =>
    setLines((prev) => {
      const current: LineState = prev[id] ?? { quantity: 0, condition: 'RESALABLE' };
      return { ...prev, [id]: { ...current, ...patch } };
    });

  const process = async () => {
    if (!sale || !quote?.allowed) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createReturn({ sale_id: sale.id, items: requestLines, reason: reason.trim() || undefined });
      setResult(created);
      playScanSuccessSound();
      setLines({});
      setReason('');
      setSale(await api.getSale(sale.id));
      await Promise.all([refreshData(), loadRecent()]);
    } catch (err) {
      playScanErrorSound();
      setError(err instanceof ApiError ? err.message : 'Return failed');
    } finally {
      setBusy(false);
    }
  };

  const doVoid = async () => {
    if (!sale) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.voidSale(sale.id, voidReason.trim());
      setResult(created);
      setVoidOpen(false);
      setVoidReason('');
      setSale(await api.getSale(sale.id));
      await Promise.all([refreshData(), loadRecent()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Void failed');
    } finally {
      setBusy(false);
    }
  };

  const saleAgeHours = sale ? (Date.now() - new Date(sale.created_at).getTime()) / 3_600_000 : Infinity;
  const voidable = !!sale && canVoid && sale.status === 'COMPLETED' && (sale.refunded_total ?? 0) === 0 && saleAgeHours <= 24;

  const field =
    'px-3 py-2 text-sm bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:bg-white';

  return (
    <div className="w-full max-w-5xl px-3 sm:px-6 py-4 sm:py-6 space-y-5">
      <div>
        <h1 className="text-lg font-extrabold text-zinc-900 flex items-center gap-2">
          <Undo2 className="w-5 h-5 text-emerald-600" /> Returns &amp; Refunds
        </h1>
        <p className="text-xs text-zinc-500">
          Scan or type the receipt number. Refunds go back to the original tender and are pro-rated for any discount
          and tax on the receipt.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          lookup(receiptInput);
        }}
        className="flex gap-2"
      >
        <div className="relative flex-1">
          <Receipt className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            ref={inputRef}
            className={`${field} w-full pl-9 font-mono uppercase`}
            placeholder="REC-20260909-0001"
            value={receiptInput}
            onChange={(e) => setReceiptInput(e.target.value.toUpperCase())}
            autoCapitalize="characters"
            spellCheck={false}
          />
        </div>
        <button
          type="submit"
          disabled={busy || !receiptInput.trim()}
          className="flex items-center gap-2 px-4 py-2 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-60 text-white text-xs font-bold rounded-xl"
        >
          <Search className="w-4 h-4" /> Find
        </button>
      </form>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" /> <span>{error}</span>
        </div>
      )}

      {result && (
        <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 space-y-1">
          <div className="flex items-center gap-2 text-sm font-bold text-emerald-900">
            <CheckCircle2 className="w-4 h-4" /> {result.kind === 'VOID' ? 'Sale voided' : 'Refund processed'}:{' '}
            {result.return_number}
          </div>
          <div className="text-xs text-emerald-800">
            Refund <strong>{money(result.refund)}</strong> to {result.refund_method}
            {result.items && result.items.length > 0 && (
              <>
                {' '}
                for {result.items.map((i) => `${i.quantity} × ${i.name}${i.restock ? '' : ' (written off)'}`).join(', ')}
              </>
            )}
            . Give the customer the cash or reverse the card payment now.
          </div>
        </div>
      )}

      {sale && (
        <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-100 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-bold text-zinc-900 font-mono">{sale.receipt_number}</div>
              <div className="text-[11px] text-zinc-500">
                {new Date(sale.created_at).toLocaleString()} • {sale.cashier_name ?? 'Unknown cashier'} • paid{' '}
                {money(sale.total)} by {sale.payment_method}
                {(sale.refunded_total ?? 0) > 0 && <> • refunded {money(sale.refunded_total ?? 0)}</>}
              </div>
            </div>
            <span
              className={`text-[10px] font-bold px-2 py-1 rounded-md ${
                sale.status === 'COMPLETED'
                  ? 'bg-emerald-50 text-emerald-700'
                  : sale.status === 'VOIDED'
                    ? 'bg-zinc-200 text-zinc-700'
                    : 'bg-amber-50 text-amber-800'
              }`}
            >
              {STATUS_LABEL[sale.status ?? 'COMPLETED']}
            </span>
          </div>

          {sale.status === 'VOIDED' ? (
            <div className="p-4 text-xs text-zinc-500">This receipt was voided; nothing can be returned against it.</div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-zinc-50 text-[10px] uppercase tracking-wide text-zinc-500">
                    <tr>
                      <th className="text-left px-4 py-2">Item</th>
                      <th className="text-right px-3 py-2">Paid each</th>
                      <th className="text-right px-3 py-2">Sold</th>
                      <th className="text-right px-3 py-2">Returned</th>
                      <th className="text-right px-3 py-2">Return now</th>
                      <th className="text-left px-3 py-2">Condition</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100">
                    {(sale.items ?? []).map((item) => {
                      const remaining = item.quantity - (item.returned_quantity ?? 0);
                      const line = lines[item.id] ?? { quantity: 0, condition: 'RESALABLE' as ReturnCondition };
                      return (
                        <tr key={item.id} className={remaining === 0 ? 'opacity-50' : ''}>
                          <td className="px-4 py-2.5 font-semibold text-zinc-900">{item.name}</td>
                          <td className="px-3 py-2.5 text-right font-mono">{money(item.unit_price)}</td>
                          <td className="px-3 py-2.5 text-right">{item.quantity}</td>
                          <td className="px-3 py-2.5 text-right">{item.returned_quantity ?? 0}</td>
                          <td className="px-3 py-2.5 text-right">
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                disabled={line.quantity <= 0}
                                onClick={() => setLine(item.id, { quantity: Math.max(0, line.quantity - 1) })}
                                className="w-6 h-6 rounded-md border border-zinc-200 disabled:opacity-40"
                              >
                                −
                              </button>
                              <span className="w-6 text-center font-mono">{line.quantity}</span>
                              <button
                                type="button"
                                disabled={line.quantity >= remaining}
                                onClick={() => setLine(item.id, { quantity: Math.min(remaining, line.quantity + 1) })}
                                className="w-6 h-6 rounded-md border border-zinc-200 disabled:opacity-40"
                              >
                                +
                              </button>
                            </div>
                          </td>
                          <td className="px-3 py-2.5">
                            <select
                              className="px-2 py-1 bg-zinc-50 border border-zinc-200 rounded-lg text-xs"
                              value={line.condition}
                              disabled={remaining === 0}
                              onChange={(e) => setLine(item.id, { condition: e.target.value as ReturnCondition })}
                            >
                              {CONDITIONS.map((c) => (
                                <option key={c.value} value={c.value}>
                                  {c.label}
                                </option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="p-4 border-t border-zinc-100 space-y-3">
                <input
                  className={`${field} w-full`}
                  placeholder="Reason (optional): changed mind, wrong size, faulty..."
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={300}
                />

                {quote && (
                  <div
                    className={`p-3 rounded-xl border text-xs space-y-1 ${
                      quote.allowed ? 'bg-zinc-50 border-zinc-200' : 'bg-amber-50 border-amber-200'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-zinc-600">Refund to {quote.refund_method}</span>
                      <span className="text-base font-extrabold text-zinc-900 font-mono">{money(quote.refund)}</span>
                    </div>
                    {quote.completes_sale && <div className="text-zinc-500">This returns everything on the receipt.</div>}
                    {!quote.allowed && (
                      <div className="flex items-start gap-1.5 text-amber-900 font-semibold">
                        <ShieldAlert className="w-4 h-4 flex-shrink-0" /> {quote.blocked_reason}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2">
                  {voidable ? (
                    voidOpen ? (
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <input
                          className={`${field} flex-1`}
                          placeholder="Why is the whole sale being voided?"
                          value={voidReason}
                          onChange={(e) => setVoidReason(e.target.value)}
                          maxLength={300}
                        />
                        <button
                          type="button"
                          disabled={busy || voidReason.trim().length < 3}
                          onClick={doVoid}
                          className="px-3 py-2 bg-rose-600 hover:bg-rose-700 disabled:opacity-60 text-white text-xs font-bold rounded-xl"
                        >
                          Confirm void
                        </button>
                        <button type="button" onClick={() => setVoidOpen(false)} className="text-xs text-zinc-500 px-2">
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setVoidOpen(true)}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-rose-200 text-rose-700 hover:bg-rose-50 text-xs font-semibold"
                      >
                        <Ban className="w-3.5 h-3.5" /> Void entire sale
                      </button>
                    )
                  ) : (
                    <span className="text-[11px] text-zinc-400">
                      {canVoid ? 'Void is only possible on the day of sale before any return.' : ''}
                    </span>
                  )}

                  <button
                    type="button"
                    disabled={busy || !quote?.allowed || requestLines.length === 0}
                    onClick={process}
                    className="inline-flex items-center gap-2 px-5 py-2.5 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-50 text-white text-sm font-bold rounded-xl"
                  >
                    <RotateCcw className="w-4 h-4" />
                    {busy ? 'Working…' : quote ? `Refund ${money(quote.refund)}` : 'Select items to return'}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-100 text-sm font-bold text-zinc-900">Recent returns</div>
        {recent.length === 0 ? (
          <div className="p-4 text-xs text-zinc-400">No returns yet.</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-zinc-50 text-[10px] uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="text-left px-4 py-2">Return</th>
                <th className="text-left px-3 py-2">Receipt</th>
                <th className="text-left px-3 py-2">Type</th>
                <th className="text-right px-3 py-2">Refund</th>
                <th className="text-left px-3 py-2">By</th>
                <th className="text-left px-3 py-2">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {recent.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2 font-mono">{r.return_number}</td>
                  <td className="px-3 py-2 font-mono">
                    <button type="button" className="underline decoration-dotted" onClick={() => lookup(r.receipt_number ?? '')}>
                      {r.receipt_number}
                    </button>
                  </td>
                  <td className="px-3 py-2">{r.kind === 'VOID' ? 'Void' : 'Return'}</td>
                  <td className="px-3 py-2 text-right font-mono">{money(r.refund)}</td>
                  <td className="px-3 py-2">{r.processed_by_name ?? '—'}</td>
                  <td className="px-3 py-2 text-zinc-500">{new Date(r.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
