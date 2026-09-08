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
} from 'lucide-react';
import { Department, MovementType, StockMovement, Sale } from '../types';
import { api } from '../utils/api';
import { ReceiptModal } from '../components/ReceiptModal';

interface MovementHistoryPageProps {
  departments: Department[];
}

export const MovementHistoryPage: React.FC<MovementHistoryPageProps> = ({
  departments,
}) => {
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [summary, setSummary] = useState<{
    total_movements: number;
    total_sold_units: number;
    total_restocked_units: number;
    total_adjusted_units: number;
  } | null>(null);

  const [selectedDept, setSelectedDept] = useState<string>('ALL');
  const [selectedType, setSelectedType] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [loading, setLoading] = useState(true);

  // Receipt Modal State
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);

  const loadData = async () => {
    try {
      setLoading(true);
      const [movData, summaryData] = await Promise.all([
        api.getMovements({
          department_id: selectedDept === 'ALL' ? undefined : selectedDept,
          type: selectedType === 'ALL' ? undefined : selectedType,
          search: searchQuery.trim() || undefined,
          limit: 150,
        }),
        api.getMovementSummary(),
      ]);
      setMovements(movData);
      setSummary(summaryData);
    } catch (err) {
      console.error('Failed to load movement history:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [selectedDept, selectedType]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    loadData();
  };

  const handleExportCSV = () => {
    window.open('/api/movements/export-csv', '_blank');
  };

  const handleOpenReceipt = async (receiptNo: string, saleId?: number) => {
    try {
      const sales = await api.getSales(100, 0);
      const found = sales.find((s) => s.receipt_number === receiptNo || (saleId && s.id === saleId));
      if (found) {
        setSelectedSale(found);
        setReceiptOpen(true);
      } else {
        alert(`Receipt details for ${receiptNo} could not be loaded.`);
      }
    } catch (err) {
      console.error('Receipt lookup failed:', err);
    }
  };

  const getTypeBadge = (type: MovementType) => {
    switch (type) {
      case 'SALE':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200">
            <ArrowDownLeft className="w-3 h-3" />
            POS Sale
          </span>
        );
      case 'RESTOCK':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
            <ArrowUpRight className="w-3 h-3" />
            Restock In
          </span>
        );
      case 'ADJUSTMENT_ADD':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-teal-50 text-teal-700 border border-teal-200">
            <TrendingUp className="w-3 h-3" />
            Adjust (+)
          </span>
        );
      case 'ADJUSTMENT_REMOVE':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">
            <TrendingDown className="w-3 h-3" />
            Deduct (-)
          </span>
        );
      case 'INITIAL':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
            <Layers className="w-3 h-3" />
            Initial Setup
          </span>
        );
      case 'RETURN':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">
            <RotateCcw className="w-3 h-3" />
            Return
          </span>
        );
      default:
        return (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-zinc-100 text-zinc-700">
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

      {/* Summary KPI Cards */}
      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
          <div className="p-3.5 sm:p-4 bg-white rounded-2xl border border-zinc-200/80 shadow-xs">
            <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
              Total Recorded Events
            </span>
            <div className="text-xl font-bold text-zinc-950 mt-1 font-mono">
              {summary.total_movements.toLocaleString()}
            </div>
            <span className="text-[11px] text-zinc-400 mt-0.5 block">Audit log count</span>
          </div>

          <div className="p-3.5 sm:p-4 bg-white rounded-2xl border border-zinc-200/80 shadow-xs">
            <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
              Units Sold (POS)
            </span>
            <div className="text-xl font-bold text-rose-600 mt-1 font-mono">
              -{summary.total_sold_units.toLocaleString()}
            </div>
            <span className="text-[11px] text-zinc-400 mt-0.5 block">Customer deductions</span>
          </div>

          <div className="p-3.5 sm:p-4 bg-white rounded-2xl border border-zinc-200/80 shadow-xs">
            <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
              Total Restocked
            </span>
            <div className="text-xl font-bold text-emerald-600 mt-1 font-mono">
              +{summary.total_restocked_units.toLocaleString()}
            </div>
            <span className="text-[11px] text-zinc-400 mt-0.5 block">Received into inventory</span>
          </div>

          <div className="p-3.5 sm:p-4 bg-white rounded-2xl border border-zinc-200/80 shadow-xs">
            <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
              Total Adjustments
            </span>
            <div className="text-xl font-bold text-amber-600 mt-1 font-mono">
              {summary.total_adjusted_units.toLocaleString()}
            </div>
            <span className="text-[11px] text-zinc-400 mt-0.5 block">Damage & shrinkage write-offs</span>
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
          {/* Department Filter */}
          <select
            value={selectedDept}
            onChange={(e) => setSelectedDept(e.target.value)}
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
            className="px-3 py-2 text-xs bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 font-medium"
          >
            <option value="ALL">All Movement Types</option>
            <option value="SALE">POS Sales Only</option>
            <option value="RESTOCK">Restocks Only</option>
            <option value="ADJUSTMENT_REMOVE">Deductions / Damage</option>
            <option value="ADJUSTMENT_ADD">Increases / Adjustments</option>
            <option value="INITIAL">Initial Setups</option>
          </select>
        </div>
      </div>

      {/* Movement Ledger Table */}
      <div className="bg-white rounded-2xl border border-zinc-200/80 shadow-sm overflow-hidden w-full max-w-full min-w-0">
        <div className="overflow-x-auto w-full max-w-full">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="bg-zinc-50/90 text-zinc-500 font-semibold border-b border-zinc-200 uppercase tracking-wider text-[10px]">
              <tr>
                <th className="py-3 px-4">Date & Time</th>
                <th className="py-3 px-4">Product / Barcode</th>
                <th className="py-3 px-4">Department</th>
                <th className="py-3 px-4">Type</th>
                <th className="py-3 px-4 text-center">Qty Change</th>
                <th className="py-3 px-4 text-center">Stock Balance</th>
                <th className="py-3 px-4">Customer / Purchaser</th>
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
                    <td className="py-3 px-4 whitespace-nowrap text-zinc-500 font-mono text-[11px]">
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
                        <span className="font-mono text-[11px] text-zinc-400 flex items-center gap-1">
                          <Barcode className="w-3 h-3 text-zinc-400" />
                          {m.product_barcode}
                        </span>
                      </div>
                    </td>

                    {/* Department */}
                    <td className="py-3 px-4 whitespace-nowrap">
                      <span
                        className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-semibold"
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
                        className={`inline-block px-2.5 py-0.5 rounded font-mono font-bold text-xs ${
                          m.quantity_change > 0
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'bg-rose-50 text-rose-700'
                        }`}
                      >
                        {m.quantity_change > 0 ? `+${m.quantity_change}` : m.quantity_change} {m.product_unit || 'pcs'}
                      </span>
                    </td>

                    {/* Balance Before -> After */}
                    <td className="py-3 px-4 text-center whitespace-nowrap font-mono text-[11px] text-zinc-500">
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
                        <span className="text-[10px] font-mono text-zinc-400 bg-zinc-50 px-1.5 py-0.5 rounded">
                          {m.reference_id || '—'}
                        </span>
                      )}
                    </td>

                    {/* Reason */}
                    <td className="py-3 px-4 text-zinc-600">
                      <span>{m.reason || 'Inventory action'}</span>
                      {m.payment_method && (
                        <span className="ml-2 text-[9px] uppercase font-mono px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-500">
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
            <div className="p-12 text-center text-zinc-400">
              <History className="w-8 h-8 mx-auto mb-2 text-zinc-300" />
              <p className="text-sm font-semibold text-zinc-700">No stock movements found</p>
              <p className="text-xs text-zinc-400 mt-0.5">
                Every sale, restock, or adjustment will automatically appear here.
              </p>
            </div>
          )}
        </div>
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
