import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Calendar,
  ChevronDown,
  Download,
  History,
  Layers,
  Package,
  PackageX,
  Receipt,
  RefreshCw,
  Search,
  ShoppingCart,
  SlidersHorizontal,
  TrendingUp,
  Undo2,
  X,
} from 'lucide-react';
import { Department, MovementType, StockMovement, Sale } from '../types';
import { api, ApiError, MovementFilters, MovementSummary } from '../utils/api';
import { ReceiptModal } from '../components/ReceiptModal';

interface MovementHistoryPageProps {
  departments: Department[];
}

/** Rows per request. The ledger runs to thousands of entries, so it is paged. */
const PAGE_SIZE = 150;

type Tone = 'neutral' | 'good' | 'critical';

/**
 * A sale is the ordinary event in a shop, so it is neutral; only a write-off is
 * an alarm. Colours follow that, not the sign of the number.
 */
const TYPE_META: Record<MovementType, { label: string; Icon: React.ComponentType<{ className?: string }>; tone: Tone }> = {
  SALE: { label: 'Sale', Icon: ShoppingCart, tone: 'neutral' },
  RETURN: { label: 'Return', Icon: Undo2, tone: 'good' },
  RESTOCK: { label: 'Restock', Icon: Package, tone: 'good' },
  INITIAL: { label: 'Initial stock', Icon: Layers, tone: 'good' },
  ADJUSTMENT_ADD: { label: 'Added', Icon: TrendingUp, tone: 'good' },
  ADJUSTMENT_REMOVE: { label: 'Removed', Icon: PackageX, tone: 'critical' },
};

const PILL_TONE: Record<Tone, string> = {
  neutral: 'bg-zinc-100 text-zinc-700',
  good: 'bg-emerald-50 text-emerald-700',
  critical: 'bg-rose-50 text-rose-700',
};

const QTY_TONE: Record<Tone, string> = {
  neutral: 'text-zinc-950',
  good: 'text-emerald-700',
  critical: 'text-rose-700',
};

/** Short labels for the filter chips; the select options keep their longer wording. */
const TYPE_CHIP_LABEL: Record<string, string> = {
  ALL: 'All',
  SALE: 'Sales',
  RESTOCK: 'Restocks',
  ADJUSTMENT_REMOVE: 'Removed',
  ADJUSTMENT_ADD: 'Added',
  RETURN: 'Returns',
  INITIAL: 'Initial',
};

/** Local-calendar YYYY-MM-DD: the date inputs and the day grouping both work in shop-local days. */
const toDateInput = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** `new Date('2026-09-16')` parses as UTC and can slip a day west of Greenwich; build it from local parts. */
const parseDateInput = (value: string) => {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};

const DATE_PRESETS = [
  { id: 'TODAY', days: 0, short: 'Today', long: 'Today' },
  { id: '7', days: 6, short: '7d', long: '7 days' },
  { id: '30', days: 29, short: '30d', long: '30 days' },
] as const;

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

/** Checkout stamps 'Walk-in Customer' on every sale, so printing it would be noise, not information. */
const namedCustomer = (m: StockMovement) =>
  m.customer_name && m.customer_name !== 'Walk-in Customer' ? m.customer_name : null;

const signed = (n: number) => (n > 0 ? `+${n}` : `−${Math.abs(n)}`);

const hasReceiptRef = (m: StockMovement) => Boolean(m.reference_id && m.reference_id.startsWith('REC-'));

interface DayTally {
  count: number;
  sold: number;
  returned: number;
  restocked: number;
  added: number;
  removed: number;
  initial: number;
}

interface DayGroup {
  key: string;
  /** "Today" / "Yesterday" / "Thu" for older days. */
  title: string;
  /** The calendar date, always spelled out so the ledger is unambiguous. */
  date: string;
  rows: StockMovement[];
  tally: DayTally;
}

export const MovementHistoryPage: React.FC<MovementHistoryPageProps> = ({
  departments,
}) => {
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [summary, setSummary] = useState<MovementSummary | null>(null);

  const [selectedDept, setSelectedDept] = useState<string>('ALL');
  const [selectedType, setSelectedType] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Disclosure for the controls that do not fit a phone: the exact-date fields
  // and the type / department pickers.
  const [datesOpen, setDatesOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Receipt Modal State
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [receiptLoadingRef, setReceiptLoadingRef] = useState<string | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);

  /**
   * The rows, the summary cards and the CSV export all run on this one shape so
   * they always describe the same slice. `end_date` is stretched to the end of
   * the chosen day — a bare date lands at midnight and would drop that day.
   */
  const currentFilters = (): MovementFilters => ({
    department_id: selectedDept === 'ALL' ? undefined : selectedDept,
    type: selectedType === 'ALL' ? undefined : selectedType,
    search: searchQuery.trim() || undefined,
    start_date: startDate || undefined,
    end_date: endDate ? `${endDate}T23:59:59.999` : undefined,
  });

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const filters = currentFilters();
      const [movData, summaryData] = await Promise.all([
        api.getMovements({ ...filters, limit: PAGE_SIZE, offset: 0 }),
        api.getMovementSummary(filters),
      ]);
      setMovements(movData);
      setSummary(summaryData);
    } catch (err) {
      console.error('Failed to load movement history:', err);
      setMovements([]);
      setSummary(null);
      setError(err instanceof ApiError ? err.message : 'Could not load the movement ledger.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [selectedDept, selectedType, startDate, endDate]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    loadData();
  };

  /** Appends the next page. `summary.total_movements` is the unpaged count for the same filter. */
  const handleLoadMore = async () => {
    try {
      setLoadingMore(true);
      setError(null);
      const next = await api.getMovements({ ...currentFilters(), limit: PAGE_SIZE, offset: movements.length });
      setMovements((prev) => [...prev, ...next]);
    } catch (err) {
      console.error('Failed to load more movements:', err);
      setError(err instanceof ApiError ? err.message : 'Could not load more movements.');
    } finally {
      setLoadingMore(false);
    }
  };

  const handleExportCSV = () => {
    window.open(api.movementsExportUrl(currentFilters()), '_blank');
  };

  const handleOpenReceipt = async (receiptNo: string, saleId?: number) => {
    try {
      setReceiptError(null);
      setReceiptLoadingRef(receiptNo);
      // Fetched by id or receipt number, so receipts older than the loaded page still open.
      const sale = saleId ? await api.getSale(saleId) : await api.getSaleByReceipt(receiptNo);
      setSelectedSale(sale);
      setReceiptOpen(true);
    } catch (err) {
      console.error('Receipt lookup failed:', err);
      // Shown on the page rather than in a browser alert, which a cashier can dismiss
      // by accident and which says nothing about which receipt failed.
      setReceiptError(`Receipt ${receiptNo} could not be loaded. It may have been voided, or the connection dropped.`);
    } finally {
      setReceiptLoadingRef(null);
    }
  };

  /** Which date button reads as pressed. Derived, so the dates stay the single source of truth. */
  const activeRange = useMemo(() => {
    if (!startDate && !endDate) return 'ALL';
    if (endDate !== toDateInput(new Date())) return 'CUSTOM';
    const hit = DATE_PRESETS.find((p) => startDate === toDateInput(daysAgo(p.days)));
    return hit ? hit.id : 'CUSTOM';
  }, [startDate, endDate]);

  const applyPreset = (days: number) => {
    setStartDate(toDateInput(daysAgo(days)));
    setEndDate(toDateInput(new Date()));
    setDatesOpen(false);
  };

  const clearRange = () => {
    setStartDate('');
    setEndDate('');
    setDatesOpen(false);
  };

  /**
   * The ledger reads as a diary, so the rows are cut into days. Rows arrive
   * newest first, which means every group is complete except possibly the last
   * one while more pages are still unfetched.
   */
  const groups = useMemo<DayGroup[]>(() => {
    const todayKey = toDateInput(new Date());
    const yesterdayKey = toDateInput(daysAgo(1));
    const out: DayGroup[] = [];

    movements.forEach((m) => {
      const when = new Date(m.created_at);
      const key = toDateInput(when);
      let group = out[out.length - 1];
      if (!group || group.key !== key) {
        group = {
          key,
          title: key === todayKey ? 'Today' : key === yesterdayKey ? 'Yesterday' : when.toLocaleDateString([], { weekday: 'short' }),
          date: when.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }),
          rows: [],
          tally: { count: 0, sold: 0, returned: 0, restocked: 0, added: 0, removed: 0, initial: 0 },
        };
        out.push(group);
      }
      group.rows.push(m);
      group.tally.count += 1;
      const qty = m.quantity_change;
      if (m.type === 'SALE') group.tally.sold += -qty;
      else if (m.type === 'RETURN') group.tally.returned += qty;
      else if (m.type === 'RESTOCK') group.tally.restocked += qty;
      else if (m.type === 'ADJUSTMENT_ADD') group.tally.added += Math.abs(qty);
      else if (m.type === 'ADJUSTMENT_REMOVE') group.tally.removed += Math.abs(qty);
      else if (m.type === 'INITIAL') group.tally.initial += qty;
    });

    return out;
  }, [movements]);

  const totalMatching = summary?.total_movements ?? 0;
  const hasMore = Boolean(summary && movements.length < summary.total_movements);

  /** Says what the export will contain, because the server exports this filter unpaged. */
  const exportCount = summary ? summary.total_movements.toLocaleString() : null;
  const exportLabel = exportCount ? `Export these ${exportCount} rows` : 'Export CSV';

  const rangeLabel = useMemo(() => {
    if (!startDate && !endDate) return 'all time';
    const fmt = (v: string) => parseDateInput(v).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
    if (startDate && endDate) return startDate === endDate ? fmt(startDate) : `${fmt(startDate)} – ${fmt(endDate)}`;
    return startDate ? `from ${fmt(startDate)}` : `up to ${fmt(endDate)}`;
  }, [startDate, endDate]);

  const deptLabel = departments.find((d) => String(d.id) === selectedDept)?.name ?? 'All';

  const tallyText = (t: DayTally, partial: boolean) => {
    const parts: string[] = [];
    if (t.sold) parts.push(`${t.sold} sold`);
    if (t.returned) parts.push(`${t.returned} returned`);
    if (t.restocked) parts.push(`${t.restocked} restocked`);
    if (t.added) parts.push(`${t.added} added`);
    if (t.removed) parts.push(`${t.removed} removed`);
    if (t.initial) parts.push(`${t.initial} initial stock`);
    const head = partial
      ? `${t.count} shown so far`
      : `${t.count} ${t.count === 1 ? 'movement' : 'movements'}`;
    return [head, ...parts].join(' · ');
  };

  const typePill = (type: MovementType) => {
    const meta = TYPE_META[type];
    if (!meta) {
      return (
        <span className="inline-flex h-[22px] items-center rounded-full bg-zinc-100 px-2 text-xs font-semibold text-zinc-700">
          {type}
        </span>
      );
    }
    const { Icon } = meta;
    return (
      <span className={`inline-flex h-[22px] max-w-full items-center gap-1 rounded-full px-2 text-xs font-semibold ${PILL_TONE[meta.tone]}`}>
        <Icon className="h-3 w-3 shrink-0 stroke-[2.5]" />
        <span className="truncate">{meta.label}</span>
      </span>
    );
  };

  /** The reference line: a real receipt is a button, everything else is the audit reason. */
  const receiptButton = (m: StockMovement, extraClass: string) => (
    <button
      type="button"
      onClick={() => handleOpenReceipt(m.reference_id!, m.sale_id)}
      disabled={receiptLoadingRef === m.reference_id}
      aria-busy={receiptLoadingRef === m.reference_id}
      title="Open the printable receipt"
      className={`inline-flex h-10 min-w-0 items-center gap-2 rounded-xl px-2 text-zinc-900 transition-colors hover:bg-zinc-50 disabled:opacity-60 ${extraClass}`}
    >
      {receiptLoadingRef === m.reference_id ? (
        <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-zinc-500" />
      ) : (
        <Receipt className="h-4 w-4 shrink-0 text-zinc-600" />
      )}
      <span className="truncate font-mono text-[13px] font-semibold">{m.reference_id}</span>
    </button>
  );

  const paymentLine = (m: StockMovement) => {
    const bits: string[] = [];
    if (m.payment_method) {
      const method = m.payment_method.charAt(0).toUpperCase() + m.payment_method.slice(1).toLowerCase();
      bits.push(m.type === 'RETURN' ? `${method} refund` : method);
    }
    const customer = namedCustomer(m);
    if (customer) bits.push(customer);
    return bits.join(' · ');
  };

  /** lg and up: the column anatomy. Department and Stock only earn their own column on a wide desktop. */
  const LEDGER_GRID =
    'grid-cols-[52px_minmax(0,1fr)_112px_92px_minmax(150px,210px)_100px] gap-3 ' +
    '2xl:grid-cols-[88px_minmax(0,1fr)_140px_140px_88px_120px_260px_170px] 2xl:gap-4';

  const desktopRow = (m: StockMovement) => {
    const meta = TYPE_META[m.type];
    const tone: Tone = meta?.tone ?? 'neutral';
    const payment = paymentLine(m);

    return (
      <div
        key={m.id}
        className={`hidden min-h-[60px] items-center border-b border-zinc-100 px-4 py-2 transition-colors last:border-b-0 hover:bg-zinc-50/70 lg:grid 2xl:px-5 ${LEDGER_GRID}`}
      >
        {/* Time — the day is on the group header above */}
        <span className="text-sm font-medium tabular-nums text-zinc-800">
          {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>

        {/* Product */}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-semibold text-zinc-950">{m.product_name}</span>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-500">
            <span
              className="h-2 w-2 shrink-0 rounded-full 2xl:hidden"
              style={{ backgroundColor: m.department_color || '#71717a' }}
            />
            <span className="truncate 2xl:hidden">{m.department_name}</span>
            {m.product_sku && <span className="2xl:hidden">·</span>}
            {m.product_sku && <span className="truncate font-mono">{m.product_sku}</span>}
            {m.product_sku && m.product_barcode && <span className="hidden 2xl:inline">·</span>}
            {m.product_barcode && <span className="hidden truncate font-mono 2xl:inline">{m.product_barcode}</span>}
          </div>
        </div>

        {/* Department — its own column only where there is room for it */}
        <div className="hidden min-w-0 items-center gap-2 text-[13px] text-zinc-600 2xl:flex">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: m.department_color || '#71717a' }}
          />
          <span className="truncate">{m.department_name}</span>
        </div>

        {/* Movement type */}
        <div className="flex min-w-0">{typePill(m.type)}</div>

        {/* Quantity change, with the balance tucked under it until Stock gets its own column */}
        <div className="flex flex-col items-end gap-0.5">
          <span className={`text-[15px] font-bold tabular-nums ${QTY_TONE[tone]}`}>{signed(m.quantity_change)}</span>
          <span className="text-xs tabular-nums text-zinc-500 2xl:hidden">
            {m.quantity_before} → <span className="font-semibold text-zinc-800">{m.quantity_after}</span>
          </span>
        </div>

        {/* Stock before → after */}
        <div className="hidden items-center justify-end gap-1.5 text-sm tabular-nums 2xl:flex">
          <span className="text-zinc-500">{m.quantity_before}</span>
          <ArrowRight className="h-3.5 w-3.5 text-zinc-400" />
          <span className="font-semibold text-zinc-950">{m.quantity_after}</span>
        </div>

        {/* Receipt or reason */}
        <div className="flex min-w-0 flex-col gap-0.5">
          {hasReceiptRef(m) ? (
            <>
              {receiptButton(m, '-ml-2 2xl:ml-0 2xl:border 2xl:border-zinc-200 2xl:bg-white 2xl:px-3')}
              {payment && <span className="truncate text-xs text-zinc-500 2xl:pl-1">{payment}</span>}
            </>
          ) : (
            <>
              <span className="truncate text-sm font-medium text-zinc-800">{m.reason || 'Inventory action'}</span>
              {m.reference_id && <span className="truncate font-mono text-xs text-zinc-500">{m.reference_id}</span>}
            </>
          )}
        </div>

        {/* Staff of record */}
        <div className="flex min-w-0 items-center gap-2.5">
          {m.user_name && (
            <span className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[11px] font-bold text-zinc-700 2xl:flex">
              {initials(m.user_name)}
            </span>
          )}
          <span className="truncate text-[13px] font-medium text-zinc-800 2xl:text-sm">
            {m.user_name || <span className="text-zinc-500">—</span>}
          </span>
        </div>
      </div>
    );
  };

  const phoneRow = (m: StockMovement) => {
    const meta = TYPE_META[m.type];
    const tone: Tone = meta?.tone ?? 'neutral';
    const payment = paymentLine(m);

    return (
      <div key={m.id} className="flex flex-col gap-1.5 border-b border-zinc-100 px-4 py-3 last:border-b-0 lg:hidden">
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-zinc-950">{m.product_name}</span>
          <span className={`shrink-0 text-[15px] font-bold tabular-nums ${QTY_TONE[tone]}`}>
            {signed(m.quantity_change)}
          </span>
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {typePill(m.type)}
            <span className="truncate text-xs tabular-nums text-zinc-500">
              {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              {m.user_name ? ` · ${m.user_name}` : ''}
            </span>
          </div>
          <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-zinc-500">
            {m.quantity_before} → <span className="font-semibold text-zinc-800">{m.quantity_after}</span>
          </span>
        </div>

        {hasReceiptRef(m) ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2">
            {receiptButton(m, '-ml-2 border border-zinc-200 bg-white px-3')}
            {payment && <span className="truncate text-xs text-zinc-500">{payment}</span>}
          </div>
        ) : (
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <span className="text-xs font-medium text-zinc-800">{m.reason || 'Inventory action'}</span>
            {m.reference_id && <span className="font-mono text-xs text-zinc-500">· {m.reference_id}</span>}
          </div>
        )}
      </div>
    );
  };

  const skeletonRows = (
    <div className="animate-pulse" aria-hidden="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 border-b border-zinc-100 px-4 py-4 last:border-b-0 2xl:px-5">
          <div className="h-3 w-12 shrink-0 rounded bg-zinc-100" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="h-3 w-1/2 rounded bg-zinc-100" />
            <div className="h-2.5 w-1/3 rounded bg-zinc-100" />
          </div>
          <div className="hidden h-[22px] w-20 shrink-0 rounded-full bg-zinc-100 sm:block" />
          <div className="h-3 w-10 shrink-0 rounded bg-zinc-100" />
        </div>
      ))}
    </div>
  );

  return (
    <div className="w-full min-w-0 max-w-full space-y-3 overflow-x-hidden p-4 md:space-y-4 md:p-5 2xl:p-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-3 md:items-center">
        <div className="flex min-w-0 flex-col">
          <h2 className="text-xl font-bold tracking-tight text-zinc-950 md:text-[22px] md:leading-7">
            Movement History
          </h2>
          <p className="hidden text-[13px] leading-5 text-zinc-500 md:block">
            Every stock change, with its receipt or reason and the person who made it.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={loadData}
            disabled={loading}
            className="flex h-11 w-11 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-700 shadow-xs transition-colors hover:bg-zinc-50 disabled:opacity-60 md:h-10 md:w-10"
            title="Refresh the ledger"
            aria-label="Refresh the ledger"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={handleExportCSV}
            aria-label={exportCount ? `Export ${exportCount} matching rows as CSV` : 'Export the filtered ledger as CSV'}
            className="flex h-11 w-11 items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white text-[13px] font-semibold text-zinc-900 shadow-xs transition-colors hover:bg-zinc-50 md:h-10 md:w-auto md:px-4"
          >
            <Download className="h-4 w-4 text-zinc-600" />
            <span className="hidden md:inline">{exportLabel}</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {receiptError && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span className="flex-1">{receiptError}</span>
          <button
            type="button"
            onClick={() => setReceiptError(null)}
            aria-label="Dismiss the receipt message"
            className="-m-1 rounded-lg p-1 text-rose-700 transition-colors hover:bg-rose-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Figures for the filtered slice — never for the whole ledger */}
      {summary && (
        <div className="grid grid-cols-5 rounded-2xl border border-zinc-200/80 bg-white shadow-xs md:gap-3 md:rounded-none md:border-0 md:bg-transparent md:shadow-none">
          {[
            { short: 'Sold', long: 'Units sold', value: summary.total_sold_units, note: 'Sold at the register' },
            { short: 'Returned', long: 'Returned', value: summary.total_returned_units, note: 'Back in stock' },
            { short: 'Restocked', long: 'Restocked', value: summary.total_restocked_units, note: 'Received in' },
            { short: 'Added', long: 'Adjusted (+)', value: summary.total_adjusted_added_units, note: 'Recounts upward' },
            { short: 'Removed', long: 'Removed', value: summary.total_adjusted_removed_units, note: 'Damage & write-offs' },
          ].map((card, i) => (
            <div
              key={card.short}
              className={`flex flex-col-reverse items-center gap-0.5 px-1 py-3 md:flex-col md:items-start md:gap-1 md:rounded-2xl md:border md:border-zinc-200/80 md:bg-white md:px-4 md:py-3 md:shadow-xs 2xl:px-5 2xl:py-4 ${
                i > 0 ? 'border-l border-zinc-100 md:border-l' : ''
              }`}
            >
              <span className="w-full truncate text-center text-xs text-zinc-500 md:text-left md:text-[11px] md:font-semibold md:uppercase md:tracking-[0.06em]">
                <span className="md:hidden">{card.short}</span>
                <span className="hidden md:inline">{card.long}</span>
              </span>
              <span className="text-[22px] font-extrabold leading-7 tabular-nums text-zinc-950 md:text-[28px] md:leading-8 md:tracking-[-0.02em]">
                {card.value.toLocaleString()}
              </span>
              <span className="hidden text-xs text-zinc-500 2xl:block">{card.note}</span>
            </div>
          ))}
        </div>
      )}

      {/* Filters — one row on a desktop, stacked and foldaway on a phone */}
      <div className="flex flex-col gap-3 rounded-2xl border border-zinc-200/80 bg-white p-3 shadow-xs md:flex-row md:flex-wrap md:items-center">
        <form onSubmit={handleSearchSubmit} className="relative w-full min-w-0 md:flex-1">
          <button
            type="submit"
            aria-label="Search the ledger"
            className="absolute left-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:text-zinc-900"
          >
            <Search className="h-4 w-4" />
          </button>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search receipt number, product or barcode"
            aria-label="Search receipt number, product or barcode"
            className="h-11 w-full rounded-xl border border-zinc-200 bg-white pl-11 pr-3 text-[15px] text-zinc-900 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-900 md:h-10 md:text-[13px]"
          />
        </form>

        <div className="flex w-full items-center gap-2 md:w-auto">
          <div
            role="group"
            aria-label="Date range"
            className="flex h-11 min-w-0 flex-1 items-stretch overflow-hidden rounded-xl border border-zinc-200 bg-white text-sm md:h-10 md:flex-none md:text-[13px]"
          >
            <button
              type="button"
              onClick={clearRange}
              aria-pressed={activeRange === 'ALL'}
              className={`flex min-w-0 flex-1 items-center justify-center px-3 transition-colors md:flex-none md:px-3.5 ${
                activeRange === 'ALL' ? 'bg-zinc-900 font-semibold text-white' : 'font-medium text-zinc-700 hover:bg-zinc-50'
              }`}
            >
              All
            </button>
            {DATE_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => applyPreset(p.days)}
                aria-pressed={activeRange === p.id}
                className={`flex min-w-0 flex-1 items-center justify-center px-3 transition-colors md:flex-none md:px-3.5 ${
                  activeRange === p.id ? 'bg-zinc-900 font-semibold text-white' : 'font-medium text-zinc-700 hover:bg-zinc-50'
                }`}
              >
                <span className="md:hidden">{p.short}</span>
                <span className="hidden md:inline">{p.long}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setDatesOpen((v) => !v)}
              aria-expanded={datesOpen}
              aria-label="Pick exact dates"
              className={`flex w-11 shrink-0 items-center justify-center border-l border-zinc-200 transition-colors md:w-auto md:gap-1.5 md:px-3.5 ${
                activeRange === 'CUSTOM' ? 'bg-zinc-900 font-semibold text-white' : 'font-medium text-zinc-700 hover:bg-zinc-50'
              }`}
            >
              <Calendar className="h-4 w-4" />
              <span className="hidden md:inline">Dates</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
            aria-controls="ledger-filters"
            aria-label="Filter by type and department"
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border transition-colors md:hidden ${
              filtersOpen || selectedType !== 'ALL' || selectedDept !== 'ALL'
                ? 'border-zinc-900 bg-zinc-900 text-white'
                : 'border-zinc-200 bg-white text-zinc-700'
            }`}
          >
            <SlidersHorizontal className="h-[18px] w-[18px]" />
          </button>
        </div>

        <div
          id="ledger-filters"
          className={`${filtersOpen ? 'flex' : 'hidden'} w-full flex-col gap-2 md:flex md:w-auto md:flex-row md:items-center`}
        >
          {/* A transparent native select keeps the platform picker; the chip is what you see. */}
          <label className="relative flex h-11 items-center gap-1.5 rounded-xl border border-zinc-200 bg-white pl-3.5 pr-9 text-sm focus-within:ring-2 focus-within:ring-zinc-900 md:h-10 md:text-[13px]">
            <span className="text-zinc-500" aria-hidden="true">Type</span>
            <span className="truncate font-semibold text-zinc-900" aria-hidden="true">
              {TYPE_CHIP_LABEL[selectedType] ?? selectedType}
            </span>
            <ChevronDown className="pointer-events-none absolute right-3 h-4 w-4 text-zinc-500" aria-hidden="true" />
            <select
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value)}
              aria-label="Filter by movement type"
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            >
              <option value="ALL">All Movement Types</option>
              <option value="SALE">POS Sales Only</option>
              <option value="RESTOCK">Restocks Only</option>
              <option value="ADJUSTMENT_REMOVE">Deductions / Damage</option>
              <option value="ADJUSTMENT_ADD">Increases / Adjustments</option>
              <option value="RETURN">Customer Returns</option>
              <option value="INITIAL">Initial Setups</option>
            </select>
          </label>

          <label className="relative flex h-11 items-center gap-1.5 rounded-xl border border-zinc-200 bg-white pl-3.5 pr-9 text-sm focus-within:ring-2 focus-within:ring-zinc-900 md:h-10 md:text-[13px]">
            <span className="text-zinc-500" aria-hidden="true">Department</span>
            <span className="truncate font-semibold text-zinc-900" aria-hidden="true">{deptLabel}</span>
            <ChevronDown className="pointer-events-none absolute right-3 h-4 w-4 text-zinc-500" aria-hidden="true" />
            <select
              value={selectedDept}
              onChange={(e) => setSelectedDept(e.target.value)}
              aria-label="Filter by department"
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            >
              <option value="ALL">All Departments</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Exact dates: the same two fields the ledger has always sent, kept behind the calendar button */}
        {datesOpen && (
          <div className="flex w-full animate-in fade-in slide-in-from-top-2 items-center gap-2 border-t border-zinc-100 pt-3 md:w-auto md:border-t-0 md:pt-0">
            <input
              type="date"
              value={startDate}
              max={endDate || undefined}
              onChange={(e) => setStartDate(e.target.value)}
              aria-label="Movements from date"
              title="From date"
              className="h-11 min-w-0 flex-1 rounded-xl border border-zinc-200 bg-white px-3 text-sm font-medium tabular-nums text-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-900 md:h-10 md:flex-none md:text-[13px]"
            />
            <span className="shrink-0 text-xs text-zinc-500">to</span>
            <input
              type="date"
              value={endDate}
              min={startDate || undefined}
              onChange={(e) => setEndDate(e.target.value)}
              aria-label="Movements to date"
              title="To date"
              className="h-11 min-w-0 flex-1 rounded-xl border border-zinc-200 bg-white px-3 text-sm font-medium tabular-nums text-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-900 md:h-10 md:flex-none md:text-[13px]"
            />
            {(startDate || endDate) && (
              <button
                type="button"
                onClick={clearRange}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 md:h-10 md:w-10"
                title="Clear date range"
                aria-label="Clear date range"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* The ledger */}
      <div className="w-full min-w-0 max-w-full overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-xs">
        <div
          className={`hidden h-11 items-center border-b border-zinc-200 bg-zinc-50 px-4 text-[11px] font-semibold uppercase tracking-[0.06em] text-zinc-500 lg:grid 2xl:px-5 ${LEDGER_GRID}`}
        >
          <span>Time</span>
          <span>Product</span>
          <span className="hidden 2xl:block">Department</span>
          <span>Type</span>
          <span className="text-right">Change</span>
          <span className="hidden text-right 2xl:block">Stock</span>
          <span>Receipt or reason</span>
          <span>Staff</span>
        </div>

        {loading && skeletonRows}

        {!loading &&
          groups.map((group, gi) => {
            const partial = hasMore && gi === groups.length - 1;
            return (
              <div key={group.key}>
                <div className="flex h-10 items-center justify-between gap-3 border-b border-zinc-100 bg-zinc-50 px-4 lg:h-9 2xl:px-5">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="text-[13px] font-bold text-zinc-900">{group.title}</span>
                    <span className="truncate text-[13px] text-zinc-500">{group.date}</span>
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-zinc-500">
                    <span className="lg:hidden">
                      {partial ? `${group.tally.count} shown so far` : `${group.tally.count} movements`}
                    </span>
                    <span className="hidden lg:inline">{tallyText(group.tally, partial)}</span>
                  </span>
                </div>
                {group.rows.map((m) => (
                  <React.Fragment key={m.id}>
                    {desktopRow(m)}
                    {phoneRow(m)}
                  </React.Fragment>
                ))}
              </div>
            );
          })}

        {movements.length === 0 && !loading && (
          <div className="p-12 text-center">
            <History className="mx-auto mb-2 h-8 w-8 text-zinc-300" />
            <p className="text-sm font-semibold text-zinc-700">
              {error ? 'The ledger could not be loaded' : 'No stock movements found'}
            </p>
            <p className="mt-0.5 text-xs text-zinc-500">
              {error
                ? 'Nothing has been lost — check the connection and try again.'
                : 'Every sale, restock, or adjustment will automatically appear here.'}
            </p>
            {error && (
              <button
                type="button"
                onClick={loadData}
                className="mt-3 inline-flex h-10 items-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-3.5 text-[13px] font-semibold text-zinc-900 shadow-xs transition-colors hover:bg-zinc-50"
              >
                <RefreshCw className="h-3.5 w-3.5 text-zinc-600" />
                Try again
              </button>
            )}
          </div>
        )}

        {/* The rows hold the pages fetched so far; the figure counts the whole filtered slice. */}
        {summary && movements.length > 0 && !loading && (
          <div className="flex flex-col items-start justify-between gap-2 border-t border-zinc-100 px-4 py-3 sm:flex-row sm:items-center 2xl:px-5">
            <span className="text-[13px] tabular-nums text-zinc-600">
              {hasMore
                ? `Showing ${movements.length.toLocaleString()} of ${totalMatching.toLocaleString()} movements`
                : `Showing all ${totalMatching.toLocaleString()} ${totalMatching === 1 ? 'movement' : 'movements'}`}
              <span className="text-zinc-500"> · {rangeLabel}</span>
            </span>
            {hasMore && (
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-3.5 text-[13px] font-semibold text-zinc-900 shadow-xs transition-colors hover:bg-zinc-50 disabled:opacity-60 sm:w-auto"
              >
                <ChevronDown className="h-4 w-4 text-zinc-600" />
                {loadingMore
                  ? 'Loading…'
                  : `Load ${Math.min(PAGE_SIZE, totalMatching - movements.length).toLocaleString()} more`}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Embedded Receipt Modal */}
      <ReceiptModal
        isOpen={receiptOpen}
        onClose={() => setReceiptOpen(false)}
        sale={selectedSale}
      />
    </div>
  );
};
