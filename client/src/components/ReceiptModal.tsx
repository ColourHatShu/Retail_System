import React, { useEffect, useRef } from 'react';
import JsBarcode from 'jsbarcode';
import confetti from 'canvas-confetti';
import { Printer, CheckCircle2, X } from 'lucide-react';
import { Sale } from '../types';

interface ReceiptModalProps {
  sale: Sale | null;
  isOpen: boolean;
  onClose: () => void;
}

export const ReceiptModal: React.FC<ReceiptModalProps> = ({ sale, isOpen, onClose }) => {
  const barcodeRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (isOpen && sale) {
      // Gentle celebratory confetti for successful checkout
      try {
        confetti({
          particleCount: 40,
          spread: 50,
          origin: { y: 0.7 },
          colors: ['#10b981', '#6366f1', '#f59e0b'],
        });
      } catch {}

      // Render barcode on receipt
      if (barcodeRef.current && sale.receipt_number) {
        try {
          JsBarcode(barcodeRef.current, sale.receipt_number, {
            format: 'CODE128',
            lineColor: '#18181b',
            width: 1.5,
            height: 40,
            displayValue: true,
            fontSize: 12,
            margin: 5,
          });
        } catch (e) {
          console.warn('Receipt barcode render failed', e);
        }
      }
    }
  }, [isOpen, sale]);

  if (!isOpen || !sale) return null;

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-950/60 backdrop-blur-sm">
      <div className="relative w-full max-w-sm bg-white rounded-2xl shadow-2xl border border-zinc-200 overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header bar (no print) */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-100 no-print">
          <div className="flex items-center gap-2 text-emerald-600">
            <CheckCircle2 className="w-5 h-5" />
            <span className="text-sm font-semibold text-zinc-900">Payment Successful</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-zinc-400 hover:text-zinc-700 rounded-lg hover:bg-zinc-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Printable Thermal Receipt Container */}
        <div className="p-6 overflow-y-auto font-mono text-xs text-zinc-800 space-y-4">
          {/* Store info */}
          <div className="text-center space-y-1">
            <h2 className="text-sm font-bold tracking-tight text-zinc-950 uppercase font-sans">
              Minimal Retail System
            </h2>
            <p className="text-[11px] text-zinc-500 font-sans">POS & Live Inventory Terminal</p>
            <p className="text-[10px] text-zinc-400 font-sans">100 Market St • Store #01</p>
          </div>

          <div className="border-t border-dashed border-zinc-300 pt-2 space-y-1">
            <div className="flex justify-between text-[11px]">
              <span className="text-zinc-500">Receipt:</span>
              <span className="font-semibold">{sale.receipt_number}</span>
            </div>
            <div className="flex justify-between text-[11px]">
              <span className="text-zinc-500">Date:</span>
              <span>{new Date(sale.created_at).toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-[11px]">
              <span className="text-zinc-500">Customer:</span>
              <span>{sale.customer_name || 'Walk-in'}</span>
            </div>
          </div>

          {/* Line items */}
          <div className="border-t border-dashed border-zinc-300 pt-2">
            <div className="flex justify-between font-semibold pb-1 border-b border-zinc-200 text-[11px]">
              <span>ITEM</span>
              <span>QTY x PRICE</span>
              <span className="text-right">TOTAL</span>
            </div>
            <div className="divide-y divide-zinc-100 pt-1">
              {sale.items?.map((itm, idx) => (
                <div key={idx} className="py-1.5 flex flex-col">
                  <span className="font-medium text-zinc-900 truncate">{itm.name}</span>
                  <div className="flex justify-between text-zinc-500 text-[11px]">
                    <span>
                      {itm.quantity} {itm.unit || 'pcs'} @ ${Number(itm.unit_price).toFixed(2)}
                    </span>
                    <span className="font-semibold text-zinc-800">
                      ${Number(itm.total_price).toFixed(2)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Totals */}
          <div className="border-t border-dashed border-zinc-300 pt-2 space-y-1 text-[11px]">
            <div className="flex justify-between">
              <span className="text-zinc-500">Subtotal</span>
              <span>${Number(sale.subtotal).toFixed(2)}</span>
            </div>
            {sale.discount > 0 && (
              <div className="flex justify-between text-rose-600">
                <span>Discount</span>
                <span>-${Number(sale.discount).toFixed(2)}</span>
              </div>
            )}
            {sale.tax_amount > 0 && (
              <div className="flex justify-between text-zinc-500">
                <span>Tax ({sale.tax_rate}%)</span>
                <span>${Number(sale.tax_amount).toFixed(2)}</span>
              </div>
            )}
            <div className="flex justify-between font-bold text-sm text-zinc-950 pt-1 border-t border-zinc-200">
              <span>TOTAL</span>
              <span>${Number(sale.total).toFixed(2)}</span>
            </div>
          </div>

          {/* Payment method & change */}
          <div className="border-t border-dashed border-zinc-300 pt-2 space-y-1 text-[11px]">
            <div className="flex justify-between">
              <span className="text-zinc-500">Payment Method:</span>
              <span className="font-semibold uppercase">{sale.payment_method}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Amount Tendered:</span>
              <span>${Number(sale.amount_paid).toFixed(2)}</span>
            </div>
            <div className="flex justify-between font-semibold text-emerald-700">
              <span>Change Due:</span>
              <span>${Number(sale.change_due).toFixed(2)}</span>
            </div>
          </div>

          {/* Barcode on receipt */}
          <div className="pt-2 flex flex-col items-center justify-center text-center">
            <svg ref={barcodeRef} className="max-w-full" />
            <p className="text-[10px] text-zinc-400 mt-1 font-sans">
              Thank you for your business!
            </p>
            <p className="text-[9px] text-zinc-400 font-sans">
              Stock automatically updated in inventory ledger.
            </p>
          </div>
        </div>

        {/* Footer Actions (no print) */}
        <div className="p-4 bg-zinc-50 border-t border-zinc-100 flex gap-3 no-print">
          <button
            onClick={handlePrint}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-semibold rounded-xl shadow-sm transition-colors"
          >
            <Printer className="w-4 h-4" />
            Print Receipt
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2.5 bg-white hover:bg-zinc-100 text-zinc-700 text-xs font-semibold rounded-xl border border-zinc-300 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
