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

type ScanMode = 'IN' | 'OUT';

interface ScanReason {
  value: string;
  label: string;
  type: 'RESTOCK' | 'ADJUSTMENT_ADD' | 'ADJUSTMENT_REMOVE';
}

/**
 * The reason decides the movement type. Only goods actually arriving are a RESTOCK, so
 * undoing an over-count corrects the books instead of inflating deliveries, and the mirror
 * case on the way out is a correction rather than another line of shrinkage.
 */
const STOCK_IN_REASONS: ScanReason[] = [
  { value: 'Supplier Delivery', label: 'Supplier Delivery', type: 'RESTOCK' },
  { value: 'Stock Transfer In', label: 'Transfer In / Other Store', type: 'RESTOCK' },
  { value: 'Count Correction', label: 'Count Correction (Found Stock)', type: 'ADJUSTMENT_ADD' },
  { value: 'Reversed Mis-Scan', label: 'Reversed Mis-Scan', type: 'ADJUSTMENT_ADD' },
  { value: 'Other', label: 'Other (Custom)', type: 'ADJUSTMENT_ADD' },
];

const STOCK_OUT_REASONS: ScanReason[] = [
  { value: 'Damaged / Broken', label: 'Damaged / Broken', type: 'ADJUSTMENT_REMOVE' },
  { value: 'Expired', label: 'Expired', type: 'ADJUSTMENT_REMOVE' },
  { value: 'Customer Return Defect', label: 'Defective Return', type: 'ADJUSTMENT_REMOVE' },
  { value: 'Store Display / Sample', label: 'Store Display Sample', type: 'ADJUSTMENT_REMOVE' },
  { value: 'Inventory Shrinkage', label: 'Shrinkage / Missing', type: 'ADJUSTMENT_REMOVE' },
  { value: 'Other', label: 'Other (Custom)', type: 'ADJUSTMENT_REMOVE' },
];

// A single delivery routinely runs past 30 lines, so hold the whole session and say when it trims.
const SESSION_LOG_LIMIT = 200;

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
  const [restockReason, setRestockReason] = useState<string>('Supplier Delivery');
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
  // Holds the last cleared session log so Clear stays reversible without a blocking prompt
  const [clearedLogs, setClearedLogs] = useState<RecentScanLog[]>([]);
  const [continuousScan, setContinuousScan] = useState<boolean>(true);

  // Guards against rapid duplicate frames and concurrent network requests
  const isProcessingRef = useRef<boolean>(false);
  const lastScanRecordRef = useRef<{ code: string; time: number }>({ code: '', time: 0 });

  const activeReasons = mode === 'OUT' ? STOCK_OUT_REASONS : STOCK_IN_REASONS;
  const selectedReason = mode === 'OUT' ? deductReason : restockReason;
  const activeReason =
    activeReasons.find((reason) => reason.value === selectedReason) ?? activeReasons[0];

  // A scan count hides how much stock moved: twelve scans of ten units is not twelve units.
  const unitsIn = recentLogs.reduce((sum, log) => (log.change > 0 ? sum + log.change : sum), 0);
  const unitsOut = recentLogs.reduce((sum, log) => (log.change < 0 ? sum - log.change : sum), 0);

  const handleProcessScan = async (scannedBarcode: string) => {
    const code = scannedBarcode.trim();
    if (!code) return;

    // 1. Guard against concurrent executions
    if (isProcessingRef.current) {
      console.log('Ignored concurrent scan request for:', code);
      return;
    }

    // 2. Guard against duplicate rapid scans of the exact same barcode within 3 seconds
    const now = Date.now();
    if (lastScanRecordRef.current.code === code && now - lastScanRecordRef.current.time < 3000) {
      console.log('Debounced rapid duplicate scan for barcode:', code);
      return;
    }

    lastScanRecordRef.current = { code, time: now };
    isProcessingRef.current = true;
    setIsProcessing(true);
    setFeedback(null);

    try {
      const finalReason =
        activeReason.value === 'Other'
          ? customReason.trim() || (mode === 'OUT' ? 'Manual adjustment' : 'Manual stock increase')
          : activeReason.value;
      const signedChange = mode === 'OUT' ? -stepQuantity : stepQuantity;

      const result = await api.scanAdjustStock({
        barcode: code,
        change_quantity: stepQuantity,
        type: activeReason.type,
        reason: finalReason,
      });

      playScanSuccessSound();
      setFeedback({
        type: 'success',
        product: result.product,
        movement: result.movement,
        message:
          signedChange > 0
            ? `Stock increased by +${stepQuantity} (${finalReason})`
            : `Stock decreased by -${stepQuantity} (${finalReason})`,
      });

      setRecentLogs((prev) => [
        {
          id: Math.random().toString(),
          productName: result.product.name,
          barcode: code,
          departmentName: result.product.department_name || '',
          change: signedChange,
          before: result.movement.quantity_before,
          after: result.movement.quantity_after,
          type: activeReason.type,
          reason: finalReason,
          timestamp: new Date().toLocaleTimeString(),
        },
        ...prev.slice(0, SESSION_LOG_LIMIT - 1),
      ]);
      // A new scan invalidates the undo buffer; restoring it would drop the row just added
      setClearedLogs([]);
      setManualBarcode('');

      await refreshData();
    } catch (err: any) {
      playScanErrorSound();
      setFeedback({
        type: 'error',
        message: err.message || `Failed to process barcode "${code}"`,
      });
      // Keep the code on screen so a mistyped or unknown barcode can be fixed and retried,
      // and drop the duplicate guard so that retry is not swallowed as a rapid re-scan
      setManualBarcode(code);
      lastScanRecordRef.current = { code: '', time: 0 };
    } finally {
      setIsProcessing(false);
      isProcessingRef.current = false;
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

  const handleClearLogs = () => {
    setClearedLogs(recentLogs);
    setRecentLogs([]);
  };

  const handleUndoClear = () => {
    setRecentLogs(clearedLogs);
    setClearedLogs([]);
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
          aria-pressed={mode === 'IN'}
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
          aria-pressed={mode === 'OUT'}
          className={`p-3 sm:p-3.5 rounded-2xl border flex items-center justify-center gap-1.5 sm:gap-2 transition-all min-h-[48px] ${
            mode === 'OUT'
              ? 'bg-rose-600 text-white border-rose-600 shadow-md font-bold'
              : 'bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50 font-semibold'
          }`}
        >
          <MinusCircle className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0" />
          <span className="text-xs sm:text-sm">Stock Out (-)</span>
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
                  aria-label={`${num} units per scan`}
                  aria-pressed={stepQuantity === num}
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

          {/* Camera Scanner Mode: Continuous with Pause vs Single Scan Auto-Close */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-zinc-700 uppercase tracking-wider">
              Camera:
            </span>
            <div className="inline-flex rounded-lg border border-zinc-200 bg-zinc-50 p-0.5">
              <button
                type="button"
                onClick={() => setContinuousScan(true)}
                aria-pressed={continuousScan}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-all ${
                  continuousScan
                    ? 'bg-white text-zinc-950 font-bold shadow-2xs'
                    : 'text-zinc-600 hover:text-zinc-900'
                }`}
                title="Camera stays open with a 3-second anti-duplicate pause between scans"
              >
                <Zap className="w-3.5 h-3.5 flex-shrink-0" />
                Multi-Scan (Paused)
              </button>
              <button
                type="button"
                onClick={() => setContinuousScan(false)}
                aria-pressed={!continuousScan}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-all ${
                  !continuousScan
                    ? 'bg-white text-zinc-950 font-bold shadow-2xs'
                    : 'text-zinc-600 hover:text-zinc-900'
                }`}
                title="Camera automatically closes after scanning one product"
              >
                <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
                Single (Auto-Close)
              </button>
            </div>
          </div>

          {/* Reason — also decides how the movement is filed, so the ledger stays honest */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-zinc-700 uppercase tracking-wider">
              Reason:
            </span>
            <select
              value={selectedReason}
              onChange={(e) =>
                mode === 'OUT' ? setDeductReason(e.target.value) : setRestockReason(e.target.value)
              }
              aria-label={mode === 'OUT' ? 'Reason for stock out' : 'Reason for stock in'}
              className="px-3 py-1.5 text-xs bg-zinc-50 border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-zinc-900 font-medium"
            >
              {activeReasons.map((reason) => (
                <option key={reason.value} value={reason.value}>
                  {reason.label}
                </option>
              ))}
            </select>
            <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
              {activeReason.type === 'RESTOCK'
                ? 'Files as restock'
                : activeReason.type === 'ADJUSTMENT_ADD'
                  ? 'Files as correction (+)'
                  : 'Files as correction (-)'}
            </span>
          </div>
        </div>

        {selectedReason === 'Other' && (
          <div>
            <input
              type="text"
              placeholder="Specify custom reason..."
              aria-label="Custom reason"
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
              aria-label="Barcode"
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
                <p className="text-xs font-mono text-zinc-500">
                  Barcode: {feedback.product.barcode}
                </p>
              </div>

              {/* Stock delta block */}
              <div className="flex items-center gap-3 bg-zinc-50 p-3 rounded-xl border border-zinc-200/80">
                <div className="text-right">
                  <span className="text-[11px] text-zinc-500 uppercase font-semibold block">
                    Previous
                  </span>
                  <span className="text-sm font-bold text-zinc-600 tabular-nums">
                    {feedback.movement.quantity_before}
                  </span>
                </div>

                <div
                  className={`px-2.5 py-1 rounded-lg text-xs font-extrabold tabular-nums flex items-center gap-1 ${
                    feedback.movement.quantity_change > 0
                      ? 'bg-emerald-100 text-emerald-800'
                      : 'bg-rose-100 text-rose-800'
                  }`}
                >
                  {feedback.movement.quantity_change > 0 ? '+' : ''}
                  {feedback.movement.quantity_change}
                </div>

                <div>
                  <span className="text-[11px] text-zinc-500 uppercase font-semibold block">
                    Updated
                  </span>
                  <span className="text-lg font-black text-zinc-950 tabular-nums">
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
        <div className="p-4 border-b border-zinc-100 flex items-center justify-between gap-3">
          <div className="flex items-center flex-wrap gap-x-2 gap-y-1">
            <History className="w-4 h-4 text-zinc-700 flex-shrink-0" />
            <h3 className="text-xs font-bold text-zinc-900 uppercase tracking-wider">
              Recent Session Scans ({recentLogs.length})
            </h3>
            {recentLogs.length > 0 && (
              <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 tabular-nums">
                +{unitsIn} / -{unitsOut} units
              </span>
            )}
            {recentLogs.length >= SESSION_LOG_LIMIT && (
              <span className="text-xs text-zinc-500">
                latest {SESSION_LOG_LIMIT} only
              </span>
            )}
          </div>
          {recentLogs.length > 0 ? (
            <button
              onClick={handleClearLogs}
              className="text-xs font-medium text-zinc-500 hover:text-zinc-900 flex-shrink-0"
            >
              Clear
            </button>
          ) : clearedLogs.length > 0 ? (
            <button
              onClick={handleUndoClear}
              className="flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-900 flex-shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Undo clear ({clearedLogs.length})
            </button>
          ) : null}
        </div>

        {recentLogs.length === 0 ? (
          <div className="p-8 text-center text-zinc-500">
            <p className="text-xs">No scans in this session yet.</p>
            <p className="text-xs text-zinc-500 mt-0.5">
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
                    <span className="text-xs text-zinc-500 font-mono">[{log.barcode}]</span>
                  </div>
                  <div className="text-xs text-zinc-500 mt-0.5">
                    {log.reason} • {log.timestamp}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-zinc-500 tabular-nums">
                    {log.before} → <strong className="text-zinc-900">{log.after}</strong>
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded tabular-nums font-bold text-xs ${
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
        title={mode === 'IN' ? 'Scan to Stock In (+)' : 'Scan to Stock Out (-)'}
        subtitle={`${stepQuantity} unit(s) • ${activeReason.label} • ${
          continuousScan ? 'Multi-scan with 3s anti-duplicate pause' : 'Auto-closes upon scan'
        }`}
        continuous={continuousScan}
      />
    </div>
  );
};
