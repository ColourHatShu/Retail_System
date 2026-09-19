import React, { useState, useRef } from 'react';
import {
  ScanBarcode,
  CirclePlus,
  CircleMinus,
  CircleCheck,
  CircleAlert,
  Camera,
  ChevronDown,
  Undo2,
  PackagePlus,
  TriangleAlert,
  Plus,
  Minus,
  LoaderCircle,
  X,
} from 'lucide-react';
import { Department, Product, StockMovement } from '../types';
import { ApiError, api } from '../utils/api';
import { playScanSuccessSound, playScanErrorSound } from '../utils/audio';
import { useHardwareBarcodeScanner } from '../utils/barcodeListener';
import { BarcodeScannerModal } from '../components/BarcodeScannerModal';
import { ProductModal } from '../components/ProductModal';

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

// Case sizes a receiver actually counts in. The stepper covers everything in between.
const QUANTITY_PRESETS = [1, 6, 12, 24];
const MAX_QUANTITY_PER_SCAN = 999;

/** Written to the ledger when a scan is reversed from the last-scan card. */
const UNDO_REASON = 'Undo scan';

// 11px is only legible as an all-caps micro-label, and not on a phone held at arm's length.
const MICRO_LABEL =
  'text-xs lg:text-[11px] lg:leading-4 font-semibold uppercase tracking-[0.06em] text-zinc-500';

const CARD = 'bg-white rounded-2xl border border-zinc-200/80 shadow-xs';

const clockLabel = (at: Date) => at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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
  /** Short clock reading for the list; `timestamp` keeps the seconds for the feedback card. */
  timeShort: string;
  /** A scan the server refused because the barcode is not in the catalogue: nothing was written. */
  unmatched?: boolean;
  /** Set once that parked barcode has been registered from this screen. */
  resolved?: boolean;
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
    /** Clock reading of the scan this card is reporting. */
    at?: string;
    /** True when the card is reporting a reversal rather than a fresh scan. */
    reversal?: boolean;
    /** Set when the server refused because the barcode is not in the catalogue. */
    parkedBarcode?: string;
  } | null>(null);
  const [scannerModalOpen, setScannerModalOpen] = useState(false);
  const [recentLogs, setRecentLogs] = useState<RecentScanLog[]>([]);
  // Holds the last cleared session log so Clear stays reversible without a blocking prompt
  const [clearedLogs, setClearedLogs] = useState<RecentScanLog[]>([]);
  const [continuousScan, setContinuousScan] = useState<boolean>(true);
  const [sessionStartedAt] = useState<Date>(() => new Date());

  // The last saved scan, kept only while it is still the newest movement on that product.
  const [lastSaved, setLastSaved] = useState<{
    barcode: string;
    productName: string;
    change: number;
    after: number;
  } | null>(null);
  const [isUndoing, setIsUndoing] = useState(false);

  // Registering an unknown barcode without leaving the screen. Departments are only
  // fetched when the form is actually opened, so a scanning session costs one request.
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [pendingBarcode, setPendingBarcode] = useState<string | null>(null);
  const [pendingLogId, setPendingLogId] = useState<string | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [isOpeningProductForm, setIsOpeningProductForm] = useState(false);

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
  const savedCount = recentLogs.filter((log) => !log.unmatched).length;
  const needsProduct = recentLogs.filter((log) => log.unmatched && !log.resolved).length;

  const phoneMeta = [
    `${recentLogs.length} ${recentLogs.length === 1 ? 'scan' : 'scans'}`,
    unitsIn > 0 ? `+${unitsIn} added` : null,
    unitsOut > 0 ? `−${unitsOut} removed` : null,
    needsProduct > 0 ? `${needsProduct} not saved` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const pushLog = (entry: RecentScanLog) => {
    setRecentLogs((prev) => [entry, ...prev.slice(0, SESSION_LOG_LIMIT - 1)]);
    // A new row invalidates the undo buffer; restoring it would drop the row just added
    setClearedLogs([]);
  };

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
      const at = new Date();
      setFeedback({
        type: 'success',
        product: result.product,
        movement: result.movement,
        at: at.toLocaleTimeString(),
        message:
          signedChange > 0
            ? `Stock increased by +${stepQuantity} (${finalReason})`
            : `Stock decreased by -${stepQuantity} (${finalReason})`,
      });

      pushLog({
        id: Math.random().toString(),
        productName: result.product.name,
        barcode: code,
        departmentName: result.product.department_name || '',
        change: signedChange,
        before: result.movement.quantity_before,
        after: result.movement.quantity_after,
        type: activeReason.type,
        reason: finalReason,
        timestamp: at.toLocaleTimeString(),
        timeShort: clockLabel(at),
      });
      // Offer the reversal only against the balance this scan left behind
      setLastSaved({
        barcode: code,
        productName: result.product.name,
        change: signedChange,
        after: result.movement.quantity_after,
      });
      setManualBarcode('');

      await refreshData();
    } catch (err: any) {
      playScanErrorSound();
      // A barcode the catalogue has never seen used to vanish with the error card: the
      // code was gone the moment the next scan came in. Park it in the session list so
      // the receiver can register it, and keep counting it as "not saved".
      const unknownBarcode = err instanceof ApiError && err.code === 'NOT_FOUND';
      if (unknownBarcode) {
        const at = new Date();
        pushLog({
          id: Math.random().toString(),
          productName: 'Unknown barcode',
          barcode: code,
          departmentName: '',
          change: 0,
          before: 0,
          after: 0,
          type: '',
          reason: '',
          timestamp: at.toLocaleTimeString(),
          timeShort: clockLabel(at),
          unmatched: true,
        });
      }
      setFeedback({
        type: 'error',
        message: err.message || `Failed to process barcode "${code}"`,
        parkedBarcode: unknownBarcode ? code : undefined,
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

  /**
   * Reverses the scan the card is showing. Stock Out's reasons are all losses, so without
   * this the only way back from a mis-scan was to file it as damage or shrinkage. The
   * reversal is refused once anything else has touched that product, because then this
   * scan is no longer the last word on its balance.
   */
  const handleUndoLastScan = async () => {
    const target = lastSaved;
    if (!target || isProcessingRef.current) return;

    isProcessingRef.current = true;
    setIsUndoing(true);
    setIsProcessing(true);

    try {
      const current = await api.getProductByBarcode(target.barcode);
      if (current.stock_quantity !== target.after) {
        playScanErrorSound();
        setFeedback({
          type: 'error',
          message:
            `${target.productName} is now at ${current.stock_quantity}, not ${target.after}, so this scan ` +
            'is no longer its last change. Nothing was reversed — correct the count from Inventory.',
        });
        setLastSaved(null);
        return;
      }

      const result = await api.scanAdjustStock({
        barcode: target.barcode,
        change_quantity: Math.abs(target.change),
        type: target.change > 0 ? 'ADJUSTMENT_REMOVE' : 'ADJUSTMENT_ADD',
        reason: UNDO_REASON,
      });

      playScanSuccessSound();
      const at = new Date();
      setFeedback({
        type: 'success',
        product: result.product,
        movement: result.movement,
        at: at.toLocaleTimeString(),
        reversal: true,
        message: `Reversed ${target.change > 0 ? '+' : ''}${target.change} on ${target.productName}`,
      });
      pushLog({
        id: Math.random().toString(),
        productName: result.product.name,
        barcode: target.barcode,
        departmentName: result.product.department_name || '',
        change: -target.change,
        before: result.movement.quantity_before,
        after: result.movement.quantity_after,
        type: result.movement.type,
        reason: UNDO_REASON,
        timestamp: at.toLocaleTimeString(),
        timeShort: clockLabel(at),
      });
      // One reversal per scan: the undo is itself a movement, not something to ping-pong
      setLastSaved(null);
      // Undoing is a deliberate "do that again properly", so the 3 s duplicate guard must
      // not swallow the corrected re-scan of the same code
      lastScanRecordRef.current = { code: '', time: 0 };

      await refreshData();
    } catch (err: any) {
      playScanErrorSound();
      setFeedback({
        type: 'error',
        message: err.message || 'Could not reverse the last scan',
      });
    } finally {
      setIsUndoing(false);
      setIsProcessing(false);
      isProcessingRef.current = false;
    }
  };

  // Listen to hardware barcode scanner keystrokes. Silenced while the product form is
  // open: that dialog has its own listener, and a scan meant for its barcode field would
  // otherwise also move stock behind it.
  useHardwareBarcodeScanner((barcode) => {
    handleProcessScan(barcode);
  }, !productModalOpen);

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

  const adjustQuantity = (delta: number) =>
    setStepQuantity((current) =>
      Math.min(MAX_QUANTITY_PER_SCAN, Math.max(1, current + delta)),
    );

  const loadDepartments = async (): Promise<Department[]> => {
    const loaded = await api.getDepartments();
    setDepartments(loaded);
    return loaded;
  };

  const handleAddProductFor = async (log: RecentScanLog) => {
    setIsOpeningProductForm(true);
    try {
      // The form cannot file a product without departments, so fetch before opening it
      // rather than showing an empty picker.
      if (departments.length === 0) await loadDepartments();
      setPendingBarcode(log.barcode);
      setPendingLogId(log.id);
      setProductModalOpen(true);
    } catch (err: any) {
      setFeedback({
        type: 'error',
        message: err.message || 'Could not load departments, so the product form cannot open.',
      });
    } finally {
      setIsOpeningProductForm(false);
    }
  };

  const handleSaveNewProduct = async (data: Partial<Product>) => {
    await api.createProduct(data);
    await refreshData();
    // The row stays in the list as a record of what was registered. No movement was
    // written, so it still does not count towards units in or out.
    const resolvedId = pendingLogId;
    if (resolvedId) {
      setRecentLogs((prev) =>
        prev.map((log) => (log.id === resolvedId ? { ...log, resolved: true } : log)),
      );
    }
  };

  const closeProductModal = () => {
    setProductModalOpen(false);
    setPendingBarcode(null);
    setPendingLogId(null);
  };

  const filesAsLabel =
    activeReason.type === 'RESTOCK'
      ? 'Files as a restock'
      : activeReason.type === 'ADJUSTMENT_ADD'
        ? 'Files as a correction (+)'
        : 'Files as a correction (−)';

  const nextScanLabel = `${mode === 'OUT' ? '−' : '+'}${stepQuantity}`;

  const stockState = (product: Product) => {
    if (product.stock_quantity <= 0) {
      return { label: 'Out of stock', className: 'bg-rose-50 text-rose-700' };
    }
    if (product.stock_quantity <= product.min_stock_level) {
      return { label: 'Low stock', className: 'bg-amber-50 text-amber-700' };
    }
    return { label: 'In stock', className: 'bg-emerald-50 text-emerald-700' };
  };

  const quantityChipClass = (active: boolean) =>
    `h-11 sm:h-10 min-[1800px]:w-14 rounded-lg text-[15px] sm:text-sm font-semibold tabular-nums transition-colors ${
      active
        ? 'bg-zinc-900 text-white font-bold shadow-xs'
        : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
    }`;

  const segmentClass = (active: boolean) =>
    `h-full text-xs sm:text-[13px] transition-colors ${
      active ? 'bg-zinc-900 text-white font-semibold' : 'text-zinc-700 font-medium hover:bg-zinc-50'
    }`;

  return (
    <div className="w-full min-w-0 max-w-full overflow-x-hidden px-4 py-3 sm:px-5 sm:py-5 min-[1800px]:px-6 min-[1800px]:py-6 flex flex-col gap-3 sm:gap-4">
      {/* Page header. The screen used to sit in a centred max-w-5xl column under the title
          "Rapid Barcode Stock Adjuster", which matched nothing in the navigation. */}
      <header className="flex flex-col gap-1">
        <h2 className="text-lg sm:text-[22px] sm:leading-7 font-bold tracking-tight text-zinc-950">
          Stock Scan
        </h2>
        <p className="text-xs sm:text-[13px] sm:leading-5 text-zinc-500">
          Scan to add or remove stock. Every saved scan is written to Movement History.
        </p>
      </header>

      <div className="flex flex-col lg:flex-row gap-3 sm:gap-4 min-w-0 items-stretch">
        {/* Left: scan controls and the last scan */}
        <div className="w-full lg:w-[468px] min-[1800px]:w-[640px] lg:flex-shrink-0 flex flex-col gap-3 sm:gap-4 min-w-0">
          <div className={`${CARD} p-3 sm:p-5 min-[1800px]:p-6 flex flex-col gap-2.5 sm:gap-4 min-[1800px]:gap-5`}>
            {/* Mode */}
            <div className="grid grid-cols-2 gap-2 min-[1800px]:gap-3">
              <button
                type="button"
                onClick={() => setMode('IN')}
                aria-pressed={mode === 'IN'}
                className={`h-12 sm:h-14 rounded-xl border flex items-center justify-center gap-2 transition-colors ${
                  mode === 'IN'
                    ? 'bg-emerald-600 border-emerald-600 text-white shadow-md font-bold'
                    : 'bg-white border-zinc-200 text-zinc-700 font-semibold hover:bg-zinc-50'
                }`}
              >
                <CirclePlus className="w-[18px] h-[18px] sm:w-5 sm:h-5 flex-shrink-0" />
                <span className="text-sm sm:text-[15px]">Stock in (+)</span>
              </button>

              <button
                type="button"
                onClick={() => setMode('OUT')}
                aria-pressed={mode === 'OUT'}
                className={`h-12 sm:h-14 rounded-xl border flex items-center justify-center gap-2 transition-colors ${
                  mode === 'OUT'
                    ? 'bg-rose-600 border-rose-600 text-white shadow-md font-bold'
                    : 'bg-white border-zinc-200 text-zinc-700 font-semibold hover:bg-zinc-50'
                }`}
              >
                <CircleMinus className="w-[18px] h-[18px] sm:w-5 sm:h-5 flex-shrink-0" />
                <span className="text-sm sm:text-[15px]">Stock out (−)</span>
              </button>
            </div>

            {/* Quantity per scan: a stepper for any number, chips for the usual case sizes */}
            <div className="flex flex-col gap-1.5 sm:gap-2">
              <span className={MICRO_LABEL}>Quantity per scan</span>
              <div className="flex items-center gap-2 sm:gap-2.5 min-[1800px]:gap-3">
                <div className="h-11 sm:h-10 flex-shrink-0 flex items-center rounded-xl border border-zinc-200 bg-white overflow-hidden">
                  <button
                    type="button"
                    onClick={() => adjustQuantity(-1)}
                    disabled={stepQuantity <= 1}
                    aria-label="Decrease quantity per scan"
                    className="w-11 sm:w-10 h-full flex items-center justify-center bg-zinc-50 text-zinc-700 hover:bg-zinc-100 disabled:text-zinc-300 disabled:hover:bg-zinc-50"
                  >
                    <Minus className="w-4 h-4" />
                  </button>
                  <span
                    aria-live="polite"
                    className="w-9 sm:w-12 text-center text-[15px] font-bold text-zinc-950 tabular-nums"
                  >
                    {stepQuantity}
                  </span>
                  <button
                    type="button"
                    onClick={() => adjustQuantity(1)}
                    disabled={stepQuantity >= MAX_QUANTITY_PER_SCAN}
                    aria-label="Increase quantity per scan"
                    className="w-11 sm:w-10 h-full flex items-center justify-center bg-zinc-50 text-zinc-700 hover:bg-zinc-100 disabled:text-zinc-300 disabled:hover:bg-zinc-50"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex-1 min-w-0 grid grid-cols-4 gap-1.5 min-[1800px]:flex min-[1800px]:flex-none min-[1800px]:gap-2">
                  {QUANTITY_PRESETS.map((num) => (
                    <button
                      key={num}
                      type="button"
                      onClick={() => setStepQuantity(num)}
                      aria-label={`${num} units per scan`}
                      aria-pressed={stepQuantity === num}
                      className={quantityChipClass(stepQuantity === num)}
                    >
                      {num}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Reason (both directions) and camera behaviour */}
            <div className="grid grid-cols-2 gap-2 sm:gap-3 min-[1800px]:gap-4 items-start">
              <div className="flex flex-col gap-1.5 sm:gap-2 min-w-0">
                <span className={MICRO_LABEL}>Reason</span>
                <div className="relative">
                  {/* The reason also decides how the movement is filed, so the ledger stays honest */}
                  <select
                    value={selectedReason}
                    onChange={(e) =>
                      mode === 'OUT'
                        ? setDeductReason(e.target.value)
                        : setRestockReason(e.target.value)
                    }
                    aria-label={mode === 'OUT' ? 'Reason for stock out' : 'Reason for stock in'}
                    className="w-full h-11 sm:h-10 pl-3 pr-9 rounded-xl border border-zinc-200 bg-white text-[13px] sm:text-sm font-medium text-zinc-900 appearance-none truncate focus:outline-none focus:ring-2 focus:ring-zinc-900"
                  >
                    {activeReasons.map((reason) => (
                      <option key={reason.value} value={reason.value}>
                        {reason.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="w-4 h-4 text-zinc-500 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
                <span className="text-xs text-zinc-500">{filesAsLabel}</span>
              </div>

              <div className="flex flex-col gap-1.5 sm:gap-2 min-w-0">
                <span className={MICRO_LABEL}>Camera</span>
                <div className="h-11 sm:h-10 grid grid-cols-2 rounded-xl border border-zinc-200 bg-white overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setContinuousScan(true)}
                    aria-pressed={continuousScan}
                    className={segmentClass(continuousScan)}
                  >
                    Keep open
                  </button>
                  <button
                    type="button"
                    onClick={() => setContinuousScan(false)}
                    aria-pressed={!continuousScan}
                    className={segmentClass(!continuousScan)}
                  >
                    Scan once
                  </button>
                </div>
                <span className="text-xs text-zinc-500">
                  <span className="hidden min-[1800px]:inline">
                    Pauses 3 s before re-reading the same code
                  </span>
                  <span className="min-[1800px]:hidden">Pauses 3 s on repeat codes</span>
                </span>
              </div>
            </div>

            {selectedReason === 'Other' && (
              <input
                type="text"
                placeholder="Specify custom reason..."
                aria-label="Custom reason"
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                className="w-full h-11 sm:h-10 px-3 rounded-xl border border-zinc-200 bg-white text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900"
              />
            )}

            {/* Persistent scan field */}
            <div className="flex gap-2">
              <form onSubmit={onManualSubmit} className="flex-1 min-w-0">
                <div className="h-[52px] sm:h-14 px-3 sm:px-4 rounded-xl border border-zinc-200 bg-white flex items-center gap-2 sm:gap-3 transition-shadow focus-within:border-zinc-900 focus-within:ring-[3px] focus-within:ring-zinc-900/10">
                  <ScanBarcode className="w-[18px] h-[18px] sm:w-5 sm:h-5 text-zinc-700 flex-shrink-0" />
                  <input
                    type="text"
                    value={manualBarcode}
                    onChange={(e) => setManualBarcode(e.target.value)}
                    placeholder="Scan or type a barcode"
                    aria-label="Barcode"
                    disabled={isProcessing}
                    className="flex-1 min-w-0 bg-transparent text-[15px] font-mono text-zinc-950 outline-none placeholder:font-sans placeholder:text-zinc-500 disabled:opacity-60"
                  />
                  <span
                    aria-label={`Next scan ${nextScanLabel} units`}
                    className={`h-6 px-2 sm:px-2.5 rounded-full text-xs font-semibold tabular-nums whitespace-nowrap flex items-center flex-shrink-0 ${
                      mode === 'OUT' ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'
                    }`}
                  >
                    <span className="hidden min-[1800px]:inline">Next scan&nbsp;</span>
                    {nextScanLabel}
                  </span>
                  <span className="hidden min-[1800px]:flex h-6 px-1.5 rounded-md bg-zinc-50 border border-zinc-200 text-xs font-medium text-zinc-600 items-center flex-shrink-0">
                    Enter
                  </span>
                </div>
              </form>

              <button
                type="button"
                onClick={handleOpenScanner}
                aria-label="Scan with camera"
                className="h-[52px] sm:h-14 sm:w-14 min-[1800px]:w-auto px-4 sm:px-0 min-[1800px]:px-5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-white flex items-center justify-center gap-2 flex-shrink-0 transition-colors"
              >
                <Camera className="w-5 h-5 text-emerald-400 flex-shrink-0" />
                <span className="sm:hidden min-[1800px]:inline text-sm font-semibold">Camera</span>
              </button>
            </div>
          </div>

          {/* Last scan — the card a receiver actually watches */}
          <div className="flex-1 min-h-0 flex" role="status" aria-live="polite">
            {feedback && feedback.type === 'success' && feedback.product && feedback.movement ? (
              <div className="w-full bg-white rounded-2xl border border-emerald-300 ring-1 ring-emerald-400/20 shadow-xs p-3.5 sm:p-5 min-[1800px]:p-6 flex flex-col justify-between gap-3 sm:gap-4 animate-in fade-in slide-in-from-top-2">
                <div className="flex flex-col gap-2.5 sm:gap-4 min-[1800px]:gap-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className={`hidden min-[1800px]:block ${MICRO_LABEL}`}>Last scan</span>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <CircleCheck className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                        <span className="text-[13px] sm:text-sm font-bold text-emerald-700">
                          {feedback.reversal ? 'Scan reversed' : 'Saved to stock'}
                        </span>
                        <span className="text-xs sm:text-[13px] text-zinc-500 tabular-nums">
                          · {feedback.at}
                        </span>
                      </div>
                    </div>

                    {lastSaved && (
                      <button
                        type="button"
                        onClick={handleUndoLastScan}
                        disabled={isProcessing}
                        className="h-11 sm:h-10 px-3 sm:px-3.5 rounded-xl border border-zinc-200 bg-white text-[13px] sm:text-sm font-semibold text-zinc-900 flex items-center gap-1.5 flex-shrink-0 hover:bg-zinc-50 disabled:opacity-50"
                      >
                        {isUndoing ? (
                          <LoaderCircle className="w-4 h-4 animate-spin" />
                        ) : (
                          <Undo2 className="w-4 h-4" />
                        )}
                        <span className="hidden xs:inline">Undo scan</span>
                        <span className="xs:hidden">Undo</span>
                      </button>
                    )}
                  </div>

                  <div className="flex flex-col gap-1 sm:gap-1.5 min-w-0">
                    <div className="flex items-center gap-2 text-xs sm:text-[13px] font-medium text-zinc-600">
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: feedback.product.department_color || '#a1a1aa' }}
                      />
                      <span className="truncate">{feedback.product.department_name}</span>
                    </div>
                    <h3 className="text-[15px] sm:text-lg min-[1800px]:text-2xl min-[1800px]:leading-8 font-bold tracking-tight text-zinc-950">
                      {feedback.product.name}
                    </h3>
                    <p className="text-xs sm:text-[13px] font-mono text-zinc-500 truncate">
                      {feedback.product.sku ? `${feedback.product.sku} · ` : ''}
                      {feedback.product.barcode}
                    </p>
                  </div>

                  <div className="p-2.5 sm:p-4 min-[1800px]:p-5 rounded-xl bg-zinc-50 border border-zinc-100 grid grid-cols-3 gap-2 sm:gap-3 min-[1800px]:gap-4">
                    <div className="flex flex-col gap-0.5 sm:gap-2 min-w-0">
                      <span className={MICRO_LABEL}>Before</span>
                      <span className="text-2xl sm:text-[44px] sm:leading-[48px] min-[1800px]:text-[56px] min-[1800px]:leading-[60px] font-bold tracking-[-0.02em] text-zinc-600 tabular-nums">
                        {feedback.movement.quantity_before}
                      </span>
                    </div>
                    <div className="flex flex-col gap-0.5 sm:gap-2 min-w-0">
                      <span className={MICRO_LABEL}>Change</span>
                      <span
                        className={`text-2xl sm:text-[44px] sm:leading-[48px] min-[1800px]:text-[56px] min-[1800px]:leading-[60px] font-extrabold tracking-[-0.02em] tabular-nums ${
                          feedback.movement.quantity_change > 0 ? 'text-emerald-700' : 'text-rose-700'
                        }`}
                      >
                        {feedback.movement.quantity_change > 0 ? '+' : ''}
                        {feedback.movement.quantity_change}
                      </span>
                    </div>
                    <div className="flex flex-col gap-0.5 sm:gap-2 min-w-0">
                      <span className={MICRO_LABEL}>
                        <span className="min-[1800px]:hidden">In stock</span>
                        <span className="hidden min-[1800px]:inline">In stock now</span>
                      </span>
                      <span className="text-2xl sm:text-[44px] sm:leading-[48px] min-[1800px]:text-[56px] min-[1800px]:leading-[60px] font-extrabold tracking-[-0.02em] text-zinc-950 tabular-nums">
                        {feedback.movement.quantity_after}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="pt-2.5 sm:pt-4 border-t border-zinc-100 flex items-center gap-2.5 flex-wrap">
                  <span
                    className={`h-[22px] px-2 rounded-full text-xs font-semibold flex items-center ${
                      stockState(feedback.product).className
                    }`}
                  >
                    {stockState(feedback.product).label}
                  </span>
                  <span className="text-xs sm:text-[13px] text-zinc-500 tabular-nums">
                    Minimum {feedback.product.min_stock_level} {feedback.product.unit}
                    {feedback.movement.reason ? ` · ${feedback.movement.reason}` : ''}
                  </span>
                </div>
              </div>
            ) : feedback && feedback.type === 'error' ? (
              <div className="w-full bg-rose-50 rounded-2xl border border-rose-200 p-3.5 sm:p-5 flex items-start gap-3 animate-in fade-in slide-in-from-top-2">
                <CircleAlert className="w-5 h-5 text-rose-600 flex-shrink-0 mt-0.5" />
                <div className="flex flex-col gap-1 min-w-0">
                  <span className="text-[13px] sm:text-sm font-semibold text-rose-800 break-words">
                    {feedback.message}
                  </span>
                  {feedback.parkedBarcode && (
                    <span className="text-xs sm:text-[13px] text-rose-700">
                      Kept in this session below — add the product, then scan it again.
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <div className="w-full bg-white rounded-2xl border border-dashed border-zinc-200 p-5 min-h-[140px] flex flex-col items-center justify-center text-center gap-1.5">
                <ScanBarcode className="w-6 h-6 text-zinc-400" />
                <span className="text-sm font-semibold text-zinc-700">Ready for the next scan</span>
                <span className="text-xs sm:text-[13px] text-zinc-500 max-w-sm">
                  The product, the reason and the stock before and after appear here as soon as a
                  code is read.
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Right: the session log */}
        <section className={`flex-1 min-w-0 ${CARD} flex flex-col overflow-hidden`}>
          <div className="p-3 sm:p-4 min-[1800px]:px-6 min-[1800px]:py-5 border-b border-zinc-100 flex items-center justify-between gap-3">
            <div className="flex flex-col gap-0.5 min-w-0">
              <h3 className="text-[15px] sm:text-base font-bold text-zinc-950">This session</h3>
              {/* A phone has no room for the three tiles below, so the same figures ride in the meta line */}
              <span className="sm:hidden text-xs text-zinc-500 tabular-nums truncate">
                {phoneMeta}
              </span>
              <span className="hidden sm:block text-[13px] text-zinc-500 tabular-nums">
                Started {clockLabel(sessionStartedAt)} · {recentLogs.length}{' '}
                {recentLogs.length === 1 ? 'scan' : 'scans'} · {savedCount} saved
                {recentLogs.length >= SESSION_LOG_LIMIT ? ` · latest ${SESSION_LOG_LIMIT} only` : ''}
              </span>
            </div>

            {recentLogs.length > 0 ? (
              <button
                type="button"
                onClick={handleClearLogs}
                className="h-10 px-3 rounded-xl border border-zinc-200 bg-white text-[13px] font-semibold text-zinc-700 flex items-center gap-1.5 flex-shrink-0 hover:bg-zinc-50"
              >
                <X className="w-4 h-4" />
                <span className="hidden xs:inline">Clear list</span>
                <span className="xs:hidden">Clear</span>
              </button>
            ) : clearedLogs.length > 0 ? (
              <button
                type="button"
                onClick={handleUndoClear}
                className="h-10 px-3 rounded-xl border border-zinc-200 bg-white text-[13px] font-semibold text-zinc-700 flex items-center gap-1.5 flex-shrink-0 hover:bg-zinc-50"
              >
                <Undo2 className="w-4 h-4" />
                Undo clear ({clearedLogs.length})
              </button>
            ) : null}
          </div>

          {/* What actually moved, above the list: a scan count is not a unit count */}
          <div className="hidden sm:grid grid-cols-3 border-b border-zinc-100">
            <div className="px-3 py-2.5 sm:px-4 sm:py-3.5 min-[1800px]:px-6 min-[1800px]:py-4 border-r border-zinc-100 flex flex-col gap-1 min-w-0">
              <span className={`${MICRO_LABEL} whitespace-nowrap`}>Units added</span>
              <span className="text-2xl sm:text-[28px] sm:leading-8 font-extrabold text-zinc-950 tabular-nums">
                {unitsIn > 0 ? `+${unitsIn}` : '0'}
              </span>
            </div>
            <div className="px-3 py-2.5 sm:px-4 sm:py-3.5 min-[1800px]:px-6 min-[1800px]:py-4 border-r border-zinc-100 flex flex-col gap-1 min-w-0">
              <span className={`${MICRO_LABEL} whitespace-nowrap`}>Units removed</span>
              <span className="text-2xl sm:text-[28px] sm:leading-8 font-extrabold text-zinc-950 tabular-nums">
                {unitsOut > 0 ? `−${unitsOut}` : '0'}
              </span>
            </div>
            <div className="px-3 py-2.5 sm:px-4 sm:py-3.5 min-[1800px]:px-6 min-[1800px]:py-4 flex flex-col gap-1 min-w-0">
              <span className={`${MICRO_LABEL} whitespace-nowrap`}>Needs a product</span>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-2xl sm:text-[28px] sm:leading-8 font-extrabold text-zinc-950 tabular-nums">
                  {needsProduct}
                </span>
                {needsProduct > 0 && (
                  <span className="h-[22px] px-2 rounded-full bg-amber-50 text-amber-700 text-xs font-semibold whitespace-nowrap flex items-center">
                    Not saved
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Column headers only where all five columns fit without crushing the name */}
          <div className="hidden min-[1800px]:grid h-11 px-6 grid-cols-[80px_minmax(0,1fr)_180px_112px_128px] gap-4 items-center bg-zinc-50 border-b border-zinc-200 text-[11px] leading-4 font-semibold uppercase tracking-[0.06em] text-zinc-500">
            <span>Time</span>
            <span>Product</span>
            <span>Reason</span>
            <span className="text-right">Stock</span>
            <span className="text-right">Change</span>
          </div>

          <div className="flex-1 min-h-0 max-h-[420px] lg:max-h-[70vh] overflow-y-auto divide-y divide-zinc-100">
            {recentLogs.length === 0 ? (
              <div className="p-8 text-center flex flex-col gap-1">
                <p className="text-[13px] font-semibold text-zinc-700">
                  No scans in this session yet.
                </p>
                <p className="text-[13px] text-zinc-500">
                  Scanned items appear here with their before and after stock levels.
                </p>
              </div>
            ) : (
              recentLogs.map((log) =>
                log.unmatched ? (
                  <div
                    key={log.id}
                    className={`px-3 py-2.5 sm:px-4 sm:py-3 min-[1800px]:px-6 min-[1800px]:py-3 flex items-center justify-between gap-3 min-[1800px]:grid min-[1800px]:grid-cols-[80px_minmax(0,1fr)_180px_256px] min-[1800px]:gap-4 ${
                      log.resolved ? 'bg-white' : 'bg-amber-50/80'
                    }`}
                  >
                    <span className="hidden min-[1800px]:block text-[13px] text-zinc-600 tabular-nums">
                      {log.timeShort}
                    </span>

                    <div className="min-w-0 flex flex-col gap-0.5">
                      <span className="text-sm font-semibold text-zinc-950">Unknown barcode</span>
                      <span className="text-xs font-mono text-zinc-500 truncate">{log.barcode}</span>
                      <span
                        className={`min-[1800px]:hidden text-xs font-semibold ${
                          log.resolved ? 'text-emerald-700' : 'text-amber-700'
                        }`}
                      >
                        {log.resolved
                          ? 'Added to the catalogue · scan it again'
                          : `Not in catalogue · nothing saved · ${log.timeShort}`}
                      </span>
                    </div>

                    <div className="hidden min-[1800px]:flex">
                      {log.resolved ? (
                        <span className="h-[22px] px-2 rounded-full bg-emerald-50 text-emerald-700 text-xs font-semibold flex items-center">
                          Added to catalogue
                        </span>
                      ) : (
                        <span className="h-[22px] px-2 rounded-full bg-white border border-amber-200 text-amber-700 text-xs font-semibold flex items-center gap-1">
                          <TriangleAlert className="w-3 h-3" />
                          Not in catalogue
                        </span>
                      )}
                    </div>

                    <div className="flex items-center justify-end gap-3 flex-shrink-0">
                      <span className="hidden min-[1800px]:inline text-[13px] text-amber-800 whitespace-nowrap">
                        {log.resolved ? 'Scan it again' : 'Nothing saved'}
                      </span>
                      {!log.resolved && (
                        <button
                          type="button"
                          onClick={() => handleAddProductFor(log)}
                          disabled={isOpeningProductForm}
                          className="h-10 px-3 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-white text-[13px] font-semibold flex items-center gap-1.5 whitespace-nowrap disabled:opacity-60"
                        >
                          {isOpeningProductForm ? (
                            <LoaderCircle className="w-4 h-4 animate-spin text-emerald-400" />
                          ) : (
                            <PackagePlus className="w-4 h-4 text-emerald-400" />
                          )}
                          Add product
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div
                    key={log.id}
                    className="px-3 py-2.5 sm:px-4 sm:py-3 min-[1800px]:px-6 min-[1800px]:py-0 min-[1800px]:h-[68px] grid grid-cols-[minmax(0,1fr)_auto_auto] min-[1800px]:grid-cols-[80px_minmax(0,1fr)_180px_112px_128px] gap-2 sm:gap-3 min-[1800px]:gap-4 items-center hover:bg-zinc-50"
                  >
                    <span className="hidden min-[1800px]:block text-[13px] text-zinc-600 tabular-nums">
                      {log.timeShort}
                    </span>

                    <div className="min-w-0 flex flex-col gap-0.5">
                      <span className="text-sm font-semibold text-zinc-950 truncate">
                        {log.productName}
                      </span>
                      <span className="hidden min-[1800px]:block text-xs font-mono text-zinc-500 truncate">
                        {log.barcode}
                      </span>
                      <span className="min-[1800px]:hidden text-xs text-zinc-500 tabular-nums truncate">
                        {log.timeShort} · {log.reason}
                      </span>
                    </div>

                    <span className="hidden min-[1800px]:block text-[13px] text-zinc-700 truncate">
                      {log.reason}
                    </span>

                    <div className="flex items-baseline justify-end gap-1.5 text-[13px] sm:text-sm text-zinc-500 tabular-nums">
                      {/* The arrow reads as "right arrow" aloud, so spell the movement out once */}
                      <span className="sr-only">
                        Stock {log.before} to {log.after}
                      </span>
                      <span aria-hidden="true">{log.before}</span>
                      <span aria-hidden="true">→</span>
                      <span aria-hidden="true" className="font-bold text-zinc-950">
                        {log.after}
                      </span>
                    </div>

                    <div className="flex justify-end">
                      <span
                        className={`h-[22px] px-2 rounded-full text-xs font-bold tabular-nums flex items-center ${
                          log.change > 0
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'bg-rose-50 text-rose-700'
                        }`}
                      >
                        {log.change > 0 ? `+${log.change}` : log.change}
                      </span>
                    </div>
                  </div>
                ),
              )
            )}
          </div>

          <div className="px-3 py-3 sm:px-4 min-[1800px]:px-6 min-[1800px]:py-3.5 border-t border-zinc-100 text-xs sm:text-[13px] text-zinc-500">
            {/* Not a link: this screen has no way to navigate, so it must not look clickable */}
            This list is kept while Stock Scan stays open. Saved scans are also in{' '}
            <span className="font-semibold text-zinc-700">Movement History</span>.
          </div>
        </section>
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

      {/* Registering a barcode the catalogue has never seen, without leaving the receiving bench */}
      <ProductModal
        isOpen={productModalOpen}
        onClose={closeProductModal}
        onSave={handleSaveNewProduct}
        departments={departments}
        initialBarcode={pendingBarcode || undefined}
        onDepartmentCreated={async () => {
          await loadDepartments();
          await refreshData();
        }}
      />
    </div>
  );
};
