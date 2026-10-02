import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Banknote,
  Calendar,
  ChevronRight,
  CircleAlert,
  CreditCard,
  DollarSign,
  Printer,
  QrCode,
  Receipt,
  RefreshCw,
  ScanBarcode,
  Search,
} from 'lucide-react';
import { Department, ReturnRecord, Sale } from '../types';
import { api } from '../utils/api';
import { ProfitReport } from '../components/ProfitReport';
import { ReceiptModal } from '../components/ReceiptModal';

interface AnalyticsPageProps {
  /**
   * Still passed by App.tsx. Stock valuation moved to Inventory (it counted
   * archived products here and crowded out the receipts), so this page no
   * longer reads it; the prop stays so App's call site is untouched.
   */
  departments: Department[];
}

// SPEC.md pill palette: good / warning / critical / neutral.
const STATUS_PILL: Record<string, { label: string; className: string }> = {
  COMPLETED: { label: 'Completed', className: 'bg-emerald-50 text-emerald-700' },
  PARTIALLY_REFUNDED: { label: 'Partially refunded', className: 'bg-amber-50 text-amber-700' },
  REFUNDED: { label: 'Fully refunded', className: 'bg-rose-50 text-rose-700' },
  VOIDED: { label: 'Voided', className: 'bg-zinc-100 text-zinc-700' },
};

const TENDER_LABEL: Record<string, string> = {
  CASH: 'Cash',
  CARD: 'Card',
  DEBIT: 'Debit',
  CREDIT: 'Credit',
  UPI_QR: 'UPI / QR',
  SPLIT: 'Split',
};

const TENDER_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  CASH: Banknote,
  CARD: CreditCard,
  UPI_QR: QrCode,
  SPLIT: DollarSign,
};

type RangeId = 'today' | 'yesterday' | 'last7' | 'custom';

// ---------------------------------------------------------------------------
// Formatting and date helpers
// ---------------------------------------------------------------------------

const money = (n: number) => `$${n.toFixed(2)}`;
/** True minus sign, as the artboards use it, so refunds never read as a hyphen. */
const negative = (n: number) => (n === 0 ? '$0.00' : `−$${Math.abs(n).toFixed(2)}`);

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

const dayOf = (d: Date) =>
  d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

const shortDayOf = (d: Date) => d.toLocaleDateString([], { day: 'numeric', month: 'short' });

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

const toInputDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const fromInputDate = (v: string): Date | null => {
  const [y, m, d] = v.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
};

/**
 * The register is the shop's own terminal, so the browser's calendar day is the
 * shop's calendar day. Sales are stamped in UTC, which is why the boundaries are
 * built locally rather than by slicing the ISO string.
 */
function resolveRange(id: RangeId, customFrom: string, customTo: string) {
  const now = new Date();
  if (id === 'yesterday') {
    const d = addDays(now, -1);
    return { from: startOfDay(d), to: endOfDay(d), label: dayOf(d), singleDay: true };
  }
  if (id === 'last7') {
    const first = addDays(now, -6);
    return {
      from: startOfDay(first),
      to: endOfDay(now),
      label: `${shortDayOf(first)} – ${shortDayOf(now)}`,
      singleDay: false,
    };
  }
  if (id === 'custom') {
    const a = fromInputDate(customFrom) || now;
    const b = fromInputDate(customTo) || a;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    const singleDay = lo.getTime() === hi.getTime();
    return {
      from: startOfDay(lo),
      to: endOfDay(hi),
      label: singleDay ? dayOf(lo) : `${shortDayOf(lo)} – ${shortDayOf(hi)}`,
      singleDay,
    };
  }
  return { from: startOfDay(now), to: endOfDay(now), label: dayOf(now), singleDay: true };
}

/**
 * Neither /sales nor /returns can filter by date, so the page walks newest-first
 * pages until one reaches past the start of the range. The page cap stops a wide
 * custom range from dragging a shop's whole history across the wire; when it bites,
 * `complete` is false and the screen says so rather than under-reporting silently.
 */
const PAGE_SIZE = 200;
const MAX_PAGES = 5;

async function loadRange<T extends { created_at: string }>(
  fetchPage: (limit: number, offset: number) => Promise<T[]>,
  from: number,
): Promise<{ rows: T[]; complete: boolean }> {
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await fetchPage(PAGE_SIZE, page * PAGE_SIZE);
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { rows, complete: true };
    if (new Date(batch[batch.length - 1].created_at).getTime() < from) return { rows, complete: true };
  }
  return { rows, complete: false };
}

/**
 * A voided sale never happened and a refund hands the money back, so neither
 * belongs in revenue. The server sends status and refunded_total for exactly this.
 */
function sumTotals(list: Sale[]) {
  const activeSales = list.filter((s) => s.status !== 'VOIDED');
  const grossRevenue = activeSales.reduce((acc, s) => acc + Number(s.total), 0);
  const refundedTotal = activeSales.reduce((acc, s) => acc + Number(s.refunded_total || 0), 0);
  return { activeSales, grossRevenue, refundedTotal, netRevenue: grossRevenue - refundedTotal };
}

/** Units per receipt. Older rows predate the server sending it; they show a dash. */
function itemUnits(s: Sale): number | null {
  const n = (s as Sale & { item_count?: number }).item_count;
  return typeof n === 'number' ? n : null;
}

interface Bucket {
  label: string;
  value: number;
}

function buildBuckets(sales: Sale[], from: Date, to: Date, singleDay: boolean): Bucket[] {
  if (singleDay) {
    const hours = sales.map((s) => new Date(s.created_at).getHours());
    let start = hours.length ? Math.min(...hours) : 9;
    let end = hours.length ? Math.max(...hours) : 17;
    // One lonely bar reads as a broken chart, so open the window either side of it.
    while (end - start < 5) {
      if (start > 0) start -= 1;
      if (end < 23 && end - start < 5) end += 1;
      if (start === 0 && end === 23) break;
    }
    const out: Bucket[] = [];
    for (let h = start; h <= end; h += 1) out.push({ label: `${String(h).padStart(2, '0')}:00`, value: 0 });
    for (const s of sales) {
      const bucket = out[new Date(s.created_at).getHours() - start];
      if (bucket) bucket.value += Number(s.total);
    }
    return out;
  }

  const out: Bucket[] = [];
  const index = new Map<string, number>();
  const cursor = new Date(from);
  while (cursor <= to && out.length < 62) {
    index.set(cursor.toDateString(), out.length);
    out.push({ label: shortDayOf(cursor), value: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  for (const s of sales) {
    const i = index.get(new Date(s.created_at).toDateString());
    if (i !== undefined) out[i].value += Number(s.total);
  }
  return out;
}

/** Round the axis up to a figure a person would pick, so gridlines land on round money. */
function axisMax(peak: number): number {
  if (peak <= 0) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(peak)));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (peak <= step * pow) return step * pow;
  }
  return 10 * pow;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

const Pill: React.FC<{ className: string; children: React.ReactNode }> = ({ className, children }) => (
  <span
    className={`inline-flex h-[22px] shrink-0 items-center rounded-full px-2 text-xs font-semibold ${className}`}
  >
    {children}
  </span>
);

const CardShell: React.FC<{ className?: string; children: React.ReactNode }> = ({ className = '', children }) => (
  <div className={`rounded-2xl border border-zinc-200/80 bg-white shadow-xs ${className}`}>{children}</div>
);

const MicroLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="text-[11px] font-semibold uppercase leading-4 tracking-[0.06em] text-zinc-500">{children}</span>
);

const StatFigure: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="text-[28px] font-extrabold leading-8 tracking-[-0.02em] text-zinc-950 tabular-nums">
    {children}
  </span>
);

const TenderMark: React.FC<{ method: string }> = ({ method }) => {
  const Icon = TENDER_ICON[method] || DollarSign;
  return (
    <span className="flex items-center gap-2 text-zinc-600">
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate text-sm text-zinc-800">{TENDER_LABEL[method] || method}</span>
    </span>
  );
};

/**
 * The receipt column on wide screens. Below 1536px the same sale opens in the
 * existing receipt dialog instead — there is no room for a 400px column beside a
 * table this wide, and the dialog already prints.
 */
const ReceiptDetail: React.FC<{
  sale: Sale | null;
  loading: boolean;
  refunds: ReturnRecord[];
  onReprint: () => void;
}> = ({ sale, loading, refunds, onReprint }) => {
  if (loading && !sale) {
    return (
      <CardShell className="flex min-h-[320px] items-center justify-center p-6">
        <span className="flex items-center gap-2 text-[13px] text-zinc-500">
          <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading receipt…
        </span>
      </CardShell>
    );
  }

  if (!sale) {
    return (
      <CardShell className="flex min-h-[320px] flex-col items-center justify-center gap-2 p-8 text-center">
        <Receipt className="h-7 w-7 text-zinc-300" aria-hidden="true" />
        <span className="text-sm font-semibold text-zinc-700">Select a receipt</span>
        <span className="text-[13px] leading-5 text-zinc-500">
          Its lines, tax and refund history appear here.
        </span>
      </CardShell>
    );
  }

  const pill = STATUS_PILL[sale.status || 'COMPLETED'] || STATUS_PILL.COMPLETED;
  const refunded = Number(sale.refunded_total || 0);
  const discount = Number(sale.discount || 0);
  const items = sale.items || [];
  const units = items.reduce((acc, i) => acc + Number(i.quantity), 0);
  const history = refunds.filter((r) => r.sale_id === sale.id).slice().reverse();

  return (
    <CardShell className="flex max-h-[calc(100vh-3rem)] flex-col overflow-hidden">
      <div className="flex flex-col gap-1.5 border-b border-zinc-100 p-5">
        <MicroLabel>Receipt</MicroLabel>
        <div className="flex items-center justify-between gap-3">
          <span className="truncate font-mono text-base font-semibold text-zinc-950">{sale.receipt_number}</span>
          <Pill className={pill.className}>{pill.label}</Pill>
        </div>
        <span className="text-[13px] leading-5 text-zinc-600 tabular-nums">
          {dayOf(new Date(sale.created_at))} · {timeOf(sale.created_at)} · {sale.cashier_name || 'Unknown cashier'} ·{' '}
          {TENDER_LABEL[sale.payment_method] || sale.payment_method}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-2.5 border-b border-zinc-100 px-5 py-4">
          <MicroLabel>Items · {units || items.length}</MicroLabel>
          {items.length === 0 ? (
            <span className="text-[13px] text-zinc-500">This receipt has no stored lines.</span>
          ) : (
            items.map((item) => {
              const returned = Number(item.returned_quantity || 0);
              return (
                <div key={item.id} className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-semibold leading-5 text-zinc-950">{item.name}</span>
                    <span className="font-mono text-xs leading-4 text-zinc-500">{item.barcode}</span>
                    {returned > 0 && (
                      <span className="pt-1">
                        <Pill className="bg-amber-50 text-amber-700 tabular-nums">
                          {returned} of {item.quantity} returned
                        </Pill>
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-0.5">
                    <span className="text-[15px] font-semibold leading-5 text-zinc-950 tabular-nums">
                      {money(Number(item.total_price))}
                    </span>
                    <span className="text-xs leading-4 text-zinc-500 tabular-nums">
                      {item.quantity} × {money(Number(item.unit_price))}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="flex flex-col gap-2 border-b border-zinc-100 px-5 py-4 tabular-nums">
          <div className="flex flex-col gap-1 text-[13px] leading-6 text-zinc-600">
            <div className="flex justify-between">
              <span>Subtotal</span>
              <span className="text-zinc-800">{money(Number(sale.subtotal))}</span>
            </div>
            {discount > 0 && (
              <div className="flex justify-between">
                <span>Discount</span>
                <span className="text-zinc-800">{negative(discount)}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span>Tax ({Number(sale.tax_rate).toFixed(2).replace(/\.?0+$/, '')}%)</span>
              <span className="text-zinc-800">{money(Number(sale.tax_amount))}</span>
            </div>
            <div className="flex justify-between font-semibold text-zinc-800">
              <span>Total paid</span>
              <span className="text-zinc-950">{money(Number(sale.total))}</span>
            </div>
            {refunded > 0 && (
              <div className="flex justify-between">
                <span>Refunded · includes its tax</span>
                <span className="font-semibold text-rose-700">{negative(refunded)}</span>
              </div>
            )}
          </div>
          <div className="h-px bg-zinc-200" />
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-zinc-950">Net after refunds</span>
            <span className="text-lg font-extrabold leading-7 text-zinc-950 tabular-nums">
              {money(Number(sale.total) - refunded)}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-2.5 px-5 py-4">
          <MicroLabel>History</MicroLabel>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-[48px_minmax(0,1fr)] gap-3">
              <span className="text-[13px] font-semibold leading-5 text-zinc-800 tabular-nums">
                {timeOf(sale.created_at)}
              </span>
              <div className="flex flex-col">
                <span className="text-[13px] leading-5 text-zinc-800">
                  Sold by {sale.cashier_name || 'unknown cashier'}
                </span>
                <span className="text-xs leading-4 text-zinc-500 tabular-nums">
                  {TENDER_LABEL[sale.payment_method] || sale.payment_method} · {money(Number(sale.total))}
                  {units > 0 ? ` · ${units} items` : ''}
                </span>
              </div>
            </div>
            {history.map((r) => (
              <div key={r.id} className="grid grid-cols-[48px_minmax(0,1fr)] gap-3">
                <span className="text-[13px] font-semibold leading-5 text-zinc-800 tabular-nums">
                  {timeOf(r.created_at)}
                </span>
                <div className="flex flex-col">
                  <span className="text-[13px] leading-5 text-zinc-800">
                    {r.kind === 'VOID' ? 'Voided' : 'Refunded'} by {r.processed_by_name || 'unknown user'}
                  </span>
                  <span className="text-xs leading-4 text-zinc-500 tabular-nums">
                    {TENDER_LABEL[r.refund_method] || r.refund_method} · {negative(Number(r.refund))}
                    {r.reason ? ` · ${r.reason}` : ''}
                  </span>
                </div>
              </div>
            ))}
            {refunded > 0 && history.length === 0 && (
              <span className="text-xs leading-4 text-zinc-500">
                Refund records for this receipt are outside the selected range.
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="border-t border-zinc-100 p-4">
        <button
          type="button"
          onClick={onReprint}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white text-[13px] font-semibold text-zinc-800 transition-colors hover:bg-zinc-50 active:scale-98"
        >
          <Printer className="h-4 w-4" aria-hidden="true" />
          Reprint receipt
        </button>
      </div>
    </CardShell>
  );
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export const AnalyticsPage: React.FC<AnalyticsPageProps> = () => {
  const [sales, setSales] = useState<Sale[]>([]);
  const [refunds, setRefunds] = useState<ReturnRecord[]>([]);
  const [rangeCovered, setRangeCovered] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);

  const [rangeId, setRangeId] = useState<RangeId>('today');
  const [customFrom, setCustomFrom] = useState(() => toInputDate(new Date()));
  const [customTo, setCustomTo] = useState(() => toInputDate(new Date()));
  const [query, setQuery] = useState('');
  const [lookupError, setLookupError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);

  /**
   * Two layout switches are decided in JS rather than with `hidden`/`lg:block`
   * pairs, because a day's receipts would otherwise be built twice — once for the
   * table and once for the cards — and only one of them is ever on screen. The
   * detail column needs 1536px: below that the table already fills the width, so
   * a receipt opens in the existing dialog, exactly as it does today.
   */
  const readLayout = () => ({
    table: window.matchMedia('(min-width: 1024px)').matches,
    detail: window.matchMedia('(min-width: 1536px)').matches,
  });
  const [layout, setLayout] = useState(readLayout);
  const wideLayout = layout.detail;
  useEffect(() => {
    const queries = ['(min-width: 1024px)', '(min-width: 1536px)'].map((q) => window.matchMedia(q));
    const sync = () => setLayout(readLayout());
    queries.forEach((q) => q.addEventListener('change', sync));
    return () => queries.forEach((q) => q.removeEventListener('change', sync));
  }, []);

  const range = useMemo(() => resolveRange(rangeId, customFrom, customTo), [rangeId, customFrom, customTo]);
  const fromMs = range.from.getTime();
  const toMs = range.to.getTime();

  // A range change mid-flight must not be overwritten by the older request.
  const requestRef = useRef(0);

  const loadAll = useCallback(async () => {
    const token = (requestRef.current += 1);
    try {
      setLoading(true);
      setError(null);
      const [salesResult, refundsResult] = await Promise.all([
        loadRange<Sale>((limit, offset) => api.getSales(limit, offset), fromMs),
        loadRange<ReturnRecord>((limit, offset) => api.getReturns(limit, offset), fromMs),
      ]);
      if (token !== requestRef.current) return;
      setSales(salesResult.rows);
      setRefunds(refundsResult.rows);
      setRangeCovered(salesResult.complete && refundsResult.complete);
      setLoadedAt(new Date());
    } catch (err) {
      if (token !== requestRef.current) return;
      // Without this the table falls through to the empty state and a dead API
      // reads to the cashier as "a day with no sales".
      setError(err instanceof Error ? err.message : 'Could not load sales.');
    } finally {
      if (token === requestRef.current) setLoading(false);
    }
  }, [fromMs]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  /** A receipt picked in one range is not in the next one, so the column starts clean. */
  const clearSelection = () => {
    setSelectedId(null);
    setSelectedSale(null);
    setLookupError(null);
  };

  const inRange = useCallback(
    (iso: string) => {
      const t = new Date(iso).getTime();
      return t >= fromMs && t <= toMs;
    },
    [fromMs, toMs],
  );

  const rangedSales = useMemo(() => sales.filter((s) => inRange(s.created_at)), [sales, inRange]);
  const rangedRefunds = useMemo(() => refunds.filter((r) => inRange(r.created_at)), [refunds, inRange]);

  const { activeSales, grossRevenue, refundedTotal, netRevenue } = useMemo(
    () => sumTotals(rangedSales),
    [rangedSales],
  );
  const totalTax = activeSales.reduce((acc, s) => acc + Number(s.tax_amount || 0), 0);

  // Filing figures: everything charged in the range (voids included), less
  // the tax handed back by refunds and voids in the same range.
  const taxReport = useMemo(() => {
    const sum = (list: Array<number | undefined>) => list.reduce<number>((a, v) => a + Number(v || 0), 0);
    const gstCollected = sum(rangedSales.map((s) => s.gst_amount ?? s.tax_amount));
    const pstCollected = sum(rangedSales.map((s) => s.pst_amount));
    const gstRefunded = sum(rangedRefunds.map((r) => r.gst_amount));
    const pstRefunded = sum(rangedRefunds.map((r) => r.pst_amount));
    const labels = rangedSales.find((s) => s.tax_labels && s.tax_labels.gst !== 'Tax')?.tax_labels;
    return {
      gstLabel: labels?.gst === 'HST' ? 'HST' : labels ? 'GST' : 'GST/HST',
      pstLabel: labels?.pst ?? 'PST',
      gstCollected,
      gstRefunded,
      pstCollected,
      pstRefunded,
    };
  }, [rangedSales, rangedRefunds]);
  const voidedCount = rangedSales.length - activeSales.length;
  const unitsSold = activeSales.reduce((acc, s) => acc + (itemUnits(s) ?? 0), 0);
  const averageTicket = activeSales.length > 0 ? netRevenue / activeSales.length : 0;

  const tenderTotals = useMemo(
    () =>
      activeSales.reduce((acc, s) => {
        // Each tender's share of what was kept: cash net of change, then
        // scaled down by whatever was refunded.
        const total = Number(s.total);
        const kept = total > 0 ? (total - Number(s.refunded_total || 0)) / total : 0;
        const tenders = s.payments && s.payments.length > 0 ? s.payments : [{ method: s.payment_method, amount: total }];
        let change = Number(s.change_due || 0);
        for (const t of tenders) {
          let amount = Number(t.amount);
          if (t.method === 'CASH' && change > 0) {
            const back = Math.min(change, amount);
            amount -= back;
            change -= back;
          }
          const cell = acc[t.method] || { amount: 0, count: 0 };
          cell.amount += amount * kept;
          cell.count += 1;
          acc[t.method] = cell;
        }
        return acc;
      }, {} as Record<string, { amount: number; count: number }>),
    [activeSales],
  );
  const tenderRows = Object.entries(tenderTotals).sort((a, b) => b[1].amount - a[1].amount);

  // One rate across the range is the normal case; a mixed range must not claim one.
  const taxRateLabel = useMemo(() => {
    if (activeSales.length === 0) return null;
    const first = Number(activeSales[0].tax_rate);
    return activeSales.every((s) => Number(s.tax_rate) === first)
      ? `${first.toFixed(2).replace(/\.?0+$/, '')}%`
      : null;
  }, [activeSales]);

  const buckets = useMemo(
    () => buildBuckets(activeSales, range.from, range.to, range.singleDay),
    [activeSales, range.from, range.to, range.singleDay],
  );
  const peak = buckets.reduce((m, b) => Math.max(m, b.value), 0);
  const chartMax = axisMax(peak);
  const labelEvery = Math.ceil(buckets.length / 14);
  const showBarLabels = buckets.length <= 12;
  // Whole-dollar gridlines whenever the quarter step is whole; cents otherwise.
  const axisDecimals = Number.isInteger(chartMax / 4) ? 0 : 2;

  const needle = query.trim().toLowerCase();
  const visibleSales = useMemo(
    () =>
      needle
        ? rangedSales.filter(
            (s) =>
              s.receipt_number.toLowerCase().includes(needle) ||
              (s.cashier_name || '').toLowerCase().includes(needle),
          )
        : rangedSales,
    [rangedSales, needle],
  );
  // The footer sums the rows on screen, so a search can never leave a total that
  // does not add up to the receipts under it.
  const visibleTotals = useMemo(() => sumTotals(visibleSales), [visibleSales]);

  // Nothing loaded yet, or the load failed: figures show a dash. $0.00 on a screen
  // that failed to load is a lie a shop could bank on.
  const figuresPending = rangedSales.length === 0 && (loading || error !== null);
  const figure = (value: string) => (figuresPending ? '—' : value);

  const openSale = async (sale: Sale) => {
    setSelectedId(sale.id);
    setLookupError(null);
    setDetailLoading(true);
    try {
      // The list endpoint omits line items, so a receipt built from a list row
      // prints with no lines. Re-fetch the sale by id to get its items.
      const fullSale = await api.getSale(sale.id);
      setSelectedSale(fullSale);
      if (!wideLayout) setReceiptOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load that receipt.');
    } finally {
      setDetailLoading(false);
    }
  };

  /** Escape hatch for a receipt the customer brings in from outside the range. */
  const lookupReceipt = async () => {
    const q = query.trim();
    if (!q) return;
    setDetailLoading(true);
    try {
      setLookupError(null);
      const sale = await api.getSaleByReceipt(q);
      setSelectedSale(sale);
      setSelectedId(sale.id);
      if (!wideLayout) setReceiptOpen(true);
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : `No receipt matches “${q}”.`);
    } finally {
      setDetailLoading(false);
    }
  };

  const rangeOptions: Array<{ id: RangeId; long: string; short: string }> = [
    { id: 'today', long: 'Today', short: 'Today' },
    { id: 'yesterday', long: 'Yesterday', short: 'Yesterday' },
    { id: 'last7', long: 'Last 7 days', short: '7 days' },
    { id: 'custom', long: 'Custom range', short: 'Custom' },
  ];

  const segmentClass = (active: boolean) =>
    `flex h-full min-w-0 items-center justify-center gap-1.5 px-2 text-[13px] transition-colors sm:px-3 lg:justify-start lg:px-4 ${
      active ? 'bg-zinc-900 font-semibold text-white' : 'font-medium text-zinc-700 hover:bg-zinc-50'
    }`;

  const chartTitle = range.singleDay ? 'Sales by hour' : 'Sales by day';
  const chartSummary = buckets
    .filter((b) => b.value > 0)
    .slice(0, 8)
    .map((b) => `${b.label} ${money(b.value)}`)
    .join(', ');

  return (
    <div className="flex w-full min-w-0 max-w-full flex-col gap-4 overflow-x-hidden p-4 md:p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <h1 className="text-xl font-bold leading-7 tracking-[-0.01em] text-zinc-950 sm:text-[22px]">
            Sales &amp; Audit
          </h1>
          <p className="truncate text-[13px] leading-5 text-zinc-500">
            <span className="sm:hidden">
              {range.label}
              {loadedAt ? ` · updated ${timeOf(loadedAt.toISOString())}` : ''}
            </span>
            <span className="hidden sm:inline">
              Net sales, tenders, refunds and every receipt for the selected range.
            </span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {loadedAt && (
            <span className="hidden text-[13px] leading-5 text-zinc-500 tabular-nums lg:inline">
              Updated {timeOf(loadedAt.toISOString())}
            </span>
          )}
          <button
            type="button"
            onClick={loadAll}
            disabled={loading}
            aria-label="Refresh sales"
            className="flex h-11 w-11 items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white text-[13px] font-semibold text-zinc-800 transition-colors hover:bg-zinc-50 active:scale-98 disabled:opacity-60 sm:h-10 sm:w-auto sm:px-3.5"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="flex animate-in items-start gap-2.5 rounded-2xl border border-rose-200 bg-rose-50 p-3.5 text-[13px] leading-5 text-rose-800 fade-in">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            onClick={loadAll}
            className="h-8 shrink-0 rounded-lg border border-rose-200 bg-white px-3 text-xs font-semibold text-rose-700 hover:bg-rose-50"
          >
            Retry
          </button>
        </div>
      )}

      {!rangeCovered && !error && (
        <div className="flex items-start gap-2.5 rounded-2xl border border-amber-200 bg-amber-50 p-3.5 text-[13px] leading-5 text-amber-800">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Showing the most recent {PAGE_SIZE * MAX_PAGES} receipts only. Older receipts inside this range are not
            counted in these figures — narrow the range to be sure of the totals.
          </span>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col gap-3 rounded-2xl border-0 bg-transparent p-0 shadow-none sm:border sm:border-zinc-200/80 sm:bg-white sm:p-3 sm:shadow-xs lg:flex-row lg:items-center lg:justify-between lg:gap-4">
        <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:gap-4">
          <div
            role="group"
            aria-label="Date range"
            className="grid h-11 shrink-0 grid-cols-4 overflow-hidden rounded-xl border border-zinc-200 bg-white lg:flex lg:h-10"
          >
            {rangeOptions.map((opt) => (
              <button
                key={opt.id}
                type="button"
                aria-pressed={rangeId === opt.id}
                onClick={() => {
                  setRangeId(opt.id);
                  clearSelection();
                }}
                className={`${segmentClass(rangeId === opt.id)} ${
                  opt.id === 'today' ? '' : 'border-l border-zinc-200'
                }`}
              >
                {opt.id === 'custom' && <Calendar className="h-4 w-4 shrink-0" aria-hidden="true" />}
                <span className="min-w-0 truncate xl:hidden">{opt.short}</span>
                <span className="hidden min-w-0 truncate xl:inline">{opt.long}</span>
              </button>
            ))}
          </div>

          {rangeId === 'custom' ? (
            <div className="flex shrink-0 items-center gap-2">
              <label className="sr-only" htmlFor="sales-range-from">
                Range starts
              </label>
              <input
                id="sales-range-from"
                type="date"
                value={customFrom}
                max={customTo || undefined}
                onChange={(e) => {
                  setCustomFrom(e.target.value);
                  clearSelection();
                }}
                className="h-11 min-w-0 flex-1 rounded-xl border border-zinc-200 bg-white px-3 text-[13px] text-zinc-900 tabular-nums lg:h-10 lg:flex-none"
              />
              <span className="text-[13px] text-zinc-500">to</span>
              <label className="sr-only" htmlFor="sales-range-to">
                Range ends
              </label>
              <input
                id="sales-range-to"
                type="date"
                value={customTo}
                min={customFrom || undefined}
                onChange={(e) => {
                  setCustomTo(e.target.value);
                  clearSelection();
                }}
                className="h-11 min-w-0 flex-1 rounded-xl border border-zinc-200 bg-white px-3 text-[13px] text-zinc-900 tabular-nums lg:h-10 lg:flex-none"
              />
            </div>
          ) : (
            <div className="hidden items-baseline gap-1.5 text-[13px] leading-5 lg:flex">
              <span className="whitespace-nowrap font-semibold text-zinc-800">{range.label}</span>
              {range.singleDay && <span className="whitespace-nowrap text-zinc-500">· 00:00–23:59</span>}
            </div>
          )}
        </div>

        <div className="flex h-11 w-full items-center gap-2.5 rounded-xl border border-zinc-200 bg-white px-3 text-zinc-500 lg:h-10 lg:w-[360px] lg:shrink-0">
          <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLookupError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') lookupReceipt();
            }}
            placeholder="Find a receipt number, or scan it"
            aria-label="Find a receipt number"
            className="min-w-0 flex-1 bg-transparent text-[13px] leading-5 text-zinc-900 outline-none placeholder:text-zinc-500"
          />
          <ScanBarcode className="h-4 w-4 shrink-0" aria-hidden="true" />
        </div>
      </div>

      {lookupError && (
        <p className="-mt-1 text-[13px] leading-5 text-rose-700">{lookupError}</p>
      )}

      {/* Stats — phone folds the four cards into one, as the phone artboard does */}
      <div className="flex flex-col gap-1 rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-xs sm:hidden">
        <MicroLabel>
          Net sales · {figuresPending ? '—' : `${rangedSales.length} receipts`}
        </MicroLabel>
        <StatFigure>{figure(money(netRevenue))}</StatFigure>
        <div className="flex items-baseline gap-3 text-[13px] leading-5 text-zinc-600">
          <span>
            Gross <span className="font-semibold text-zinc-800 tabular-nums">{figure(money(grossRevenue))}</span>
          </span>
          <span>
            Refunds <span className="font-semibold text-rose-700 tabular-nums">{figure(negative(refundedTotal))}</span>
          </span>
        </div>
        <div className="flex flex-col gap-3 pt-2">
          <div className="h-px bg-zinc-100" />
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'Cash taken', value: tenderTotals.CASH?.amount || 0 },
              {
                label: 'Card taken',
                value:
                  (tenderTotals.CARD?.amount || 0) + (tenderTotals.DEBIT?.amount || 0) + (tenderTotals.CREDIT?.amount || 0),
              },
              { label: 'Tax charged', value: totalTax },
            ].map((cell) => (
              <div key={cell.label} className="flex flex-col gap-0.5">
                <span className="text-xs leading-4 text-zinc-500">{cell.label}</span>
                <span className="text-[15px] font-semibold leading-5 text-zinc-950 tabular-nums">
                  {figure(money(cell.value))}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="hidden gap-4 sm:grid sm:grid-cols-2 2xl:grid-cols-4">
        <CardShell className="flex flex-col gap-2 p-5">
          <MicroLabel>Net sales</MicroLabel>
          <StatFigure>{figure(money(netRevenue))}</StatFigure>
          <div className="flex items-baseline gap-3 text-[13px] leading-5 text-zinc-600">
            <span>
              Gross <span className="font-semibold text-zinc-800 tabular-nums">{figure(money(grossRevenue))}</span>
            </span>
            <span>
              Refunds{' '}
              <span className="font-semibold text-rose-700 tabular-nums">{figure(negative(refundedTotal))}</span>
            </span>
          </div>
        </CardShell>

        <CardShell className="flex flex-col gap-2 p-5">
          <MicroLabel>Receipts</MicroLabel>
          <StatFigure>{figure(String(rangedSales.length))}</StatFigure>
          <span className="text-[13px] leading-5 text-zinc-600 tabular-nums">
            {figuresPending
              ? '—'
              : `${unitsSold} items sold · avg ${money(averageTicket)}${
                  voidedCount > 0 ? ` · ${voidedCount} voided` : ''
                }`}
          </span>
        </CardShell>

        <CardShell className="flex flex-col gap-2 p-5">
          <MicroLabel>Taken by tender</MicroLabel>
          {tenderRows.length === 0 ? (
            <>
              <StatFigure>{figure(money(0))}</StatFigure>
              <span className="text-[13px] leading-5 text-zinc-600">No tendered sales in this range.</span>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
                {tenderRows.map(([method, cell]) => (
                  <div key={method} className="flex items-baseline gap-1.5">
                    <StatFigure>{figure(money(cell.amount))}</StatFigure>
                    <span className="text-[13px] font-semibold leading-5 text-zinc-600">
                      {TENDER_LABEL[method] || method}
                    </span>
                  </div>
                ))}
              </div>
              <span className="text-[13px] leading-5 text-zinc-600 tabular-nums">
                After refunds ·{' '}
                {tenderRows
                  .map(([method, cell]) => `${cell.count} ${(TENDER_LABEL[method] || method).toLowerCase()}`)
                  .join(' · ')}
              </span>
            </>
          )}
        </CardShell>

        <CardShell className="flex flex-col gap-2 p-5">
          <MicroLabel>Tax collected{taxRateLabel ? ` (${taxRateLabel})` : ''}</MicroLabel>
          <StatFigure>{figure(money(totalTax))}</StatFigure>
          <span className="text-[13px] leading-5 text-zinc-600">
            Charged on non-voided receipts · before refunds
          </span>
        </CardShell>
      </div>

      <ProfitReport fromMs={fromMs} toMs={toMs} />

      {/* Tax to remit for the selected range */}
      <CardShell className="flex flex-col gap-3 p-5">
        <MicroLabel>Tax report</MicroLabel>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] leading-5 tabular-nums">
            <thead>
              <tr className="text-left text-xs text-zinc-500">
                <th className="py-1 pr-4 font-medium">Tax</th>
                <th className="py-1 pr-4 font-medium text-right">Collected</th>
                <th className="py-1 pr-4 font-medium text-right">Refunded</th>
                <th className="py-1 font-medium text-right">Net to remit</th>
              </tr>
            </thead>
            <tbody className="text-zinc-900">
              <tr className="border-t border-zinc-100">
                <td className="py-1.5 pr-4 font-semibold">{taxReport.gstLabel} (CRA)</td>
                <td className="py-1.5 pr-4 text-right">{figure(money(taxReport.gstCollected))}</td>
                <td className="py-1.5 pr-4 text-right text-rose-700">{figure(negative(taxReport.gstRefunded))}</td>
                <td className="py-1.5 text-right font-semibold">
                  {figure(money(taxReport.gstCollected - taxReport.gstRefunded))}
                </td>
              </tr>
              {(taxReport.pstCollected > 0 || taxReport.pstRefunded > 0) && (
                <tr className="border-t border-zinc-100">
                  <td className="py-1.5 pr-4 font-semibold">{taxReport.pstLabel} (province)</td>
                  <td className="py-1.5 pr-4 text-right">{figure(money(taxReport.pstCollected))}</td>
                  <td className="py-1.5 pr-4 text-right text-rose-700">{figure(negative(taxReport.pstRefunded))}</td>
                  <td className="py-1.5 text-right font-semibold">
                    {figure(money(taxReport.pstCollected - taxReport.pstRefunded))}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardShell>

      {/* Content */}
      <div className={wideLayout ? 'grid grid-cols-[minmax(0,1fr)_400px] items-start gap-4' : 'flex flex-col gap-4'}>
        <div className="flex min-w-0 flex-col gap-4">
          {/* Sales by hour / day — hidden on phones, as the phone artboard drops it */}
          <CardShell className="hidden flex-col gap-4 p-5 sm:flex">
            <div className="flex flex-col gap-1">
              <span className="text-base font-semibold leading-5 text-zinc-950">{chartTitle}</span>
              <span className="text-[13px] leading-5 text-zinc-500">
                Gross sales before refunds · {range.label}
              </span>
            </div>
            {activeSales.length === 0 ? (
              <div className="flex h-[128px] items-center justify-center text-[13px] text-zinc-500">
                {figuresPending ? 'Figures unavailable.' : 'No sales in this range.'}
              </div>
            ) : (
              <div
                role="img"
                aria-label={`Gross sales by ${range.singleDay ? 'hour' : 'day'}: ${chartSummary || 'none'}`}
                className="flex gap-3"
              >
                <div className="flex h-[128px] w-12 shrink-0 flex-col items-end justify-between self-start whitespace-nowrap py-2 text-xs leading-4 text-zinc-500 tabular-nums">
                  {[1, 0.75, 0.5, 0.25, 0].map((f) => (
                    <span key={f}>${(chartMax * f).toFixed(axisDecimals)}</span>
                  ))}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="relative h-[128px] py-2">
                    <div className="pointer-events-none absolute inset-x-0 bottom-2 top-2 flex flex-col justify-between">
                      <div className="h-px bg-zinc-100" />
                      <div className="h-px bg-zinc-100" />
                      <div className="h-px bg-zinc-100" />
                      <div className="h-px bg-zinc-100" />
                      <div className="h-px bg-zinc-300" />
                    </div>
                    <div className="relative flex h-[112px]">
                      {buckets.map((b) => (
                        // The reserved top strip keeps a full-height bar from pushing
                        // its own value label out of the plot area.
                        <div
                          key={b.label}
                          className={`flex min-w-0 flex-1 flex-col justify-end gap-1 ${showBarLabels ? 'pt-5' : ''}`}
                        >
                          {b.value > 0 && showBarLabels && (
                            <span className="truncate text-center text-xs font-semibold leading-4 text-zinc-800 tabular-nums">
                              {money(b.value)}
                            </span>
                          )}
                          {b.value > 0 && (
                            <div
                              className="mx-auto w-full max-w-[40px] rounded-t-md bg-emerald-600"
                              style={{ height: `${Math.max((b.value / chartMax) * 100, 2)}%` }}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="flex text-xs leading-4 text-zinc-500 tabular-nums">
                    {buckets.map((b, i) => (
                      <span key={b.label} className="min-w-0 flex-1 truncate text-center">
                        {/* Crowded ranges label every Nth column rather than overlapping. */}
                        {i % labelEvery === 0 ? b.label : ''}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </CardShell>

          {/* Receipts */}
          <CardShell className="flex min-w-0 flex-col overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-4 py-3.5 lg:px-5">
              <div className="flex items-center gap-2.5">
                <span className="text-base font-semibold leading-6 text-zinc-950">Receipts</span>
                <Pill className="bg-zinc-100 text-zinc-700 tabular-nums">
                  {figuresPending ? '—' : visibleSales.length}
                </Pill>
              </div>
              <span className="text-[13px] leading-5 text-zinc-500 tabular-nums">
                {needle ? `Filtered by “${query.trim()}”` : 'Newest first · open a receipt to see its lines'}
              </span>
            </div>

            {/* Table from 1024px up */}
            {layout.table && (
              <div>
                <div
                  aria-hidden="true"
                  className="grid grid-cols-[minmax(0,1fr)_130px_96px_64px_110px_150px_20px] items-center gap-3 border-b border-zinc-200 bg-zinc-50 px-5 py-3.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-zinc-500"
                >
                  <span>Receipt</span>
                  <span>Cashier</span>
                  <span>Tender</span>
                  <span className="text-right">Items</span>
                  <span className="text-right">Total</span>
                  <span>Status</span>
                  <span />
                </div>
                {visibleSales.map((s) => {
                const pill = STATUS_PILL[s.status || 'COMPLETED'] || STATUS_PILL.COMPLETED;
                const refunded = Number(s.refunded_total || 0);
                const units = itemUnits(s);
                const selected = selectedId === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => openSale(s)}
                    aria-label={`Receipt ${s.receipt_number}, ${timeOf(s.created_at)}, ${
                      s.cashier_name || 'unknown cashier'
                    }, ${TENDER_LABEL[s.payment_method] || s.payment_method}, ${
                      units === null ? 'unknown' : units
                    } items, total ${money(Number(s.total))}, ${pill.label}`}
                    className={`grid w-full grid-cols-[minmax(0,1fr)_130px_96px_64px_110px_150px_20px] items-center gap-3 border-b border-zinc-100 px-5 py-3 text-left transition-colors ${
                      selected ? 'bg-emerald-50/60 shadow-[inset_3px_0_0_#059669]' : 'hover:bg-zinc-50'
                    }`}
                  >
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate font-mono text-[13px] font-semibold leading-5 text-zinc-950">
                        {s.receipt_number}
                      </span>
                      <span className="text-xs leading-4 text-zinc-500 tabular-nums">
                        {range.singleDay
                          ? timeOf(s.created_at)
                          : `${shortDayOf(new Date(s.created_at))} · ${timeOf(s.created_at)}`}
                      </span>
                    </span>
                    <span className="truncate text-sm leading-5 text-zinc-800">
                      {s.cashier_name || <span className="text-zinc-500">&mdash;</span>}
                    </span>
                    <TenderMark method={s.payment_method} />
                    <span className="text-right text-sm font-semibold leading-5 text-zinc-800 tabular-nums">
                      {units === null ? '—' : units}
                    </span>
                    <span className="flex flex-col items-end gap-0.5">
                      <span
                        className={`text-[15px] font-semibold leading-5 tabular-nums ${
                          s.status === 'VOIDED' ? 'text-zinc-500 line-through' : 'text-zinc-950'
                        }`}
                      >
                        {money(Number(s.total))}
                      </span>
                      {refunded > 0 && (
                        <span className="text-xs leading-4 text-rose-700 tabular-nums">
                          {negative(refunded)} refunded
                        </span>
                      )}
                    </span>
                    <span className="flex">
                      <Pill className={pill.className}>{pill.label}</Pill>
                    </span>
                    <ChevronRight
                      className={`h-4 w-4 ${selected ? 'text-emerald-700' : 'text-zinc-500'}`}
                      aria-hidden="true"
                    />
                  </button>
                );
                })}
              </div>
            )}

            {/* Cards below 1024px */}
            {!layout.table && (
              <div className="divide-y divide-zinc-100">
                {visibleSales.map((s) => {
                const pill = STATUS_PILL[s.status || 'COMPLETED'] || STATUS_PILL.COMPLETED;
                const refunded = Number(s.refunded_total || 0);
                const units = itemUnits(s);
                const selected = selectedId === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => openSale(s)}
                    aria-label={`Receipt ${s.receipt_number}, ${money(Number(s.total))}, ${pill.label}`}
                    className={`flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors ${
                      selected ? 'bg-emerald-50/60' : 'active:bg-zinc-50'
                    }`}
                  >
                    <span className="flex items-center justify-between gap-3">
                      <span className="truncate font-mono text-[13px] font-semibold leading-5 text-zinc-950">
                        {s.receipt_number}
                      </span>
                      <span
                        className={`shrink-0 text-[15px] font-semibold leading-5 tabular-nums ${
                          s.status === 'VOIDED' ? 'text-zinc-500 line-through' : 'text-zinc-950'
                        }`}
                      >
                        {money(Number(s.total))}
                      </span>
                    </span>
                    <span className="truncate text-xs leading-4 text-zinc-600 tabular-nums">
                      {range.singleDay ? '' : `${shortDayOf(new Date(s.created_at))} · `}
                      {timeOf(s.created_at)} · {s.cashier_name || 'Unknown cashier'} ·{' '}
                      {TENDER_LABEL[s.payment_method] || s.payment_method}
                      {units === null ? '' : ` · ${units} items`}
                    </span>
                    <span className="flex items-center justify-between gap-3">
                      <Pill className={pill.className}>{pill.label}</Pill>
                      {refunded > 0 && (
                        <span className="text-xs font-semibold leading-4 text-rose-700 tabular-nums">
                          {negative(refunded)} refunded
                        </span>
                      )}
                    </span>
                    </button>
                  );
                })}
              </div>
            )}

            {visibleSales.length === 0 && !loading && !error && (
              <div className="flex flex-col items-center gap-1 p-10 text-center">
                <Receipt className="mb-1 h-8 w-8 text-zinc-300" aria-hidden="true" />
                <p className="text-sm font-semibold text-zinc-700">
                  {needle ? 'No receipt here matches that search' : 'No receipts in this range'}
                </p>
                <p className="text-[13px] leading-5 text-zinc-500">
                  {needle
                    ? 'It may belong to another day.'
                    : 'Complete a sale in the POS Register tab, or pick a different range.'}
                </p>
                {needle && (
                  <button
                    type="button"
                    onClick={lookupReceipt}
                    className="mt-2 flex h-10 items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3.5 text-[13px] font-semibold text-zinc-800 hover:bg-zinc-50 active:scale-98"
                  >
                    <Search className="h-4 w-4" aria-hidden="true" />
                    Search every receipt
                  </button>
                )}
              </div>
            )}

            {loading && visibleSales.length === 0 && (
              <div className="flex items-center justify-center gap-2 p-10 text-[13px] text-zinc-500">
                <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                Loading receipts…
              </div>
            )}

            {visibleSales.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-zinc-100 bg-zinc-50 px-4 py-3 lg:px-5">
                <span className="text-[13px] font-semibold leading-5 text-zinc-700 tabular-nums">
                  {visibleSales.length} {visibleSales.length === 1 ? 'receipt' : 'receipts'}
                </span>
                <span className="flex items-baseline gap-4 text-[13px] leading-5 text-zinc-600 tabular-nums">
                  <span>
                    Gross <span className="font-semibold text-zinc-800">{money(visibleTotals.grossRevenue)}</span>
                  </span>
                  <span>
                    Refunds{' '}
                    <span className="font-semibold text-rose-700">{negative(visibleTotals.refundedTotal)}</span>
                  </span>
                  <span>
                    Net <span className="text-base font-bold text-zinc-950">{money(visibleTotals.netRevenue)}</span>
                  </span>
                </span>
              </div>
            )}
          </CardShell>

          {/* Refunds and voids */}
          <CardShell className="flex min-w-0 flex-col overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-4 py-3 lg:px-5">
              <div className="flex items-center gap-2.5">
                <span className="text-[15px] font-semibold leading-6 text-zinc-950">Refunds and voids</span>
                <Pill className="bg-zinc-100 text-zinc-700 tabular-nums">
                  {figuresPending ? '—' : rangedRefunds.length}
                </Pill>
              </div>
              <span className="text-[13px] leading-5 text-zinc-500">
                {figuresPending
                  ? ''
                  : rangedRefunds.some((r) => r.kind === 'VOID')
                    ? `${rangedRefunds.filter((r) => r.kind === 'VOID').length} voided`
                    : 'No voids in this range'}
              </span>
            </div>
            {rangedRefunds.length === 0 ? (
              <p className="px-4 py-5 text-[13px] leading-5 text-zinc-500 lg:px-5">
                {figuresPending ? 'Figures unavailable.' : 'Nothing was refunded or voided in this range.'}
              </p>
            ) : (
              <div className="divide-y divide-zinc-100">
                {rangedRefunds.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-start justify-between gap-3 px-4 py-3 lg:grid lg:grid-cols-[minmax(0,1fr)_130px_minmax(0,1fr)_110px_150px] lg:items-center lg:gap-3 lg:px-5"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-sm font-semibold leading-5 text-zinc-950 tabular-nums">
                        {r.kind === 'VOID' ? 'Void' : 'Refund'} · {timeOf(r.created_at)}
                      </span>
                      <span className="truncate text-xs leading-4 text-zinc-500">
                        on <span className="font-mono text-zinc-600">{r.receipt_number || `sale ${r.sale_id}`}</span>
                      </span>
                    </div>
                    <span className="hidden truncate text-sm leading-5 text-zinc-800 lg:block">
                      {r.processed_by_name || <span className="text-zinc-500">&mdash;</span>}
                    </span>
                    <span className="hidden truncate text-[13px] leading-5 text-zinc-700 lg:block">
                      {r.reason || <span className="text-zinc-500">No reason recorded</span>}
                    </span>
                    <div className="flex shrink-0 flex-col items-end gap-1 lg:contents">
                      <span className="text-[15px] font-semibold leading-5 text-rose-700 tabular-nums lg:text-right">
                        {negative(Number(r.refund))}
                      </span>
                      <span className="flex lg:justify-start">
                        <Pill
                          className={
                            r.kind === 'VOID' ? 'bg-rose-50 text-rose-700' : 'bg-zinc-100 text-zinc-700'
                          }
                        >
                          {r.kind === 'VOID'
                            ? 'Voided'
                            : `${TENDER_LABEL[r.refund_method] || r.refund_method} refund`}
                        </Pill>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardShell>
        </div>

        {wideLayout && (
          // Sticks below the admin impersonation banner when one is on screen.
          <div className="sticky top-[calc(var(--admin-banner,0px)_+_1.5rem)]">
            <ReceiptDetail
              sale={selectedSale}
              loading={detailLoading}
              refunds={refunds}
              onReprint={() => setReceiptOpen(true)}
            />
          </div>
        )}
      </div>

      <ReceiptModal isOpen={receiptOpen} onClose={() => setReceiptOpen(false)} sale={selectedSale} />
    </div>
  );
};
