import React, { useState, useEffect } from 'react';
import {
  History,
  Search,
  Download,
  ArrowDownLeft,
  ArrowUpRight,
  TrendingDown,
  TrendingUp,
  RotateCcw,
  Barcode,
  Layers,
  Receipt,
  User,
  ExternalLink,
  AlertTriangle,
  ChevronDown,
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

  // Receipt Modal State
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);

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
      // Fetched by id or receipt number, so receipts older than the loaded page still open.
      const sale = saleId ? await api.getSale(saleId) : await api.getSaleByReceipt(receiptNo);
      setSelectedSale(sale);
      setReceiptOpen(true);
    } catch (err) {
      console.error('Receipt lookup failed:', err);
      alert(`Receipt details for ${receiptNo} could not be loaded.`);
    }
  };

  const getTypeBadge = (type: MovementType) => {
    switch (type) {
      case 'SALE':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-50 text-rose-700 border border-rose-200">
            <ArrowDownLeft className="w-3 h-3" />
            POS Sale
          </span>
        );
      case 'RESTOCK':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
            <ArrowUpRight className="w-3 h-3" />
            Restock In
          </span>
        );
      case 'ADJUSTMENT_ADD':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-teal-50 text-teal-700 border border-teal-200">
            <TrendingUp className="w-3 h-3" />
            Adjust (+)
          </span>
        );
      case 'ADJUSTMENT_REMOVE':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200">
            <TrendingDown className="w-3 h-3" />
            Deduct (-)
          </span>
        );
      case 'INITIAL':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200">
            <Layers className="w-3 h-3" />
            Initial Setup
          </span>
        );
      case 'RETURN':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">
            <RotateCcw className="w-3 h-3" />
            Return
          </span>
        );
      default:
        return (
          <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-zinc-100 text-zinc-700">
            {type}
          </span>
        );
    }
  };

  return (
    <div className="w-full max-w-full min-w-0 px-2.5 sm:px-6 py-3 sm:py-6 space-y-4 sm:space-y-6 pb-24 md:pb-8 overflow-x-hidden">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
        <div>
          <h2 className="text-lg sm:text-xl font-bold tracking-tight text-zinc-950 flex items-center gap-2">
            <History className="w-5 h-5 text-zinc-900" />
            Item Movement History Ledger
          </h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            Audit trail tracking every single inventory movement, customer purchase, and receipt record
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={loadData}
            className="p-2 text-zinc-600 hover:text-zinc-900 bg-white hover:bg-zinc-50 border border-zinc-200 rounded-xl transition-colors shadow-2xs"
            title="Refresh logs"
            aria-label="Refresh movement logs"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
          <button
            onClick={handleExportCSV}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-zinc-800 bg-white hover:bg-zinc-50 border border-zinc-200 rounded-xl shadow-xs transition-colors"
          >
            <Download className="w-4 h-4 text-zinc-600" />
            Export CSV Audit
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Summary KPI Cards — these describe the filtered slice, not the whole ledger */}
      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-2.5 sm:gap-3">
          <div className="p-3.5 sm:p-4 bg-white rounded-2xl border border-zinc-200/80 shadow-xs">
            <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
              Total Recorded Events
            </span>
            <div className="text-xl font-bold text-zinc-950 mt-1 tabular-nums">
              {summary.total_movements.toLocaleString()}
            </div>
            <span className="text-[11px] text-zinc-500 mt-0.5 block">Audit log count</span>
          </div>

          <div className="p-3.5 sm:p-4 bg-white rounded-2xl border border-zinc-200/80 shadow-xs">
            <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
              Units Sold (POS)
            </span>
            <div className="text-xl font-bold text-rose-600 mt-1 tabular-nums">
              -{summary.total_sold_units.toLocaleString()}
            </div>
            <span className="text-[11px] text-zinc-500 mt-0.5 block">Customer deductions</span>
          </div>

          <div className="p-3.5 sm:p-4 bg-white rounded-2xl border border-zinc-200/80 shadow-xs">
            <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
              Total Restocked
            </span>
            <div className="text-xl font-bold text-emerald-600 mt-1 tabular-nums">
              +{summary.total_restocked_units.toLocaleString()}
            </div>
            <span className="text-[11px] text-zinc-500 mt-0.5 block">Received into inventory</span>
          </div>

          <div className="p-3.5 sm:p-4 bg-white rounded-2xl border border-zinc-200/80 shadow-xs">
            <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
              Total Adjustments (+)
            </span>
            <div className="text-xl font-bold text-teal-600 mt-1 tabular-nums">
              +{summary.total_adjusted_added_units.toLocaleString()}
            </div>
            <span className="text-[11px] text-zinc-500 mt-0.5 block">Recounts & corrections upward</span>
          </div>

          <div className="p-3.5 sm:p-4 bg-white rounded-2xl border border-zinc-200/80 shadow-xs">
            <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
              Total Adjustments (-)
            </span>
            <div className="text-xl font-bold text-amber-600 mt-1 tabular-nums">
              -{summary.total_adjusted_removed_units.toLocaleString()}
            </div>
            <span className="text-[11px] text-zinc-500 mt-0.5 block">Damage & shrinkage write-offs</span>
          </div>

          <div className="p-3.5 sm:p-4 bg-white rounded-2xl border border-zinc-200/80 shadow-xs">
            <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
              Units Returned
            </span>
            <div className="text-xl font-bold text-indigo-600 mt-1 tabular-nums">
              +{summary.total_returned_units.toLocaleString()}
            </div>
            <span className="text-[11px] text-zinc-500 mt-0.5 block">Put back by customer returns</span>
          </div>
        </div>
      )}

      {/* Filter Strip */}
      <div className="bg-white p-4 rounded-2xl border border-zinc-200/80 shadow-sm flex flex-col sm:flex-row gap-3 items-center justify-between">
        {/* Search */}
        <form onSubmit={handleSearchSubmit} className="relative w-full sm:w-80">
          <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by product, customer, barcode, receipt..."
            className="w-full pl-9 pr-3 py-2 text-xs bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:bg-white"
          />
        </form>

        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          {/* Date Range — the rows, the cards and the export all use this window */}
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={startDate}
              max={endDate || undefined}
              onChange={(e) => setStartDate(e.target.value)}
              aria-label="Movements from date"
              title="From date"
              className="px-3 py-2 text-xs bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 font-medium text-zinc-700 tabular-nums"
            />
            <span className="text-[11px] text-zinc-500">to</span>
            <input
              type="date"
              value={endDate}
              min={startDate || undefined}
              onChange={(e) => setEndDate(e.target.value)}
              aria-label="Movements to date"
              title="To date"
              className="px-3 py-2 text-xs bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 font-medium text-zinc-700 tabular-nums"
            />
            {(startDate || endDate) && (
              <button
                type="button"
                onClick={() => {
                  setStartDate('');
                  setEndDate('');
                }}
                className="p-1.5 text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 rounded-lg transition-colors"
                title="Clear date range"
                aria-label="Clear date range"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Department Filter */}
          <select
            value={selectedDept}
            onChange={(e) => setSelectedDept(e.target.value)}
            aria-label="Filter by department"
            className="px-3 py-2 text-xs bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 font-medium"
          >
            <option value="ALL">All Departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>

          {/* Type Filter */}
          <select
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value)}
            aria-label="Filter by movement type"
            className="px-3 py-2 text-xs bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 font-medium"
          >
            <option value="ALL">All Movement Types</option>
            <option value="SALE">POS Sales Only</option>
            <option value="RESTOCK">Restocks Only</option>
            <option value="ADJUSTMENT_REMOVE">Deductions / Damage</option>
            <option value="ADJUSTMENT_ADD">Increases / Adjustments</option>
            <option value="RETURN">Customer Returns</option>
            <option value="INITIAL">Initial Setups</option>
          </select>
        </div>
      </div>

      {/* Movement Ledger Table */}
      <div className="bg-white rounded-2xl border border-zinc-200/80 shadow-sm overflow-hidden w-full max-w-full min-w-0">
        <div className="overflow-x-auto w-full max-w-full">
          <table className="w-full min-w-[860px] text-left text-xs">
            <thead className="bg-zinc-50/90 text-zinc-500 font-semibold border-b border-zinc-200 uppercase tracking-wider text-[11px]">
              <tr>
                <th className="py-3 px-4">Date & Time</th>
                <th className="py-3 px-4">Product / Barcode</th>
                <th className="py-3 px-4">Department</th>
                <th className="py-3 px-4">Type</th>
                <th className="py-3 px-4 text-center">Qty Change</th>
                <th className="py-3 px-4 text-center">Stock Balance</th>
                <th className="py-3 px-4">Customer / Purchaser</th>
                <th className="py-3 px-4">Staff</th>
                <th className="py-3 px-4">Receipt / Reference</th>
                <th className="py-3 px-4">Audit Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {movements.map((m) => {
                const isSale = m.type === 'SALE';
                const hasReceipt = m.reference_id && m.reference_id.startsWith('REC-');

                return (
                  <tr key={m.id} className="hover:bg-zinc-50/70 transition-colors">
                    {/* Timestamp */}
                    <td className="py-3 px-4 whitespace-nowrap text-zinc-500 tabular-nums text-[11px]">
                      {new Date(m.created_at).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>

                    {/* Product */}
                    <td className="py-3 px-4">
                      <div className="font-semibold text-zinc-900 text-xs">{m.product_name}</div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="font-mono text-[11px] text-zinc-500 flex items-center gap-1">
                          <Barcode className="w-3 h-3 text-zinc-400" />
                          {m.product_barcode}
                        </span>
                      </div>
                    </td>

                    {/* Department */}
                    <td className="py-3 px-4 whitespace-nowrap">
                      <span
                        className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold"
                        style={{
                          backgroundColor: `${m.department_color || '#4f46e5'}18`,
                          color: m.department_color || '#4f46e5',
                        }}
                      >
                        <span
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ backgroundColor: m.department_color || '#4f46e5' }}
                        />
                        {m.department_name}
                      </span>
                    </td>

                    {/* Movement Type */}
                    <td className="py-3 px-4 whitespace-nowrap">{getTypeBadge(m.type)}</td>

                    {/* Quantity Change */}
                    <td className="py-3 px-4 text-center whitespace-nowrap">
                      <span
                        className={`inline-block px-2.5 py-0.5 rounded tabular-nums font-bold text-xs ${
                          m.quantity_change > 0
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'bg-rose-50 text-rose-700'
                        }`}
                      >
                        {m.quantity_change > 0 ? `+${m.quantity_change}` : m.quantity_change} {m.product_unit || 'pcs'}
                      </span>
                    </td>

                    {/* Balance Before -> After */}
                    <td className="py-3 px-4 text-center whitespace-nowrap tabular-nums text-[11px] text-zinc-500">
                      <span>{m.quantity_before}</span>
                      <span className="text-zinc-300 mx-1">→</span>
                      <strong className="text-zinc-950 font-bold">{m.quantity_after}</strong>
                    </td>

                    {/* Customer / Purchaser */}
                    <td className="py-3 px-4 whitespace-nowrap">
                      {m.customer_name ? (
                        <div className="flex items-center gap-1.5 text-zinc-900 font-semibold">
                          <User className="w-3.5 h-3.5 text-zinc-400" />
                          <span>{m.customer_name}</span>
                        </div>
                      ) : (
                        <span className="text-zinc-300">—</span>
                      )}
                    </td>

                    {/* Staff member of record */}
                    <td className="py-3 px-4 whitespace-nowrap text-zinc-600">
                      {m.user_name || <span className="text-zinc-300">—</span>}
                    </td>

                    {/* Receipt / Reference */}
                    <td className="py-3 px-4 whitespace-nowrap">
                      {hasReceipt ? (
                        <button
                          type="button"
                          onClick={() => handleOpenReceipt(m.reference_id!, m.sale_id)}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-100 hover:bg-zinc-200 text-zinc-900 font-mono text-[11px] font-bold transition-colors group"
                          title="Click to view printable receipt"
                        >
                          <Receipt className="w-3 h-3 text-zinc-500 group-hover:text-zinc-900" />
                          <span>{m.reference_id}</span>
                          <ExternalLink className="w-2.5 h-2.5 opacity-60" />
                        </button>
                      ) : (
                        <span className="text-xs font-mono text-zinc-500 bg-zinc-50 px-1.5 py-0.5 rounded">
                          {m.reference_id || '—'}
                        </span>
                      )}
                    </td>

                    {/* Reason */}
                    <td className="py-3 px-4 text-zinc-600">
                      <span>{m.reason || 'Inventory action'}</span>
                      {m.payment_method && (
                        <span className="ml-2 text-[11px] uppercase px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-500">
                          {m.payment_method}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {movements.length === 0 && !loading && (
            <div className="p-12 text-center">
              <History className="w-8 h-8 mx-auto mb-2 text-zinc-300" />
              <p className="text-sm font-semibold text-zinc-700">
                {error ? 'The ledger could not be loaded' : 'No stock movements found'}
              </p>
              <p className="text-xs text-zinc-500 mt-0.5">
                {error
                  ? 'Nothing has been lost — check the connection and try again.'
                  : 'Every sale, restock, or adjustment will automatically appear here.'}
              </p>
              {error && (
                <button
                  type="button"
                  onClick={loadData}
                  className="mt-3 inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-zinc-800 bg-white hover:bg-zinc-50 border border-zinc-200 rounded-xl shadow-xs transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-zinc-500" />
                  Try again
                </button>
              )}
            </div>
          )}
        </div>

        {/* The table holds the pages fetched so far; the cards count the whole filtered slice. */}
        {summary && movements.length > 0 && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-2 px-4 py-3 border-t border-zinc-100 bg-zinc-50/60">
            <span className="text-[11px] text-zinc-500">
              Showing <strong className="text-zinc-700 tabular-nums">{movements.length.toLocaleString()}</strong> of{' '}
              <strong className="text-zinc-700 tabular-nums">{summary.total_movements.toLocaleString()}</strong>{' '}
              matching movements
            </span>
            {movements.length < summary.total_movements && (
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-zinc-800 bg-white hover:bg-zinc-50 border border-zinc-200 rounded-xl shadow-xs transition-colors disabled:opacity-60"
              >
                <ChevronDown className="w-4 h-4 text-zinc-500" />
                {loadingMore
                  ? 'Loading…'
                  : `Load ${Math.min(PAGE_SIZE, summary.total_movements - movements.length).toLocaleString()} more`}
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
