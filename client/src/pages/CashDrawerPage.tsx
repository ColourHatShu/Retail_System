import React, { useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, CircleAlert, Lock, Printer, Unlock } from 'lucide-react';
import { User } from '../types';
import { api } from '../utils/api';
import type { ShiftReport, ShiftSummary } from '../utils/api';

const FIELD =
  'w-full h-11 px-3 text-sm bg-white border border-zinc-200 rounded-xl text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900';
const BTN = 'h-11 px-4 inline-flex items-center justify-center gap-2 rounded-xl text-[13px] font-semibold disabled:opacity-60';
const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `$${n.toFixed(2)}`);
const TENDER: Record<string, string> = { CASH: 'Cash', DEBIT: 'Debit', CREDIT: 'Credit', CARD: 'Card' };

const Card: React.FC<{ title: string; children: React.ReactNode; className?: string }> = ({ title, children, className = '' }) => (
  <section className={`rounded-2xl border border-zinc-200/80 bg-white shadow-xs p-5 flex flex-col gap-3 ${className}`}>
    <h2 className="text-[15px] font-semibold text-zinc-950">{title}</h2>
    {children}
  </section>
);

/** The Z-report: everything the drawer saw in one shift. Printable. */
const Report: React.FC<{ r: ShiftReport }> = ({ r }) => (
  <div className="flex flex-col gap-1 text-[13px] tabular-nums" id="z-report">
    <Row k="Opened" v={`${new Date(r.opened_at).toLocaleString()} · ${r.opened_by_name ?? ''}`} />
    {r.closed_at && <Row k="Closed" v={`${new Date(r.closed_at).toLocaleString()} · ${r.closed_by_name ?? ''}`} />}
    <hr className="my-1 border-zinc-100" />
    <Row k={`Sales (${r.sales_count})`} v={money(r.sales_total)} bold />
    <Row k="  of which tax" v={money(r.tax_total)} />
    <Row k="  discounts given" v={money(r.discount_total)} />
    {Object.entries(r.tenders).map(([k, v]) => (
      <Row key={k} k={`  ${TENDER[k] ?? k}`} v={money(v)} />
    ))}
    <Row k={`Refunds (${r.refunds_count})`} v={`−${money(r.refunds_total)}`} />
    {Object.entries(r.refunds_by_method).map(([k, v]) => (
      <Row key={k} k={`  ${TENDER[k] ?? k}`} v={`−${money(v)}`} />
    ))}
    <hr className="my-1 border-zinc-100" />
    <Row k="Opening float" v={money(r.opening_float)} />
    <Row k="Cash sales" v={money(r.tenders.CASH ?? 0)} />
    <Row k="Cash refunds" v={`−${money(r.refunds_by_method.CASH ?? 0)}`} />
    <Row k="Pay-ins" v={money(r.pay_ins)} />
    <Row k="Pay-outs" v={`−${money(r.pay_outs)}`} />
    <Row k="Expected in drawer" v={money(r.expected_cash)} bold />
    {r.counted_cash !== null && <Row k="Counted" v={money(r.counted_cash)} bold />}
    {r.over_short !== null && (
      <Row
        k={r.over_short === 0 ? 'Balanced' : r.over_short > 0 ? 'Over' : 'Short'}
        v={money(Math.abs(r.over_short))}
        bold
        tone={r.over_short === 0 ? 'ok' : 'bad'}
      />
    )}
    {r.movements.length > 0 && (
      <>
        <hr className="my-1 border-zinc-100" />
        {r.movements.map((m) => (
          <Row
            key={m.id}
            k={`${m.type === 'PAY_IN' ? 'In' : 'Out'}: ${m.reason} (${m.user_name ?? ''})`}
            v={`${m.type === 'PAY_IN' ? '' : '−'}${money(m.amount)}`}
          />
        ))}
      </>
    )}
    {r.note && <p className="text-zinc-500">Note: {r.note}</p>}
  </div>
);

const Row: React.FC<{ k: string; v: string; bold?: boolean; tone?: 'ok' | 'bad' }> = ({ k, v, bold, tone }) => (
  <div className={`flex justify-between gap-3 ${bold ? 'font-semibold text-zinc-950' : 'text-zinc-700'} ${tone === 'bad' ? 'text-rose-700' : tone === 'ok' ? 'text-emerald-700' : ''}`}>
    <span className="whitespace-pre">{k}</span>
    <span>{v}</span>
  </div>
);

export const CashDrawerPage: React.FC<{ currentUser: User }> = ({ currentUser }) => {
  const isManager = currentUser.role !== 'CASHIER';
  const [shift, setShift] = useState<ShiftReport | null | undefined>(undefined);
  const [history, setHistory] = useState<ShiftSummary[]>([]);
  const [viewing, setViewing] = useState<ShiftReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [float, setFloat] = useState('');
  const [move, setMove] = useState({ type: 'PAY_OUT' as 'PAY_IN' | 'PAY_OUT', amount: '', reason: '' });
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      setShift(await api.currentShift());
      if (isManager) setHistory(await api.listShifts());
    } catch (err) {
      setError((err as Error).message);
    }
  }, [isManager]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full px-4 sm:px-6 py-4 sm:py-6 flex flex-col gap-4 max-w-4xl">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl lg:text-[22px] font-bold tracking-[-0.01em] text-zinc-950">Cash Drawer</h1>
        <p className="text-[13px] text-zinc-500">
          Open the drawer with a float, record cash taken in or out, and count it at close. Every cash sale and refund
          lands on the open shift.
        </p>
      </div>

      {error && (
        <div role="alert" className="flex gap-2 p-3 rounded-xl bg-rose-50 border border-rose-200 text-[13px] text-rose-700">
          <CircleAlert className="w-4 h-4 mt-px" />
          {error}
        </div>
      )}

      {shift === null && (
        <Card title="Open the drawer">
          <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-800">
            Starting cash (float)
            <input className={FIELD} type="number" step="0.01" min="0" inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} placeholder="200.00" />
          </label>
          <button
            type="button"
            disabled={busy || float.trim() === ''}
            onClick={() => run(async () => setShift(await api.openShift(parseFloat(float) || 0)))}
            className={`${BTN} bg-zinc-900 text-white self-start`}
          >
            <Unlock className="w-4 h-4" /> Open shift
          </button>
        </Card>
      )}

      {shift && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Current shift">
            <Report r={shift} />
          </Card>
          <div className="flex flex-col gap-4">
            <Card title="Cash in or out">
              <div className="flex gap-2">
                {(['PAY_OUT', 'PAY_IN'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setMove((m) => ({ ...m, type: t }))}
                    aria-pressed={move.type === t}
                    className={`${BTN} flex-1 border ${move.type === t ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white border-zinc-200 text-zinc-800'}`}
                  >
                    {t === 'PAY_OUT' ? <ArrowUpFromLine className="w-4 h-4" /> : <ArrowDownToLine className="w-4 h-4" />}
                    {t === 'PAY_OUT' ? 'Take out' : 'Put in'}
                  </button>
                ))}
              </div>
              <input className={FIELD} type="number" step="0.01" min="0" inputMode="decimal" placeholder="Amount" value={move.amount} onChange={(e) => setMove((m) => ({ ...m, amount: e.target.value }))} />
              <input className={FIELD} placeholder="Reason (e.g. bought milk, bank change)" value={move.reason} onChange={(e) => setMove((m) => ({ ...m, reason: e.target.value }))} />
              <button
                type="button"
                disabled={busy || !move.amount || move.reason.trim().length < 2}
                onClick={() =>
                  run(async () => {
                    setShift(await api.cashMovement({ type: move.type, amount: parseFloat(move.amount), reason: move.reason.trim() }));
                    setMove((m) => ({ ...m, amount: '', reason: '' }));
                  })
                }
                className={`${BTN} bg-zinc-900 text-white`}
              >
                Record
              </button>
            </Card>
            <Card title="Close the drawer">
              <input className={FIELD} type="number" step="0.01" min="0" inputMode="decimal" placeholder="Cash counted in the drawer" value={counted} onChange={(e) => setCounted(e.target.value)} />
              <input className={FIELD} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
              <button
                type="button"
                disabled={busy || counted.trim() === ''}
                onClick={() =>
                  run(async () => {
                    if (!window.confirm('Close this shift? Sales after this go on the next shift.')) return;
                    const closed = await api.closeShift({ counted_cash: parseFloat(counted) || 0, note: note.trim() || undefined });
                    setViewing(closed);
                    setCounted('');
                    setNote('');
                    await load();
                  })
                }
                className={`${BTN} bg-rose-600 text-white`}
              >
                <Lock className="w-4 h-4" /> Close shift &amp; print Z-report
              </button>
            </Card>
          </div>
        </div>
      )}

      {viewing && (
        <Card title={`Z-report · shift #${viewing.id}`}>
          <Report r={viewing} />
          <div className="flex gap-2">
            <button type="button" onClick={() => window.print()} className={`${BTN} bg-zinc-900 text-white`}>
              <Printer className="w-4 h-4" /> Print
            </button>
            <button type="button" onClick={() => setViewing(null)} className={`${BTN} border border-zinc-200`}>
              Close
            </button>
          </div>
        </Card>
      )}

      {isManager && history.length > 0 && (
        <Card title="Past shifts">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px] tabular-nums">
              <thead>
                <tr className="text-left text-xs text-zinc-500">
                  <th className="py-1 pr-3 font-medium">Opened</th>
                  <th className="py-1 pr-3 font-medium">By</th>
                  <th className="py-1 pr-3 font-medium text-right">Expected</th>
                  <th className="py-1 pr-3 font-medium text-right">Counted</th>
                  <th className="py-1 font-medium text-right">Over / short</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr
                    key={h.id}
                    className="border-t border-zinc-100 cursor-pointer hover:bg-zinc-50"
                    onClick={() => run(async () => setViewing(await api.getShift(h.id)))}
                  >
                    <td className="py-1.5 pr-3">{new Date(h.opened_at).toLocaleString()}</td>
                    <td className="py-1.5 pr-3">{h.opened_by_name}</td>
                    <td className="py-1.5 pr-3 text-right">{h.status === 'OPEN' ? 'open' : money(h.expected_cash)}</td>
                    <td className="py-1.5 pr-3 text-right">{money(h.counted_cash)}</td>
                    <td className={`py-1.5 text-right font-semibold ${h.over_short ? 'text-rose-700' : 'text-emerald-700'}`}>
                      {h.over_short === null ? '—' : `${h.over_short > 0 ? '+' : h.over_short < 0 ? '−' : ''}${money(Math.abs(h.over_short))}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
};
