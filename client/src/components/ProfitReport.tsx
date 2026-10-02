import React, { useEffect, useState } from 'react';
import { api } from '../utils/api';
import type { ReportRow, SalesReport } from '../utils/api';

const money = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`;

const Table: React.FC<{ title: string; rows: ReportRow[]; first?: string }> = ({ title, rows, first = 'Name' }) => (
  <div className="flex flex-col gap-1 min-w-0">
    <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-zinc-500">{title}</span>
    <div className="overflow-x-auto">
      <table className="w-full text-[13px] tabular-nums">
        <thead>
          <tr className="text-left text-xs text-zinc-500">
            <th className="py-1 pr-3 font-medium">{first}</th>
            <th className="py-1 pr-3 font-medium text-right">Units</th>
            <th className="py-1 pr-3 font-medium text-right">Sales</th>
            <th className="py-1 font-medium text-right">Profit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-t border-zinc-100">
              <td className="py-1.5 pr-3 truncate max-w-[200px]">{r.name}</td>
              <td className="py-1.5 pr-3 text-right">{r.units}</td>
              <td className="py-1.5 pr-3 text-right">{money(r.revenue)}</td>
              <td className={`py-1.5 text-right font-semibold ${r.profit < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{money(r.profit)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="py-3 text-zinc-500">
                No sales in this range.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  </div>
);

/**
 * Profit, margin and what sells (and what does not) for the range picked on
 * the Sales page. Revenue is before tax, after discounts and returns.
 */
export const ProfitReport: React.FC<{ fromMs: number; toMs: number }> = ({ fromMs, toMs }) => {
  const [report, setReport] = useState<SalesReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .salesReport(new Date(fromMs).toISOString(), new Date(toMs).toISOString())
      .then((r) => !cancelled && setReport(r))
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [fromMs, toMs]);

  const maxHour = Math.max(1, ...(report?.hours ?? []).map((h) => h.revenue));

  return (
    <div className="rounded-2xl border border-zinc-200/80 bg-white shadow-xs p-5 flex flex-col gap-4">
      <span className="text-[11px] font-semibold uppercase leading-4 tracking-[0.06em] text-zinc-500">Profit &amp; best sellers</span>
      {error && <p className="text-[13px] text-rose-600">{error}</p>}
      {report && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              ['Sales (before tax)', money(report.totals.revenue)],
              ['Cost of goods', money(report.totals.cost)],
              ['Profit', money(report.totals.profit)],
              ['Margin', `${report.totals.margin_percent}%`],
            ].map(([k, v]) => (
              <div key={k} className="flex flex-col">
                <span className="text-xs text-zinc-500">{k}</span>
                <span className="text-lg font-bold text-zinc-950 tabular-nums">{v}</span>
              </div>
            ))}
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <Table title="Top products" rows={report.top_products} first="Product" />
            <Table title="By department" rows={report.departments} first="Department" />
            <Table title="By cashier" rows={report.cashiers} first="Cashier" />
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-zinc-500">Busiest hours</span>
              {report.hours.map((h) => (
                <div key={h.hour} className="flex items-center gap-2 text-[13px] tabular-nums">
                  <span className="w-12 text-zinc-500">{String(h.hour).padStart(2, '0')}:00</span>
                  <div className="flex-1 h-3 rounded bg-zinc-100 overflow-hidden">
                    <div className="h-full bg-emerald-500" style={{ width: `${(h.revenue / maxHour) * 100}%` }} />
                  </div>
                  <span className="w-20 text-right">{money(h.revenue)}</span>
                </div>
              ))}
              {report.hours.length === 0 && <span className="text-[13px] text-zinc-500">No sales in this range.</span>}
            </div>
          </div>
          {report.slow_movers.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-zinc-500">Did not sell in this range</span>
              <div className="flex flex-wrap gap-2 text-[13px]">
                {report.slow_movers.map((s) => (
                  <span key={s.name} className="rounded-lg bg-zinc-100 px-2 py-1">
                    {s.name} · {s.stock_quantity} in stock ({money(s.stock_value)})
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
