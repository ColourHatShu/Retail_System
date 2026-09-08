import React, { useEffect, useRef } from 'react';
import JsBarcode from 'jsbarcode';
import { X, Printer, Barcode as BarcodeIcon } from 'lucide-react';
import { Product } from '../types';

interface BarcodeLabelModalProps {
  isOpen: boolean;
  onClose: () => void;
  product: Product | null;
}

export const BarcodeLabelModal: React.FC<BarcodeLabelModalProps> = ({
  isOpen,
  onClose,
  product,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (isOpen && product && svgRef.current) {
      try {
        JsBarcode(svgRef.current, product.barcode, {
          format: 'CODE128',
          lineColor: '#09090b',
          width: 2,
          height: 60,
          displayValue: true,
          fontSize: 14,
          margin: 10,
        });
      } catch (e) {
        console.warn('Barcode generation failed', e);
      }
    }
  }, [isOpen, product]);

  if (!isOpen || !product) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-950/60 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-sm bg-white rounded-2xl shadow-2xl border border-zinc-200 overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-100 no-print">
          <div className="flex items-center gap-2 text-zinc-900 font-semibold text-sm">
            <BarcodeIcon className="w-4 h-4 text-zinc-700" />
            Product Shelf Label
          </div>
          <button
            onClick={onClose}
            className="p-1 text-zinc-400 hover:text-zinc-700 rounded-lg hover:bg-zinc-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Printable Label View */}
        <div className="p-6 flex flex-col items-center justify-center text-center space-y-2 bg-white">
          <div className="border border-zinc-900/40 rounded-xl p-4 w-full bg-white shadow-sm flex flex-col items-center">
            <span className="text-[10px] uppercase font-bold tracking-wider text-zinc-500">
              {product.department_name}
            </span>
            <h3 className="text-sm font-bold text-zinc-950 mt-0.5 line-clamp-2">
              {product.name}
            </h3>
            <div className="text-2xl font-black text-zinc-950 my-1 font-sans">
              ${Number(product.price).toFixed(2)}
            </div>
            {product.sku && (
              <span className="text-[10px] text-zinc-400 font-mono">
                SKU: {product.sku}
              </span>
            )}
            <div className="mt-2 w-full flex justify-center">
              <svg ref={svgRef} className="max-w-full" />
            </div>
          </div>
          <p className="text-[11px] text-zinc-400 no-print">
            Scan this with your phone camera or hardware scanner!
          </p>
        </div>

        {/* Footer */}
        <div className="p-4 bg-zinc-50 border-t border-zinc-100 flex gap-2 no-print">
          <button
            onClick={() => window.print()}
            className="flex-1 flex items-center justify-center gap-2 py-2 text-xs font-semibold text-white bg-zinc-900 hover:bg-zinc-800 rounded-xl shadow-sm"
          >
            <Printer className="w-4 h-4" />
            Print Label
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-zinc-600 hover:text-zinc-900 bg-white border border-zinc-200 rounded-xl hover:bg-zinc-50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
