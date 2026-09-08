import React, { useState, useEffect, useRef } from 'react';
import {
  ScanLine,
  PlusCircle,
  MinusCircle,
  CheckCircle2,
  AlertCircle,
  Camera,
  Keyboard,
  History,
  RotateCcw,
  Sparkles,
  Zap,
} from 'lucide-react';
import { Product, StockMovement } from '../types';
import { api } from '../utils/api';
import { playScanSuccessSound, playScanErrorSound } from '../utils/audio';
import { useHardwareBarcodeScanner } from '../utils/barcodeListener';
import { BarcodeScannerModal } from '../components/BarcodeScannerModal';

interface QuickScannerPageProps {
  products: Product[];
  refreshData: () => Promise<void>;
}

type ScanMode = 'IN' | 'OUT' | 'COUNT';

interface RecentScanLog {
  id: string;
  productName: string;
  barcode: string;
  departmentName: string;
  change: number;
  before: number;
  after: number;
  type: string;
  reason: string;
  timestamp: string;
}

export const QuickScannerPage: React.FC<QuickScannerPageProps> = ({
  products,
  refreshData,
}) => {
  const [mode, setMode] = useState<ScanMode>('IN');
  const [stepQuantity, setStepQuantity] = useState<number>(1);
  const [deductReason, setDeductReason] = useState<string>('Damaged / Broken');
  const [customReason, setCustomReason] = useState<string>('');
  const [manualBarcode, setManualBarcode] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    product?: Product;
    movement?: StockMovement;
    message: string;
  } | null>(null);
  const [scannerModalOpen, setScannerModalOpen] = useState(false);
  const [recentLogs, setRecentLogs] = useState<RecentScanLog[]>([]);

  const handleProcessScan = async (scannedBarcode: string) => {
    const code = scannedBarcode.trim();
    if (!code) return;

    setIsProcessing(true);
    setFeedback(null);

    try {
      if (mode === 'IN') {
        const result = await api.scanAdjustStock({
          barcode: code,
          change_quantity: stepQuantity,
          type: 'RESTOCK',
          reason: `Restock received (+${stepQuantity})`,
        });

        playScanSuccessSound();
        setFeedback({
          type: 'success',
          product: result.product,
          movement: result.movement,
          message: `Stock increased by +${stepQuantity}`,
        });

        setRecentLogs((prev) => [
          {
            id: Math.random().toString(),
            productName: result.product.name,
            barcode: code,
            departmentName: result.product.department_name || '',
            change: stepQuantity,
            before: result.movement.quantity_before,
            after: result.movement.quantity_after,
            type: 'RESTOCK',
            reason: `Restock (+${stepQuantity})`,
            timestamp: new Date().toLocaleTimeString(),
          },
          ...prev.slice(0, 19),
        ]);
      } else if (mode === 'OUT') {
        const finalReason = deductReason === 'Other' ? (customReason || 'Manual adjustment') : deductReason;
        const result = await api.scanAdjustStock({
          barcode: code,
          change_quantity: stepQuantity,
          type: 'ADJUSTMENT_REMOVE',
          reason: finalReason,
        });

        playScanSuccessSound();
        setFeedback({
          type: 'success',
          product: result.product,
          movement: result.movement,
          message: `Stock decreased by -${stepQuantity} (${finalReason})`,
        });

        setRecentLogs((prev) => [
          {
            id: Math.random().toString(),
            productName: result.product.name,
            barcode: code,
            departmentName: result.product.department_name || '',
            change: -stepQuantity,
            before: result.movement.quantity_before,
            after: result.movement.quantity_after,
            type: 'ADJUSTMENT_REMOVE',
            reason: finalReason,
            timestamp: new Date().toLocaleTimeString(),
          },
          ...prev.slice(0, 19),
        ]);
      }

      await refreshData();
    } catch (err: any) {
      playScanErrorSound();
      setFeedback({
        type: 'error',
        message: err.message || `Failed to process barcode "${code}"`,
      });
    } finally {
      setIsProcessing(false);
      setManualBarcode('');
    }
  };

  // Listen to hardware barcode scanner keystrokes
  useHardwareBarcodeScanner((barcode) => {
    handleProcessScan(barcode);
  });

  const onManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (manualBarcode.trim()) {
      handleProcessScan(manualBarcode);
    }
  };

  const handleOpenScanner = () => {
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setScannerModalOpen(true);
  };

  return (
    <div className="w-full max-w-5xl mx-auto px-2.5 sm:px-6 py-3 sm:py-6 space-y-4 sm:space-y-6 pb-24 md:pb-8 overflow-x-hidden min-w-0">
      {/* Header */}
      <div className="text-center space-y-1">
        <h2 className="text-lg sm:text-xl font-bold tracking-tight text-zinc-950 flex items-center justify-center gap-2">
          <ScanLine className="w-5 h-5 text-zinc-900" />
          Rapid Barcode Stock Adjuster
        </h2>
        <p className="text-xs text-zinc-500">
          Point camera or trigger scanner to increase or decrease inventory stock
        </p>
      </div>

      {/* Mode Switcher: Stock In (+) vs Stock Out (-) */}
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 max-w-md mx-auto">
        <button
          type="button"
          onClick={() => setMode('IN')}
          className={`p-3 sm:p-3.5 rounded-2xl border flex items-center justify-center gap-1.5 sm:gap-2 transition-all min-h-[48px] ${
            mode === 'IN'
              ? 'bg-emerald-600 text-white border-emerald-600 shadow-md font-bold'
              : 'bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50 font-semibold'
          }`}
        >
          <PlusCircle className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0" />
          <span className="text-xs sm:text-sm">Stock In (+)</span>
        </button>

        <button
          type="button"
          onClick={() => setMode('OUT')}
          className={`p-3.5 rounded-2xl border flex items-center justify-center gap-2 transition-all ${
            mode === 'OUT'
              ? 'bg-rose-600 text-white border-rose-600 shadow-md font-bold'
              : 'bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50 font-semibold'
          }`}
        >
          <MinusCircle className="w-5 h-5" />
          <span>Stock Out (-) [Deduct]</span>
        </button>
      </div>

      {/* Configuration Strip (Quantity per scan & Reason) */}
      <div className="bg-white p-4 rounded-2xl border border-zinc-200/80 shadow-sm space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          {/* Step Quantity Selector */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-zinc-700 uppercase tracking-wider">
              Quantity per Scan:
            </span>
            <div className="flex items-center gap-1">
              {[1, 2, 5, 10, 20].map((num) => (
                <button
                  key={num}
                  type="button"
                  onClick={() => setStepQuantity(num)}
                  className={`w-8 h-8 rounded-lg text-xs font-bold transition-all ${
                    stepQuantity === num
                      ? 'bg-zinc-900 text-white shadow-xs'
                      : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
                  }`}
                >
                  {num}
                </button>
              ))}
            </div>
          </div>

          {/* Reason for Stock Out */}
          {mode === 'OUT' && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-zinc-700 uppercase tracking-wider">
                Reason:
              </span>
              <select
                value={deductReason}
                onChange={(e) => setDeductReason(e.target.value)}
                className="px-3 py-1.5 text-xs bg-zinc-50 border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-zinc-900 font-medium"
              >
                <option value="Damaged / Broken">Damaged / Broken</option>
                <option value="Expired">Expired</option>
                <option value="Customer Return Defect">Defective Return</option>
                <option value="Store Display / Sample">Store Display Sample</option>
                <option value="Inventory Shrinkage">Shrinkage / Missing</option>
                <option value="Other">Other (Custom)</option>
              </select>
            </div>
          )}
        </div>

        {mode === 'OUT' && deductReason === 'Other' && (
          <div>
            <input
              type="text"
              placeholder="Specify custom reason..."
              value={customReason}
              onChange={(e) => setCustomReason(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-zinc-50 border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-zinc-900"
            />
          </div>
        )}

        {/* Input Bar & Camera Scanner Button */}
        <div className="flex gap-2">
          <form onSubmit={onManualSubmit} className="flex-1 relative">
            <Keyboard className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={manualBarcode}
              onChange={(e) => setManualBarcode(e.target.value)}
              placeholder="Ready for scan... (or type barcode and press Enter)"
              disabled={isProcessing}
              className="w-full pl-9 pr-3 py-2.5 text-xs sm:text-sm font-mono bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:bg-white"
            />
          </form>

          <button
            type="button"
            onClick={handleOpenScanner}
            className="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2.5 bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-semibold rounded-xl shadow-sm transition-all flex-shrink-0"
          >
            <Camera className="w-4 h-4 text-emerald-400" />
            <span className="hidden sm:inline">Camera Scanner</span>
            <span className="sm:hidden">Camera</span>
          </button>
        </div>
      </div>

      {/* Prominent Feedback Card */}
      {feedback && (
        <div
          className={`p-5 rounded-2xl border transition-all animate-in fade-in slide-in-from-top-2 ${
            feedback.type === 'success'
              ? 'bg-white border-emerald-300 shadow-md ring-1 ring-emerald-400/20'
              : 'bg-rose-50 border-rose-200 text-rose-800'
          }`}
        >
          {feedback.type === 'success' && feedback.product && feedback.movement ? (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: feedback.product.department_color || '#4f46e5' }}
                  />
                  <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                    {feedback.product.department_name}
                  </span>
                </div>
                <h3 className="text-base font-bold text-zinc-950">
                  {feedback.product.name}
                </h3>
                <p className="text-xs font-mono text-zinc-400">
                  Barcode: {feedback.product.barcode}
                </p>
              </div>

              {/* Stock delta block */}
              <div className="flex items-center gap-3 bg-zinc-50 p-3 rounded-xl border border-zinc-200/80">
                <div className="text-right">
                  <span className="text-[10px] text-zinc-400 uppercase font-semibold block">
                    Previous
                  </span>
                  <span className="text-sm font-bold text-zinc-600 font-mono">
                    {feedback.movement.quantity_before}
                  </span>
                </div>

                <div
                  className={`px-2.5 py-1 rounded-lg text-xs font-extrabold flex items-center gap-1 ${
                    feedback.movement.quantity_change > 0
                      ? 'bg-emerald-100 text-emerald-800'
                      : 'bg-rose-100 text-rose-800'
                  }`}
                >
                  {feedback.movement.quantity_change > 0 ? '+' : ''}
                  {feedback.movement.quantity_change}
                </div>

                <div>
                  <span className="text-[10px] text-zinc-400 uppercase font-semibold block">
                    Updated
                  </span>
                  <span className="text-lg font-black text-zinc-950 font-mono">
                    {feedback.movement.quantity_after} {feedback.product.unit}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-rose-600 flex-shrink-0" />
              <span className="text-xs font-semibold">{feedback.message}</span>
            </div>
          )}
        </div>
      )}

      {/* Real-time Session Scan History */}
      <div className="bg-white rounded-2xl border border-zinc-200/80 shadow-sm overflow-hidden">
        <div className="p-4 border-b border-zinc-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-zinc-700" />
            <h3 className="text-xs font-bold text-zinc-900 uppercase tracking-wider">
              Recent Session Scans ({recentLogs.length})
            </h3>
          </div>
          {recentLogs.length > 0 && (
            <button
              onClick={() => setRecentLogs([])}
              className="text-xs text-zinc-400 hover:text-zinc-700"
            >
              Clear
            </button>
          )}
        </div>

        {recentLogs.length === 0 ? (
          <div className="p-8 text-center text-zinc-400">
            <p className="text-xs">No scans in this session yet.</p>
            <p className="text-[11px] text-zinc-300 mt-0.5">
              Scanned items will appear here with before and after stock levels.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-zinc-100 max-h-80 overflow-y-auto">
            {recentLogs.map((log) => (
              <div key={log.id} className="p-3.5 flex items-center justify-between text-xs hover:bg-zinc-50">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-zinc-900">{log.productName}</span>
                    <span className="text-[10px] text-zinc-400 font-mono">[{log.barcode}]</span>
                  </div>
                  <div className="text-[11px] text-zinc-500 mt-0.5">
                    {log.reason} • {log.timestamp}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-zinc-400 font-mono">
                    {log.before} → <strong className="text-zinc-900">{log.after}</strong>
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded font-mono font-bold text-xs ${
                      log.change > 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                    }`}
                  >
                    {log.change > 0 ? `+${log.change}` : log.change}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Barcode Camera Scanner Modal */}
      <BarcodeScannerModal
        isOpen={scannerModalOpen}
        onClose={() => setScannerModalOpen(false)}
        onScan={handleProcessScan}
        title={mode === 'IN' ? 'Scan to Restock (+)' : 'Scan to Deduct (-)'}
        subtitle={`Adjusting stock by ${stepQuantity} unit(s)`}
        continuous={true}
      />
    </div>
  );
};
