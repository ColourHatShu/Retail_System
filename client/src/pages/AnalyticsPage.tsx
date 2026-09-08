import React, { useState, useEffect } from 'react';
import {
  BarChart3,
  Receipt,
  Printer,
  DollarSign,
  TrendingUp,
  CreditCard,
  Banknote,
  QrCode,
  Calendar,
} from 'lucide-react';
import { Department, Sale } from '../types';
import { api } from '../utils/api';
import { ReceiptModal } from '../components/ReceiptModal';

interface AnalyticsPageProps {
  departments: Department[];
}

export const AnalyticsPage: React.FC<AnalyticsPageProps> = ({ departments }) => {
  const [sales, setSales] = useState<Sale[]>([]);
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  const [receiptOpen, setReceiptOpen] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);

  const loadSales = async () => {
    try {
      setLoading(true);
      const data = await api.getSales(50, 0);
      setSales(data);
    } catch (err) {
      console.error('Failed to load sales:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSales();
  }, []);

  const totalRevenue = sales.reduce((acc, s) => acc + Number(s.total), 0);
  const totalTax = sales.reduce((acc, s) => acc + Number(s.tax_amount || 0), 0);

  const paymentBreakdown = sales.reduce((acc, s) => {
    acc[s.payment_method] = (acc[s.payment_method] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const handleReprint = async (saleId: number) => {
    try {
      const fullSale = await api.getSales();
      const s = fullSale.find((item) => item.id === saleId);
      if (s) {
        setSelectedSale(s);
        setReceiptOpen(true);
      }
    } catch (err) {
      console.error('Reprint failed:', err);
    }
  };

  return (
    <div className="w-full px-3 sm:px-6 py-4 sm:py-6 space-y-4 sm:space-y-6 pb-24 md:pb-8">
      {/* Header */}
      <div>
        <h2 className="text-lg sm:text-xl font-bold tracking-tight text-zinc-950 flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-zinc-900" />
          Sales & Department Valuation
        </h2>
        <p className="text-xs text-zinc-500 mt-0.5">
          Overview of transactions and departmental inventory worth
        </p>
      </div>

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
        <div className="p-3.5 sm:p-4 bg-white rounded-2xl border border-zinc-200/80 shadow-xs">
          <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
            Total Revenue
          </span>
          <div className="text-xl font-bold text-zinc-950 mt-1">
            ${totalRevenue.toFixed(2)}
          </div>
          <span className="text-[11px] text-zinc-400 mt-0.5 block">Recorded POS sales</span>
        </div>

        <div className="p-3.5 sm:p-4 bg-white rounded-2xl border border-zinc-200/80 shadow-xs">
          <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
            Total Transactions
          </span>
          <div className="text-xl font-bold text-zinc-950 mt-1 font-mono">
            {sales.length}
          </div>
          <span className="text-[11px] text-zinc-400 mt-0.5 block">Completed receipts</span>
        </div>

        <div className="p-3.5 sm:p-4 bg-white rounded-2xl border border-zinc-200/80 shadow-xs">
          <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
            Collected Tax
          </span>
          <div className="text-xl font-bold text-zinc-950 mt-1 font-mono">
            ${totalTax.toFixed(2)}
          </div>
          <span className="text-[11px] text-zinc-400 mt-0.5 block">Estimated sales tax</span>
        </div>

        <div className="p-3.5 sm:p-4 bg-white rounded-2xl border border-zinc-200/80 shadow-xs">
          <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
            Average Ticket
          </span>
          <div className="text-xl font-bold text-emerald-600 mt-1 font-mono">
            ${sales.length > 0 ? (totalRevenue / sales.length).toFixed(2) : '0.00'}
          </div>
          <span className="text-[11px] text-zinc-400 mt-0.5 block">Per sale average</span>
        </div>
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
                <span className="text-[10px] font-mono font-semibold bg-white px-1.5 py-0.5 rounded border border-zinc-200 text-zinc-600">
                  {dept.code}
                </span>
              </div>
              <div className="flex justify-between items-baseline text-xs text-zinc-600 mt-2">
                <span>{dept.product_count || 0} products</span>
                <span className="font-bold text-zinc-900 font-mono">
                  ${(dept.inventory_value || 0).toFixed(2)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Recent Sales Ledger */}
      <div className="bg-white rounded-2xl border border-zinc-200/80 shadow-sm overflow-hidden">
        <div className="p-4 border-b border-zinc-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Receipt className="w-4 h-4 text-zinc-700" />
            <h3 className="text-xs font-bold text-zinc-900 uppercase tracking-wider">
              Recent Sales Receipts ({sales.length})
            </h3>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-left text-xs">
            <thead className="bg-zinc-50/80 text-zinc-500 font-semibold border-b border-zinc-200 uppercase tracking-wider text-[10px]">
              <tr>
                <th className="py-3.5 pl-4 pr-3">Receipt #</th>
                <th className="py-3.5 px-3">Date & Time</th>
                <th className="py-3.5 px-3">Customer</th>
                <th className="py-3.5 px-3">Tender</th>
                <th className="py-3.5 px-3 text-right">Items</th>
                <th className="py-3.5 px-3 text-right">Total</th>
                <th className="py-3.5 pl-3 pr-4 text-right">Reprint</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {sales.map((s) => (
                <tr key={s.id} className="hover:bg-zinc-50/70 transition-colors">
                  <td className="py-3 pl-4 pr-3 font-mono font-bold text-zinc-900">
                    {s.receipt_number}
                  </td>
                  <td className="py-3 px-3 text-zinc-500 font-mono text-[11px]">
                    {new Date(s.created_at).toLocaleString([], {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="py-3 px-3 text-zinc-700">
                    {s.customer_name || 'Walk-in'}
                  </td>
                  <td className="py-3 px-3">
                    <span className="px-2 py-0.5 bg-zinc-100 text-zinc-700 font-semibold text-[10px] rounded uppercase">
                      {s.payment_method}
                    </span>
                  </td>
                  <td className="py-3 px-3 text-right font-mono text-zinc-600">
                    {(s as any).item_count || 1}
                  </td>
                  <td className="py-3 px-3 text-right font-bold text-zinc-950 font-mono">
                    ${Number(s.total).toFixed(2)}
                  </td>
                  <td className="py-3 pl-3 pr-4 text-right">
                    <button
                      onClick={() => handleReprint(s.id)}
                      className="p-1.5 text-zinc-400 hover:text-zinc-900 rounded-lg hover:bg-zinc-100 transition-colors"
                      title="View & reprint receipt"
                    >
                      <Printer className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {sales.length === 0 && !loading && (
            <div className="p-12 text-center text-zinc-400">
              <Receipt className="w-8 h-8 mx-auto mb-2 text-zinc-300" />
              <p className="text-sm font-semibold text-zinc-700">No sales transactions yet</p>
              <p className="text-xs text-zinc-400 mt-0.5">
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
