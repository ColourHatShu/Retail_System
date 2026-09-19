import React, { useState, useEffect } from 'react';
import {
  BarChart3,
  Receipt,
  Printer,
  DollarSign,
  CreditCard,
  Banknote,
  QrCode,
  AlertCircle,
} from 'lucide-react';
import { Department, Sale } from '../types';
import { api } from '../utils/api';
import { ReceiptModal } from '../components/ReceiptModal';

interface AnalyticsPageProps {
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
  UPI_QR: 'UPI / QR',
  SPLIT: 'Split',
};

const TENDER_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  CASH: Banknote,
  CARD: CreditCard,
  UPI_QR: QrCode,
  SPLIT: DollarSign,
};

export const AnalyticsPage: React.FC<AnalyticsPageProps> = ({ departments }) => {
  const [sales, setSales] = useState<Sale[]>([]);
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  const [receiptOpen, setReceiptOpen] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSales = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getSales(50, 0);
      setSales(data);
    } catch (err) {
      // Without this the table falls through to the empty state and a dead API
      // reads to the cashier as "a day with no sales".
      setError(err instanceof Error ? err.message : 'Could not load sales.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSales();
  }, []);

  // A voided sale never happened and a refund hands the money back, so neither
  // belongs in revenue. The server sends status and refunded_total for exactly this.
  const activeSales = sales.filter((s) => s.status !== 'VOIDED');
  const netRevenue = activeSales.reduce(
    (acc, s) => acc + Number(s.total) - Number(s.refunded_total || 0),
    0,
  );
  const totalTax = activeSales.reduce((acc, s) => acc + Number(s.tax_amount || 0), 0);

  const tenderTotals = activeSales.reduce((acc, s) => {
    acc[s.payment_method] =
      (acc[s.payment_method] || 0) + Number(s.total) - Number(s.refunded_total || 0);
    return acc;
  }, {} as Record<string, number>);
  const tenderRows = Object.entries(tenderTotals).sort((a, b) => b[1] - a[1]);

  const handleReprint = async (saleId: number) => {
    try {
      // The list endpoint omits line items, so a receipt built from a list row
      // prints with no lines. Re-fetch the sale by id to get its items.
      const fullSale = await api.getSale(saleId);
      setSelectedSale(fullSale);
      setReceiptOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load that receipt.');
    }
  };

  return (
    <div className="w-full max-w-full min-w-0 px-2.5 sm:px-6 py-3 sm:py-6 space-y-4 sm:space-y-6 pb-24 md:pb-8 overflow-x-hidden">
      {/* Header */}
      <div>
        <h2 className="text-lg sm:text-xl font-bold tracking-tight text-zinc-950 flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-zinc-900" />
          Sales & Audit
        </h2>
        <p className="text-xs text-zinc-500 mt-0.5">
          Overview of transactions and departmental inventory worth
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800">
          <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
          <span>{error}</span>
        </div>
      )}

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
        <div className="p-3.5 sm:p-4 bg-white rounded-2xl border border-zinc-200/80 shadow-xs">
          <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
            Net Revenue
          </span>
          <div className="text-xl font-bold text-zinc-950 mt-1 tabular-nums">
            ${netRevenue.toFixed(2)}
          </div>
          <span className="text-[11px] text-zinc-500 mt-0.5 block">
            After refunds, voids excluded
          </span>
        </div>

        <div className="p-3.5 sm:p-4 bg-white rounded-2xl border border-zinc-200/80 shadow-xs">
          <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
            Total Transactions
          </span>
          <div className="text-xl font-bold text-zinc-950 mt-1 tabular-nums">
            {sales.length}
          </div>
          <span className="text-[11px] text-zinc-500 mt-0.5 block">
            Receipts listed, all statuses
          </span>
        </div>

        <div className="p-3.5 sm:p-4 bg-white rounded-2xl border border-zinc-200/80 shadow-xs">
          <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
            Collected Tax
          </span>
          <div className="text-xl font-bold text-zinc-950 mt-1 tabular-nums">
            ${totalTax.toFixed(2)}
          </div>
          <span className="text-[11px] text-zinc-500 mt-0.5 block">Voided sales excluded</span>
        </div>

        <div className="p-3.5 sm:p-4 bg-white rounded-2xl border border-zinc-200/80 shadow-xs">
          <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
            Average Ticket
          </span>
          <div className="text-xl font-bold text-emerald-600 mt-1 tabular-nums">
            ${activeSales.length > 0 ? (netRevenue / activeSales.length).toFixed(2) : '0.00'}
          </div>
          <span className="text-[11px] text-zinc-500 mt-0.5 block">Net per non-voided sale</span>
        </div>
      </div>

      {/* Tender Breakdown */}
      <div className="bg-white p-5 rounded-2xl border border-zinc-200/80 shadow-sm space-y-4">
        <h3 className="text-xs font-bold text-zinc-900 uppercase tracking-wider">
          Net Revenue by Tender
        </h3>
        {tenderRows.length === 0 ? (
          <p className="text-xs text-zinc-500">No tendered sales to break down yet.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {tenderRows.map(([method, amount]) => {
              const Icon = TENDER_ICON[method] || DollarSign;
              return (
                <div
                  key={method}
                  className="p-3.5 rounded-xl border border-zinc-100 bg-zinc-50/50 flex items-center gap-3"
                >
                  <span className="w-8 h-8 rounded-lg bg-white border border-zinc-200 flex items-center justify-center shrink-0">
                    <Icon className="w-4 h-4 text-zinc-700" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
                      {TENDER_LABEL[method] || method}
                    </div>
                    <div className="text-sm font-bold text-zinc-950 tabular-nums">
                      ${amount.toFixed(2)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Department Breakdown Section */}
      <div className="bg-white p-5 rounded-2xl border border-zinc-200/80 shadow-sm space-y-4">
        <h3 className="text-xs font-bold text-zinc-900 uppercase tracking-wider">
          Department Inventory Distribution
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {departments.map((dept) => (
            <div
              key={dept.id}
              className="p-3.5 rounded-xl border border-zinc-100 bg-zinc-50/50 hover:bg-zinc-50 transition-colors"
            >
              <div className="flex items-center justify-between mb-1.5">
                <span
                  className="inline-flex items-center gap-1.5 text-xs font-bold"
                  style={{ color: dept.color || '#4f46e5' }}
                >
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: dept.color || '#4f46e5' }}
                  />
                  {dept.name}
                </span>
                <span className="text-xs font-mono font-semibold bg-white px-1.5 py-0.5 rounded border border-zinc-200 text-zinc-600">
                  {dept.code}
                </span>
              </div>
              <div className="flex justify-between items-baseline text-xs text-zinc-600 mt-2">
                <span className="tabular-nums">{dept.product_count || 0} products</span>
                <span className="font-bold text-zinc-900 tabular-nums">
                  ${(dept.inventory_value || 0).toFixed(2)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Recent Sales Ledger */}
      <div className="bg-white rounded-2xl border border-zinc-200/80 shadow-sm overflow-hidden w-full max-w-full min-w-0">
        <div className="p-4 border-b border-zinc-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Receipt className="w-4 h-4 text-zinc-700" />
            <h3 className="text-xs font-bold text-zinc-900 uppercase tracking-wider">
              Recent Sales Receipts ({sales.length})
            </h3>
          </div>
        </div>

        <div className="overflow-x-auto w-full max-w-full">
          <table className="w-full min-w-[600px] text-left text-xs">
            <thead className="bg-zinc-50/80 text-zinc-500 font-semibold border-b border-zinc-200 uppercase tracking-wider text-[11px]">
              <tr>
                <th className="py-3.5 pl-4 pr-3">Receipt #</th>
                <th className="py-3.5 px-3">Date & Time</th>
                <th className="py-3.5 px-3">Cashier</th>
                <th className="py-3.5 px-3">Tender</th>
                <th className="py-3.5 px-3 text-right">Items</th>
                <th className="py-3.5 px-3 text-right">Total</th>
                <th className="py-3.5 pl-3 pr-4 text-right">Reprint</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {sales.map((s) => {
                const pill = STATUS_PILL[s.status || 'COMPLETED'] || STATUS_PILL.COMPLETED;
                const refunded = Number(s.refunded_total || 0);
                return (
                  <tr key={s.id} className="hover:bg-zinc-50/70 transition-colors">
                    <td className="py-3 pl-4 pr-3">
                      <div className="font-mono font-bold text-zinc-900">{s.receipt_number}</div>
                      <span
                        className={`inline-block mt-1 px-2 py-0.5 rounded-md text-xs font-semibold whitespace-nowrap ${pill.className}`}
                      >
                        {pill.label}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-zinc-500 tabular-nums text-[11px]">
                      {new Date(s.created_at).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="py-3 px-3 text-zinc-700">
                      {s.cashier_name || <span className="text-zinc-400">&mdash;</span>}
                    </td>
                    <td className="py-3 px-3">
                      <span className="px-2 py-0.5 bg-zinc-100 text-zinc-700 font-semibold text-xs rounded uppercase">
                        {s.payment_method}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-right tabular-nums text-zinc-600">
                      {(s as any).item_count || 1}
                    </td>
                    <td className="py-3 px-3 text-right">
                      <div
                        className={`font-bold tabular-nums ${
                          s.status === 'VOIDED' ? 'text-zinc-500 line-through' : 'text-zinc-950'
                        }`}
                      >
                        ${Number(s.total).toFixed(2)}
                      </div>
                      {refunded > 0 && (
                        <div className="text-xs font-semibold text-rose-700 tabular-nums">
                          -${refunded.toFixed(2)} refunded
                        </div>
                      )}
                    </td>
                    <td className="py-3 pl-3 pr-4 text-right">
                      <button
                        onClick={() => handleReprint(s.id)}
                        className="p-1.5 text-zinc-500 hover:text-zinc-900 rounded-lg hover:bg-zinc-100 transition-colors"
                        title="View & reprint receipt"
                        aria-label={`View and reprint receipt ${s.receipt_number}`}
                      >
                        <Printer className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {sales.length === 0 && !loading && !error && (
            <div className="p-12 text-center">
              <Receipt className="w-8 h-8 mx-auto mb-2 text-zinc-300" />
              <p className="text-sm font-semibold text-zinc-700">No sales transactions yet</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                Complete a sale in the POS Register tab to see sales receipts here.
              </p>
            </div>
          )}
        </div>
      </div>

      <ReceiptModal
        isOpen={receiptOpen}
        onClose={() => setReceiptOpen(false)}
        sale={selectedSale}
      />
    </div>
  );
};
