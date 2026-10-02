import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  ArrowRight,
  Banknote,
  Camera,
  Check,
  ChevronDown,
  CircleAlert,
  CreditCard,
  Keyboard,
  LayoutGrid,
  Minus,
  Percent,
  Plus,
  Receipt,
  ScanBarcode,
  Search,
  ShoppingBag,
  Sparkles,
  Trash2,
  TriangleAlert,
  Undo2,
  UserPlus,
  UserRound,
  X,
} from 'lucide-react';
import { Department, Product, CartItem, Sale } from '../types';
import { api, ApiError } from '../utils/api';
import type { StoreSettings } from '../utils/api';
import { computeTax, percentToRateBps } from '../utils/tax';
import { playScanSuccessSound, playPaymentSuccessSound, playScanErrorSound } from '../utils/audio';
import { BarcodeScannerModal } from '../components/BarcodeScannerModal';
import { ReceiptModal } from '../components/ReceiptModal';
import { ProductModal } from '../components/ProductModal';
import { UnregisteredProductDialog } from '../components/UnregisteredProductDialog';
import { useHardwareBarcodeScanner } from '../utils/barcodeListener';

interface POSPageProps {
  products: Product[];
  departments: Department[];
  refreshData: () => Promise<void>;
  cart: CartItem[];
  setCart: React.Dispatch<React.SetStateAction<CartItem[]>>;
  /** Owners and managers. The server refuses a cashier's new product, so don't offer one. */
  canRegisterProducts: boolean;
}

/** What the last scan did, so the cashier can see it and undo exactly that much. */
interface LastScan {
  productId: number;
  name: string;
  barcode: string;
  sku?: string;
  departmentName?: string;
  departmentColor?: string;
  delta: number;
  before: number;
  after: number;
  lineTotal: number;
  repeat: boolean;
}

/**
 * Inline replacements for the blocking alert()/confirm() dialogs. `unknown` is the
 * actionable one (offer to register the barcode); the rest time out on their own.
 */
interface ScanAlert {
  tone: 'unknown' | 'warn' | 'error';
  text: string;
  barcode?: string;
}

interface Toast {
  text: string;
  undo?: () => void;
}

const QTY_PER_SCAN = [1, 2, 5, 10];
/** Notes a Canadian till actually holds, narrowed to the ones that cover the sale. */
const CASH_NOTES = [5, 10, 15, 20, 50, 100];

const money = (amount: number) => `$${amount.toFixed(2)}`;

/** Keyboard key cap. Mono is allowed here (SPEC: barcodes, SKUs and key caps). */
const Kbd: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className = 'border-zinc-200 bg-white text-zinc-700',
}) => (
  <span
    className={`font-mono inline-flex flex-shrink-0 items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-md border border-b-2 text-[11px] font-semibold ${className}`}
  >
    {children}
  </span>
);

interface QuickAddTileProps {
  product: Product;
  inCart: number;
  onAdd: () => void;
  tall?: boolean;
}

/** One catalogue tile: default, in-order, low stock and out of stock (States.dc.html). */
const QuickAddTile: React.FC<QuickAddTileProps> = ({ product, inCart, onAdd, tall }) => {
  const isOut = product.stock_quantity <= 0;
  const isLow = !isOut && product.stock_quantity <= product.min_stock_level;
  const inOrder = inCart > 0;

  return (
    <button
      type="button"
      onClick={onAdd}
      disabled={isOut}
      aria-label={isOut ? `${product.name} — out of stock` : `Add ${product.name} to order`}
      className={`flex flex-col justify-between gap-2 p-3 text-left rounded-[14px] border transition-colors ${
        tall ? 'h-[104px]' : 'h-20 xl:h-24'
      } ${
        isOut
          ? 'border-dashed border-zinc-200 bg-zinc-50 cursor-not-allowed'
          : inOrder
          ? 'border-emerald-300 bg-emerald-50/60 hover:bg-emerald-50 active:scale-98'
          : 'border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50 active:scale-98'
      }`}
    >
      <div className="flex items-start justify-between gap-2 w-full min-w-0">
        <span
          className={`min-w-0 text-[13px] xl:text-sm leading-[18px] font-semibold line-clamp-2 ${
            isOut ? 'text-zinc-500' : 'text-zinc-950'
          }`}
        >
          {product.name}
        </span>
        {inOrder && !isOut && (
          <span className="flex-shrink-0 grid place-items-center min-w-[22px] xl:min-w-6 h-[22px] xl:h-6 px-1.5 rounded-full bg-emerald-600 text-white text-xs font-extrabold tabular-nums">
            {inCart}
          </span>
        )}
      </div>

      <div className="flex items-baseline justify-between gap-2 w-full min-w-0">
        <span
          className={`flex-shrink-0 text-[15px] xl:text-base font-bold tabular-nums ${
            isOut ? 'text-zinc-500' : 'text-zinc-950'
          }`}
        >
          {money(Number(product.price))}
        </span>
        {isOut ? (
          <span className="text-xs font-semibold text-rose-700">Out of stock</span>
        ) : isLow ? (
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="w-2 h-2 rounded-full bg-amber-600 flex-shrink-0" />
            <span className="text-xs font-semibold text-amber-700 tabular-nums truncate">
              {product.stock_quantity} left
            </span>
          </span>
        ) : (
          <span className="text-xs text-zinc-500 tabular-nums truncate">
            {product.stock_quantity} in stock
          </span>
        )}
      </div>
    </button>
  );
};

export const POSPage: React.FC<POSPageProps> = ({
  products,
  departments,
  refreshData,
  cart,
  setCart,
  canRegisterProducts,
}) => {
  const [selectedDeptId, setSelectedDeptId] = useState<number | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [showEmptyDepts, setShowEmptyDepts] = useState(false);
  const [qtyPerScan, setQtyPerScan] = useState(1);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [phoneTypeOpen, setPhoneTypeOpen] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [customerOpen, setCustomerOpen] = useState(false);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [discountInput, setDiscountInput] = useState('');
  const [cashTendered, setCashTendered] = useState('');
  const [isCharging, setIsCharging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [completedSale, setCompletedSale] = useState<Sale | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<LastScan | null>(null);
  const [scanAlert, setScanAlert] = useState<ScanAlert | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  // Two separate concerns that used to share one piece of state: the barcode
  // itself (which prefills the Add Product form) and whether the unknown-barcode
  // notice is on screen. Clearing the barcode to close the notice would have
  // emptied the form, so the notice used to stay up behind it.
  const [unregisteredBarcode, setUnregisteredBarcode] = useState<string | null>(null);
  const [productModalOpen, setProductModalOpen] = useState(false);
  // The barcode the "not registered" popup is asking about, while it is up.
  const [unknownPrompt, setUnknownPrompt] = useState<string | null>(null);
  // The code last answered "Not now" while the camera was open, so the camera still
  // resting on that item doesn't ask again every few seconds.
  const declinedCameraPromptRef = useRef<string | null>(null);
  // True while any field on this screen has focus; see `fieldFocus` below.
  const [scanFocused, setScanFocused] = useState(false);

  const scanInputRef = useRef<HTMLInputElement>(null);
  const alertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A second press must never reach the server while the first is in flight;
  // state alone updates too late to stop a double-tap.
  const chargingRef = useRef(false);

  // Tax rate comes from store settings; the server is the authority and will
  // refuse a checkout whose displayed total no longer matches its own maths.
  const [taxSettings, setTaxSettings] = useState<StoreSettings | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then((s) => {
        if (!cancelled) setTaxSettings(s);
      })
      .catch((err) => console.warn('Could not load store settings, using default tax rate', err));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      if (alertTimerRef.current) clearTimeout(alertTimerRef.current);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  // ---- money ---------------------------------------------------------------
  // Mirrors the server's integer-cent arithmetic exactly (lib/tax.ts): cents
  // per line, discount spread over the tax classes, GST/HST and PST rounded
  // once each. The displayed total is the one `expected_total` is checked against.
  const [discount, setDiscount] = useState(0);

  const totals = useMemo(() => {
    const subtotalCents = cart.reduce(
      (sum, item) => sum + Math.round(item.unit_price * 100) * item.quantity,
      0,
    );
    const discountCents = Math.min(Math.max(Math.round((discount + 1e-9) * 100), 0), subtotalCents);
    const rates = {
      gst_bps: percentToRateBps(taxSettings?.gst_rate_percent ?? 5),
      pst_bps: percentToRateBps(taxSettings?.pst_rate_percent ?? 0),
      hst: taxSettings?.hst ?? false,
    };
    const t = computeTax(
      cart.map((item) => ({
        gross_cents: Math.round(item.unit_price * 100) * item.quantity,
        tax_class: item.product.tax_class ?? 'STANDARD',
      })),
      discountCents,
      rates,
    );
    return {
      subtotal: subtotalCents / 100,
      discount: discountCents / 100,
      gstAmount: t.gst_cents / 100,
      pstAmount: t.pst_cents / 100,
      taxAmount: t.tax_cents / 100,
      total: t.total_cents / 100,
    };
  }, [cart, taxSettings, discount]);

  const { subtotal, taxAmount, gstAmount, pstAmount, total } = totals;
  const taxRate = taxSettings?.tax_rate_percent ?? 5;
  const gstLabel = taxSettings?.tax_labels.gst ?? 'Tax';
  const pstLabel = taxSettings?.tax_labels.pst ?? null;
  const gstRateShown = taxSettings ? (taxSettings.hst ? taxRate : taxSettings.gst_rate_percent) : taxRate;
  const appliedDiscount = totals.discount;
  const itemCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  /**
   * What the camera dialog shows for the line it just touched. Derived from the
   * cart rather than from the scan event, so stepping the quantity inside the
   * dialog updates the figure the dialog is displaying.
   */
  const scannedLine = useMemo(() => {
    if (!lastScan) return null;
    const line = cart.find((item) => item.product.id === lastScan.productId);
    if (!line) return null; // removed from the order while the camera was open
    return {
      name: line.product.name,
      sku: line.product.sku,
      unitPrice: line.unit_price,
      quantity: line.quantity,
      lineTotal: Math.round(line.unit_price * 100 * line.quantity) / 100,
    };
  }, [lastScan, cart]);

  const tenderedAmount = useMemo(() => {
    if (cashTendered.trim() === '') return total;
    const parsed = parseFloat(cashTendered);
    return Number.isFinite(parsed) ? parsed : NaN;
  }, [cashTendered, total]);

  const changeDue = useMemo(() => {
    if (!Number.isFinite(tenderedAmount) || tenderedAmount < total) return 0;
    return Math.round((tenderedAmount - total) * 100) / 100;
  }, [tenderedAmount, total]);

  const cashNotes = useMemo(() => CASH_NOTES.filter((note) => note >= total).slice(0, 3), [total]);

  // An order that empties must not keep a discount waiting for the next customer.
  useEffect(() => {
    if (cart.length === 0 && (discount !== 0 || discountOpen)) {
      setDiscount(0);
      setDiscountInput('');
      setDiscountOpen(false);
    }
  }, [cart.length, discount, discountOpen]);

  // Keep cart prices in step with the catalogue. When products refresh (after
  // a PRICE_CHANGED refusal, an edit, or another device's change), re-price
  // the cart lines so the register never shows a stale amount.
  useEffect(() => {
    setCart((prev) => {
      let changed = false;
      const next = prev.map((item) => {
        const fresh = products.find((p) => p.id === item.product.id);
        if (!fresh) return item;
        if (fresh.price !== item.unit_price || fresh.stock_quantity !== item.product.stock_quantity) {
          changed = true;
          return { ...item, product: fresh, unit_price: fresh.price };
        }
        return item;
      });
      return changed ? next : prev;
    });
  }, [products, setCart]);

  // ---- feedback ------------------------------------------------------------

  const showAlert = (alert: ScanAlert) => {
    if (alertTimerRef.current) clearTimeout(alertTimerRef.current);
    setScanAlert(alert);
    // The unknown-barcode notice is actionable, so it waits to be answered.
    if (alert.tone !== 'unknown') {
      alertTimerRef.current = setTimeout(() => setScanAlert(null), 5000);
    }
  };

  const dismissAlert = () => {
    if (alertTimerRef.current) clearTimeout(alertTimerRef.current);
    setScanAlert(null);
  };

  const showToast = (next: Toast, ms = 3500) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(next);
    toastTimerRef.current = setTimeout(() => setToast(null), ms);
  };

  /**
   * The scan field is only auto-focused where a hardware keyboard is the input.
   * On a touch tablet or phone stealing focus would raise the on-screen keyboard
   * over the order; the global wedge listener keeps scanning working there.
   */
  const focusScanField = () => {
    if (typeof window === 'undefined') return;
    if (!window.matchMedia('(min-width: 768px) and (pointer: fine)').matches) return;
    scanInputRef.current?.focus();
  };

  useEffect(() => {
    focusScanField();
  }, []);

  // The full prompt only fits the desktop field; anything narrower would clip it
  // mid-word, and a placeholder cannot be shortened with CSS.
  const [narrowScanField, setNarrowScanField] = useState(false);
  useEffect(() => {
    // 1600px is where the field stops being wide enough for the long prompt
    // once the pill and the key cap have taken their share.
    const mq = window.matchMedia('(max-width: 1599px)');
    const sync = () => setNarrowScanField(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // ---- cart ----------------------------------------------------------------

  /**
   * Adds `qty` of a product, clamped to what is actually on the shelf. Returns
   * how many made it onto the order so callers can tell a real scan from a
   * refused one instead of reporting success either way.
   */
  const addToCart = (product: Product, qty = 1): number => {
    if (chargingRef.current) {
      showAlert({ tone: 'warn', text: 'Finishing the current sale — wait for the receipt.' });
      return 0;
    }

    if (product.stock_quantity <= 0) {
      playScanErrorSound();
      showAlert({ tone: 'error', text: `"${product.name}" is out of stock.` });
      return 0;
    }

    const inCart = cart.find((item) => item.product.id === product.id)?.quantity || 0;
    const room = product.stock_quantity - inCart;
    if (room <= 0) {
      playScanErrorSound();
      showAlert({
        tone: 'error',
        text: `All ${product.stock_quantity} ${product.name} in stock are already in this order.`,
      });
      return 0;
    }

    const added = Math.min(qty, room);

    setCart((prev) => {
      const line = prev.find((item) => item.product.id === product.id);
      // Re-check against the freshest cart: the guard above read this render's
      // copy, which a rapid double-scan can already have passed.
      const already = line?.quantity || 0;
      const freshRoom = product.stock_quantity - already;
      if (freshRoom <= 0) return prev;
      const take = Math.min(qty, freshRoom);
      if (line) {
        return prev.map((item) =>
          item.product.id === product.id ? { ...item, quantity: item.quantity + take } : item,
        );
      }
      return [...prev, { product, quantity: take, unit_price: product.price }];
    });

    playScanSuccessSound();
    if (added < qty) {
      showAlert({
        tone: 'warn',
        text: `Only ${added} of ${product.name} left in stock — added ${added}, not ${qty}.`,
      });
    }
    return added;
  };

  /** Adds and records the scan so the feedback card and Undo have something to show. */
  const registerScan = (product: Product, qty: number): number => {
    const before = cart.find((item) => item.product.id === product.id)?.quantity || 0;
    // Clear the previous notice first so addToCart's own message (a partial add,
    // say) is the one left standing.
    if (scanAlert) dismissAlert();
    const added = addToCart(product, qty);
    if (added <= 0) return 0;
    setLastScan({
      productId: product.id,
      name: product.name,
      barcode: product.barcode,
      sku: product.sku,
      departmentName: product.department_name,
      departmentColor: product.department_color,
      delta: added,
      before,
      after: before + added,
      lineTotal: Math.round(product.price * (before + added) * 100) / 100,
      repeat: before > 0,
    });
    return added;
  };

  const updateQuantity = (productId: number, delta: number) => {
    if (chargingRef.current) return;
    const line = cart.find((item) => item.product.id === productId);
    if (line && delta > 0 && line.quantity + delta > line.product.stock_quantity) {
      playScanErrorSound();
      showAlert({
        tone: 'error',
        text: `All ${line.product.stock_quantity} ${line.product.name} in stock are already in this order.`,
      });
      return;
    }
    setCart((prev) =>
      prev
        .map((item) => {
          if (item.product.id !== productId) return item;
          const newQty = item.quantity + delta;
          if (newQty > item.product.stock_quantity) return item;
          return { ...item, quantity: newQty };
        })
        .filter((item) => item.quantity > 0),
    );
    if (lastScan?.productId === productId) setLastScan(null);
  };

  const removeFromCart = (productId: number) => {
    if (chargingRef.current) return;
    setCart((prev) => prev.filter((item) => item.product.id !== productId));
    if (lastScan?.productId === productId) setLastScan(null);
  };

  /** Clearing is reversible from the toast, so it needs no blocking confirm(). */
  const clearCart = () => {
    if (cart.length === 0 || chargingRef.current) return;
    const cleared = cart;
    const clearedCount = itemCount;
    setCart([]);
    setLastScan(null);
    dismissAlert();
    showToast(
      {
        text: `Order cleared · ${clearedCount} item${clearedCount === 1 ? '' : 's'}`,
        undo: () => {
          setCart(cleared);
          setToast(null);
        },
      },
      8000,
    );
  };

  const undoLastScan = () => {
    if (!lastScan || chargingRef.current) return;
    const { productId, delta } = lastScan;
    setCart((prev) =>
      prev
        .map((item) => (item.product.id === productId ? { ...item, quantity: item.quantity - delta } : item))
        .filter((item) => item.quantity > 0),
    );
    setLastScan(null);
    focusScanField();
  };

  // ---- scanning ------------------------------------------------------------

  const flagUnknownBarcode = (code: string, fromCamera = false) => {
    playScanErrorSound();
    setUnregisteredBarcode(code);
    showAlert({ tone: 'unknown', text: `No product has barcode ${code}`, barcode: code });
    // Ask straight away. A deliberate scan always asks; only the camera re-reading the
    // item that was just answered "Not now" stays quiet. The banner still offers it.
    if (!(fromCamera && declinedCameraPromptRef.current === code)) {
      setUnknownPrompt(code);
    }
  };

  /**
   * Every scan counts. The camera dialog already holds the same code for 3s, and
   * one wedge trigger is one Enter, so a second pass of the same bottle is a real
   * second bottle — it must ring up, not be swallowed.
   */
  const handleBarcodeScanned = (barcode: string, fromCamera = false) => {
    const clean = barcode.trim();
    if (!clean) return { accepted: false };

    const found = products.find((p) => p.barcode === clean);
    if (!found) {
      flagUnknownBarcode(clean, fromCamera);
      return {
        accepted: false,
        message: canRegisterProducts
          ? `No product has barcode ${clean}. Register it or keep scanning.`
          : `No product has barcode ${clean}. Ask a manager to add it.`,
      };
    }
    // A wedge scan of a known item means the cashier has moved on from the question.
    setUnknownPrompt(null);

    const added = registerScan(found, qtyPerScan);
    if (added <= 0) {
      return {
        accepted: false,
        message:
          found.stock_quantity <= 0
            ? `"${found.name}" is out of stock.`
            : `All ${found.stock_quantity} ${found.name} in stock are already in this order.`,
      };
    }
    return { accepted: true };
  };

  // Active hardware wedge listener. Off while the scan field has focus: there the
  // field itself receives the scan and Enter submits it, so the code is complete.
  // Off while the product form is open too: the form reads scans into its own barcode
  // field, and this listener would otherwise ring the same scan up behind it.
  useHardwareBarcodeScanner(handleBarcodeScanned, !scanFocused && !productModalOpen);

  /** Enter in the scan field: a barcode, an SKU, or a name that matches one item. */
  const submitScan = () => {
    const query = searchQuery.trim();
    if (!query) return;

    const lower = query.toLowerCase();
    let found = products.find((p) => p.barcode === query);
    if (!found) found = products.find((p) => (p.sku || '').toLowerCase() === lower);
    if (!found) {
      const matches = products.filter(
        (p) =>
          p.name.toLowerCase().includes(lower) ||
          p.barcode.includes(query) ||
          (p.sku || '').toLowerCase().includes(lower),
      );
      if (matches.length === 1) found = matches[0];
    }

    if (found) {
      if (registerScan(found, qtyPerScan) > 0) setSearchQuery('');
      return;
    }

    if (/^\d{6,}$/.test(query)) {
      flagUnknownBarcode(query);
      return;
    }
    playScanErrorSound();
    showAlert({ tone: 'warn', text: `No product matches "${query}". Refine it or pick one below.` });
  };

  // Enter is handled on the key, not on implicit form submission, so a wedge
  // scanner's trailing Enter always reaches the same path in every browser.
  const handleScanKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    submitScan();
  };

  /**
   * Any focused field owns the keyboard: the global wedge listener is switched
   * off so one scan cannot be read twice, once by the field and once by the
   * listener (which drops the first character when an input has focus).
   */
  const fieldFocus = {
    onFocus: () => setScanFocused(true),
    onBlur: () => setScanFocused(false),
  };

  // Open the camera scanner, safely dismissing any virtual keyboard first.
  const handleOpenScanner = () => {
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setScannerOpen(true);
  };

  const openProductRegistration = () => {
    setScannerOpen(false);
    dismissAlert();
    setProductModalOpen(true);
  };

  // ---- catalogue -----------------------------------------------------------

  /**
   * Chip counts come from the catalogue actually loaded here, which is the active
   * one. The server's department count includes archived products, so it used to
   * offer departments that open empty.
   */
  const departmentCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const p of products) counts.set(p.department_id, (counts.get(p.department_id) || 0) + 1);
    return counts;
  }, [products]);

  const stockedDepartments = departments.filter((d) => (departmentCounts.get(d.id) || 0) > 0);
  const emptyDepartments = departments.filter((d) => (departmentCounts.get(d.id) || 0) === 0);
  const visibleDepartments = showEmptyDepts ? departments : stockedDepartments;

  const filteredProducts = useMemo(() => {
    const lower = searchQuery.trim().toLowerCase();
    return products
      .filter((p) => {
        const matchesDept = selectedDeptId === 'ALL' || p.department_id === selectedDeptId;
        const matchesSearch =
          !lower ||
          p.name.toLowerCase().includes(lower) ||
          p.barcode.includes(searchQuery.trim()) ||
          (p.sku || '').toLowerCase().includes(lower);
        return matchesDept && matchesSearch;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [products, selectedDeptId, searchQuery]);

  const cartQtyFor = (productId: number) => cart.find((i) => i.product.id === productId)?.quantity || 0;

  // ---- catalogue writes ----------------------------------------------------

  // A refusal (no permission, a barcode an archived product still owns) is left to throw:
  // the form shows it and stays open with what was typed. Caught here, the form closed
  // and the message was cleared in the same tick, so a failed save looked like nothing.
  const handleSaveNewProduct = async (productData: Partial<Product>) => {
    try {
      setIsProcessing(true);
      const created = await api.createProduct(productData);
      await refreshData();
      setProductModalOpen(false);
      dismissAlert();
      setUnregisteredBarcode(null);
      declinedCameraPromptRef.current = null;
      // Automatically add the newly registered product. addToCart owns the scan
      // sound, so don't claim the line landed when it refused it.
      const added = registerScan(created, qtyPerScan);
      showToast({
        text: added > 0 ? `"${created.name}" registered and added` : `"${created.name}" registered`,
      });
      focusScanField();
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSeedBeverages = async () => {
    try {
      setIsProcessing(true);
      const bevDept = departments.find((d) => d.code === 'BEV') || departments[0];
      const deptId = bevDept?.id || 1;
      const samples = [
        {
          name: 'Spring Mineral Water 500ml',
          barcode: '8901030382901',
          sku: 'BEV-101',
          price: 1.5,
          cost_price: 0.6,
          stock_quantity: 48,
          min_stock_level: 10,
          department_id: deptId,
          unit: 'bottle',
        },
        {
          name: 'Sparkling Mineral Water 750ml',
          barcode: '8901030382902',
          sku: 'BEV-102',
          price: 2.75,
          cost_price: 1.1,
          stock_quantity: 36,
          min_stock_level: 8,
          department_id: deptId,
          unit: 'bottle',
        },
        {
          name: 'Coca-Cola 500ml Bottle',
          barcode: '5449000000996',
          sku: 'BEV-103',
          price: 2.25,
          cost_price: 0.95,
          stock_quantity: 60,
          min_stock_level: 12,
          department_id: deptId,
          unit: 'bottle',
        },
        {
          name: 'Orange Juice 350ml Bottle',
          barcode: '8901030382904',
          sku: 'BEV-104',
          price: 3.5,
          cost_price: 1.6,
          stock_quantity: 24,
          min_stock_level: 6,
          department_id: deptId,
          unit: 'bottle',
        },
        {
          name: 'Iced Green Tea 500ml',
          barcode: '8901030382905',
          sku: 'BEV-105',
          price: 2.5,
          cost_price: 1.0,
          stock_quantity: 30,
          min_stock_level: 8,
          department_id: deptId,
          unit: 'bottle',
        },
      ];

      for (const item of samples) {
        await api.createProduct(item);
      }

      await refreshData();
      playScanSuccessSound();
      showToast({ text: 'Sample bottles & beverages added to the catalogue' });
    } catch (err: any) {
      console.error('Error seeding beverages:', err);
      showAlert({ tone: 'error', text: 'Could not load sample beverages: ' + err.message });
    } finally {
      setIsProcessing(false);
    }
  };

  // ---- checkout ------------------------------------------------------------

  /**
   * One press completes the sale. The server still recomputes every amount and
   * refuses the order if `expected_total` no longer matches, so the panel is a
   * faster way to reach the same guarded call — not a shortcut past it.
   */
  const handleCharge = async (method: 'CASH' | 'CARD') => {
    if (cart.length === 0 || chargingRef.current) return;
    setCheckoutError(null);

    const tendered = method === 'CASH' ? tenderedAmount : total;
    if (method === 'CASH' && (!Number.isFinite(tendered) || tendered < total)) {
      setCheckoutError(`Cash received must be at least ${money(total)}.`);
      return;
    }

    chargingRef.current = true;
    setIsCharging(true);
    try {
      const saleResult = await api.checkout({
        items: cart.map((item) => ({
          product_id: item.product.id,
          barcode: item.product.barcode,
          quantity: item.quantity,
          unit_price: item.unit_price,
        })),
        subtotal,
        tax_rate: taxRate,
        tax_amount: taxAmount,
        discount: appliedDiscount,
        total,
        expected_total: total,
        payment_method: method,
        amount_paid: method === 'CASH' ? tendered : total,
        customer_name: customerName.trim() || 'Walk-in Customer',
      });

      playPaymentSuccessSound();
      setCompletedSale(saleResult);
      setCart([]);
      setCustomerName('');
      setCustomerOpen(false);
      setCashTendered('');
      setDiscount(0);
      setDiscountInput('');
      setDiscountOpen(false);
      setLastScan(null);
      setBrowseOpen(false);
      dismissAlert();
      setReceiptOpen(true);

      // Refresh product stock and movements
      await refreshData();
      focusScanField();
    } catch (err: any) {
      playScanErrorSound();
      if (err instanceof ApiError && (err.code === 'PRICE_CHANGED' || err.code === 'INSUFFICIENT_STOCK')) {
        // Pull the current catalogue; the cart re-prices itself via the
        // products effect above, and the cashier confirms the new total.
        setCheckoutError(`${err.message} The order has been updated with current prices and stock.`);
        try {
          await refreshData();
          setTaxSettings(await api.getSettings());
        } catch (refreshErr) {
          console.warn('Refresh after checkout conflict failed', refreshErr);
        }
        return;
      }
      setCheckoutError(err.message || 'Checkout failed. Please review stock availability.');
    } finally {
      chargingRef.current = false;
      setIsCharging(false);
    }
  };

  // ---- shortcuts -----------------------------------------------------------
  // Held in refs so the window listener is registered once and never reads a
  // stale cart or total.
  const chargeRef = useRef(handleCharge);
  chargeRef.current = handleCharge;
  const clearSearchRef = useRef<() => void>(() => {});
  clearSearchRef.current = () => {
    if (searchQuery) setSearchQuery('');
    else if (browseOpen) setBrowseOpen(false);
  };
  // A dialog owns the keyboard while it is up: no charging behind the camera,
  // the product form or the receipt.
  const modalOpenRef = useRef(false);
  modalOpenRef.current = scannerOpen || productModalOpen || receiptOpen || unknownPrompt !== null;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (modalOpenRef.current) return;
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      if (e.key === 'F8' || e.key === 'F9') {
        e.preventDefault();
        chargeRef.current(e.key === 'F8' ? 'CASH' : 'CARD');
        return;
      }
      if (e.key === 'Escape') {
        clearSearchRef.current();
        return;
      }
      if (e.key === '/' && !typing) {
        e.preventDefault();
        scanInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // ---- render helpers ------------------------------------------------------

  const orderLines = useMemo(() => [...cart].reverse(), [cart]);
  const catalogueEmpty = products.length === 0;

  const departmentChips = (
    <>
      <button
        type="button"
        onClick={() => setSelectedDeptId('ALL')}
        aria-pressed={selectedDeptId === 'ALL'}
        className={`flex-shrink-0 inline-flex items-center gap-2 h-9 px-3.5 rounded-lg text-[13px] font-semibold transition-colors ${
          selectedDeptId === 'ALL'
            ? 'bg-zinc-900 text-white'
            : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200/70'
        }`}
      >
        <span>All</span>
        <span
          className={`text-xs tabular-nums ${selectedDeptId === 'ALL' ? 'text-zinc-400' : 'text-zinc-500'}`}
        >
          {products.length}
        </span>
      </button>

      {visibleDepartments.map((dept) => {
        const count = departmentCounts.get(dept.id) || 0;
        const isSelected = selectedDeptId === dept.id;
        return (
          <button
            key={dept.id}
            type="button"
            onClick={() => setSelectedDeptId(dept.id)}
            aria-pressed={isSelected}
            className={`flex-shrink-0 inline-flex items-center gap-2 h-9 px-3.5 rounded-lg text-[13px] font-semibold transition-colors ${
              isSelected ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200/70'
            } ${count === 0 ? 'opacity-60' : ''}`}
          >
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: dept.color || '#4f46e5' }}
            />
            <span className="whitespace-nowrap">{dept.name}</span>
            <span className={`text-xs tabular-nums ${isSelected ? 'text-zinc-400' : 'text-zinc-500'}`}>
              {count}
            </span>
          </button>
        );
      })}

      {emptyDepartments.length > 0 && (
        <button
          type="button"
          onClick={() => setShowEmptyDepts((v) => !v)}
          className="flex-shrink-0 px-1 text-xs text-zinc-500 hover:text-zinc-900 whitespace-nowrap"
        >
          {showEmptyDepts ? (
            'Hide empty'
          ) : (
            <>
              {emptyDepartments.length} empty
              <span className="hidden xl:inline">
                {' '}
                department{emptyDepartments.length === 1 ? '' : 's'}
              </span>{' '}
              hidden
            </>
          )}
        </button>
      )}
    </>
  );

  const catalogueEmptyState = (
    <div className="p-6 xl:p-8 text-center space-y-3">
      <div className="w-12 h-12 rounded-2xl bg-zinc-100 text-zinc-500 flex items-center justify-center mx-auto">
        <ShoppingBag className="w-6 h-6" />
      </div>
      <div>
        <h3 className="text-sm font-bold text-zinc-900">Your catalogue is empty</h3>
        <p className="text-xs text-zinc-500 max-w-xs mx-auto mt-1">
          Scan any bottle or item barcode to register it, or load the sample retail beverages.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
        {canRegisterProducts && (
          <button
            type="button"
            onClick={() => {
              setUnregisteredBarcode('');
              setProductModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 h-10 px-4 bg-zinc-900 hover:bg-zinc-800 text-white text-[13px] font-semibold rounded-xl shadow-xs transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>Add new product</span>
          </button>
        )}
        <button
          type="button"
          onClick={handleSeedBeverages}
          disabled={isProcessing}
          className="inline-flex items-center gap-1.5 h-10 px-4 bg-emerald-50 text-emerald-800 border border-emerald-200 hover:bg-emerald-100 disabled:opacity-60 text-[13px] font-semibold rounded-xl transition-colors"
        >
          <Sparkles className="w-4 h-4 text-emerald-600" />
          <span>{isProcessing ? 'Adding…' : 'Load sample bottles & drinks'}</span>
        </button>
      </div>
    </div>
  );

  const tileGrid = (tall: boolean) => (
    <div className="grid grid-cols-2 gap-2 xl:gap-3">
      {filteredProducts.map((p) => (
        <QuickAddTile
          key={p.id}
          product={p}
          inCart={cartQtyFor(p.id)}
          tall={tall}
          onAdd={() => registerScan(p, 1)}
        />
      ))}
    </div>
  );

  const noMatches = !catalogueEmpty && filteredProducts.length === 0;

  const noMatchesState = (
    <div className="p-6 text-center">
      <p className="text-[13px] font-semibold text-zinc-700">No items match</p>
      <p className="text-xs text-zinc-500 mt-0.5">
        Try another name or SKU, or choose All to see the whole catalogue.
      </p>
    </div>
  );

  // ---- pay card ------------------------------------------------------------

  const payCard = (
    <section
      className="sticky bottom-0 z-10 md:static md:z-auto flex-shrink-0 p-3.5 md:p-4 xl:p-6 rounded-2xl bg-zinc-950 text-white shadow-[0_12px_32px_-12px_rgba(9,9,11,0.45)] flex flex-col gap-3 md:gap-3.5 xl:gap-4"
      aria-label="Payment"
    >
      {/* Desktop and tablet: the full breakdown */}
      <div className="hidden md:flex flex-col gap-1.5 xl:gap-2 text-[13px] xl:text-sm leading-5 text-zinc-400">
        <div className="flex items-center justify-between gap-3">
          <span>Subtotal</span>
          <span className="font-semibold text-zinc-100 tabular-nums">{money(subtotal)}</span>
        </div>

        <div className="flex items-center justify-between gap-3 min-h-[28px]">
          <span>Discount</span>
          {discountOpen ? (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-zinc-400">$</span>
              <input
                type="number"
                step="0.01"
                min="0"
                max={subtotal}
                value={discountInput}
                autoFocus
                {...fieldFocus}
                onChange={(e) => {
                  setDiscountInput(e.target.value);
                  const parsed = parseFloat(e.target.value);
                  setDiscount(Number.isFinite(parsed) && parsed > 0 ? parsed : 0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setDiscountOpen(false);
                }}
                aria-label="Discount amount"
                className="w-24 h-9 px-2.5 rounded-lg bg-white/5 border border-white/15 text-right text-[13px] font-semibold text-white tabular-nums outline-none focus:border-emerald-400"
              />
              <button
                type="button"
                onClick={() => {
                  setDiscount(0);
                  setDiscountInput('');
                  setDiscountOpen(false);
                }}
                aria-label="Remove discount"
                className="w-9 h-9 grid place-items-center rounded-lg text-zinc-400 hover:text-white hover:bg-white/10"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : appliedDiscount > 0 ? (
            <button
              type="button"
              onClick={() => setDiscountOpen(true)}
              className="flex items-center gap-2 text-[13px] font-semibold text-emerald-400 hover:text-emerald-300"
            >
              <span className="tabular-nums">−{money(appliedDiscount)}</span>
              <span className="text-xs text-zinc-400 underline underline-offset-2">Change</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setDiscountOpen(true)}
              disabled={cart.length === 0}
              className="flex items-center gap-1.5 text-[13px] font-semibold text-emerald-400 hover:text-emerald-300 disabled:text-zinc-500 disabled:cursor-not-allowed"
            >
              <Percent className="w-3.5 h-3.5" />
              <span>Add discount</span>
            </button>
          )}
        </div>

        <div className="flex items-center justify-between gap-3">
          <span>
            {gstLabel} ({gstRateShown}%)
          </span>
          <span className="text-zinc-100 tabular-nums">{money(gstAmount)}</span>
        </div>
        {pstLabel && (
          <div className="flex items-center justify-between gap-3">
            <span>
              {pstLabel} ({taxSettings?.pst_rate_percent}%)
            </span>
            <span className="text-zinc-100 tabular-nums">{money(pstAmount)}</span>
          </div>
        )}
      </div>

      {/* Total due */}
      <div className="flex items-end justify-between gap-3 md:pt-3 xl:pt-4 md:border-t md:border-white/10">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-zinc-400">
            Total due
          </span>
          <span className="text-2xl md:text-4xl xl:text-5xl xl:leading-[52px] font-extrabold tracking-[-0.02em] text-white tabular-nums">
            {money(total)}
          </span>
        </div>
        <div className="flex flex-col items-end gap-0.5 pb-1 text-xs md:text-[13px] text-zinc-400 tabular-nums">
          <span className="md:hidden">
            {money(subtotal)}
            {appliedDiscount > 0 ? ` − ${money(appliedDiscount)}` : ''} + {money(taxAmount)} tax
          </span>
          <span>
            {itemCount} item{itemCount === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      {checkoutError && (
        <div
          role="status"
          className="flex items-start gap-2 p-3 rounded-xl bg-rose-950/60 border border-rose-800 text-[13px] leading-5 text-rose-200"
        >
          <CircleAlert className="w-4 h-4 flex-shrink-0 mt-0.5 text-rose-400" />
          <span className="min-w-0">{checkoutError}</span>
        </div>
      )}

      {/* Tenders */}
      {isCharging ? (
        <div className="flex flex-col gap-2">
          <div
            aria-busy="true"
            className="h-12 md:h-14 xl:h-16 px-5 rounded-2xl bg-zinc-900 border border-white/10 flex items-center gap-3 text-base font-bold text-white"
          >
            <span
              className="w-4 h-4 rounded-full border-2 border-zinc-600 border-t-white animate-spin"
              aria-hidden="true"
            />
            <span>Charging…</span>
          </div>
          <span className="text-xs text-zinc-400">
            Locked until the server confirms — no double charges
          </span>
        </div>
      ) : cart.length === 0 ? (
        <div
          aria-disabled="true"
          className="h-12 md:h-14 xl:h-16 rounded-2xl border border-dashed border-white/20 bg-white/5 flex items-center justify-center gap-2.5 text-[15px] font-semibold text-zinc-400"
        >
          <ScanBarcode className="w-[18px] h-[18px]" />
          <span>Scan an item to start</span>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 xl:gap-3">
          <button
            type="button"
            onClick={() => handleCharge('CASH')}
            className="h-12 md:h-14 xl:h-16 px-3.5 xl:pl-[18px] rounded-2xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 flex items-center justify-center xl:justify-between gap-2.5 transition-colors active:scale-98"
          >
            <span className="flex items-center gap-2.5">
              <Banknote className="w-5 h-5 xl:w-[22px] xl:h-[22px]" />
              <span className="text-base xl:text-[17px] font-bold">Cash</span>
            </span>
            <Kbd className="hidden xl:inline-flex border-zinc-950/10 bg-zinc-950/10 text-emerald-950">
              F8
            </Kbd>
          </button>
          <button
            type="button"
            onClick={() => handleCharge('CARD')}
            className="h-12 md:h-14 xl:h-16 px-3.5 xl:pl-[18px] rounded-2xl bg-white hover:bg-zinc-100 text-zinc-950 flex items-center justify-center xl:justify-between gap-2.5 transition-colors active:scale-98"
          >
            <span className="flex items-center gap-2.5">
              <CreditCard className="w-5 h-5 xl:w-[22px] xl:h-[22px]" />
              <span className="text-base xl:text-[17px] font-bold">Card</span>
            </span>
            <Kbd className="hidden xl:inline-flex border-zinc-200 bg-zinc-100 text-zinc-600">F9</Kbd>
          </button>
        </div>
      )}

      {/* Cash received */}
      {cart.length > 0 && !isCharging && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-zinc-400">
              Cash received
            </span>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-zinc-400">$</span>
              <input
                type="number"
                step="0.01"
                min={total}
                value={cashTendered}
                onChange={(e) => setCashTendered(e.target.value)}
                {...fieldFocus}
                placeholder={total.toFixed(2)}
                aria-label="Cash received"
                className="w-24 h-9 px-2.5 rounded-lg bg-white/5 border border-white/15 text-right text-[13px] font-semibold text-white tabular-nums outline-none focus:border-emerald-400 placeholder:text-zinc-500"
              />
            </div>
          </div>
          <div className="grid grid-cols-4 gap-2">
            <button
              type="button"
              onClick={() => setCashTendered('')}
              aria-pressed={cashTendered.trim() === ''}
              className={`h-11 rounded-xl border text-sm font-semibold transition-colors ${
                cashTendered.trim() === ''
                  ? 'border-emerald-400 bg-emerald-400/15 text-white'
                  : 'border-white/15 bg-white/5 text-white hover:bg-white/10'
              }`}
            >
              Exact
            </button>
            {cashNotes.map((note) => (
              <button
                key={note}
                type="button"
                onClick={() => setCashTendered(note.toFixed(2))}
                aria-pressed={cashTendered === note.toFixed(2)}
                className={`h-11 rounded-xl border text-sm font-semibold tabular-nums transition-colors ${
                  cashTendered === note.toFixed(2)
                    ? 'border-emerald-400 bg-emerald-400/15 text-white'
                    : 'border-white/15 bg-white/5 text-white hover:bg-white/10'
                }`}
              >
                ${note}
              </button>
            ))}
          </div>
          {changeDue > 0 && (
            <span className="text-[13px] font-semibold text-emerald-400 tabular-nums">
              Change due {money(changeDue)}
            </span>
          )}
          {Number.isFinite(tenderedAmount) && tenderedAmount < total && (
            <span className="text-[13px] font-semibold text-amber-400 tabular-nums">
              {money(total - tenderedAmount)} short of the total
            </span>
          )}
        </div>
      )}
    </section>
  );

  // ---- page ----------------------------------------------------------------

  return (
    <div
      className="w-full max-w-full min-w-0 flex flex-col overflow-y-auto md:overflow-hidden px-3 py-3 md:p-4 xl:p-6 h-[calc(100dvh_-_137px_-_env(safe-area-inset-bottom,0px)_-_var(--admin-banner,0px))] md:h-[calc(100dvh_-_1.5rem_-_var(--admin-banner,0px))]"
    >
      <div className="flex-1 min-h-full md:min-h-0 md:h-full flex flex-col md:flex-row gap-3 md:gap-4 xl:gap-5 min-w-0">
        {/* ------------------------------------------------ the order column */}
        <div className="flex-1 min-w-0 flex flex-col gap-3 md:gap-3.5 xl:gap-4 md:min-h-0">
          {/* Persistent scan field */}
          <section className="flex-shrink-0 bg-white border border-zinc-200/80 rounded-2xl shadow-xs p-3 xl:p-4 flex flex-col gap-2.5 xl:gap-3">
            {/* Phone: the camera leads, typing is behind a key */}
            <div className="flex md:hidden gap-2.5">
              <button
                type="button"
                onClick={handleOpenScanner}
                className="flex-1 h-[52px] rounded-xl bg-zinc-900 hover:bg-zinc-800 text-white flex items-center justify-center gap-2.5 shadow-sm active:scale-98 transition-transform"
              >
                <Camera className="w-5 h-5 text-emerald-400" />
                <span className="text-[15px] font-bold">Scan with camera</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setPhoneTypeOpen((v) => !v);
                  window.setTimeout(() => scanInputRef.current?.focus(), 0);
                }}
                aria-label="Type a barcode or name"
                aria-expanded={phoneTypeOpen}
                className={`w-[52px] h-[52px] flex-shrink-0 rounded-xl border flex items-center justify-center transition-colors ${
                  phoneTypeOpen
                    ? 'border-zinc-900 bg-zinc-900 text-white'
                    : 'border-zinc-200 bg-white text-zinc-700'
                }`}
              >
                <Keyboard className="w-5 h-5" />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitScan();
              }}
              className={`${phoneTypeOpen ? 'flex' : 'hidden'} md:flex gap-2.5`}
            >
              <div className="flex-1 min-w-0 h-[52px] xl:h-14 pl-3.5 xl:pl-4 pr-2.5 rounded-xl bg-white border border-zinc-300 focus-within:border-zinc-900 focus-within:ring-1 focus-within:ring-zinc-900 flex items-center gap-2.5 xl:gap-3 transition-colors">
                <Keyboard className="w-5 h-5 text-zinc-600 flex-shrink-0" />
                <input
                  ref={scanInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={handleScanKeyDown}
                  {...fieldFocus}
                  placeholder={
                    narrowScanField ? 'Ready for scan…' : 'Ready for scan… or type a name, SKU or barcode'
                  }
                  aria-label="Scan or search"
                  autoComplete="off"
                  className="flex-1 min-w-0 bg-transparent outline-none font-mono text-sm xl:text-[15px] font-medium text-zinc-950 placeholder:text-zinc-500 placeholder:font-normal"
                />
                {searchQuery ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      focusScanField();
                    }}
                    aria-label="Clear search"
                    className="w-10 h-10 flex-shrink-0 grid place-items-center rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100"
                  >
                    <X className="w-4 h-4" />
                  </button>
                ) : (
                  <span className="hidden md:flex flex-shrink-0 items-center gap-1.5 h-7 px-2.5 rounded-full bg-emerald-50 text-emerald-700 text-xs font-semibold">
                    <span className="w-2 h-2 rounded-full bg-emerald-500" />
                    <span className="xl:hidden">Ready</span>
                    <span className="hidden xl:inline">Ready to scan</span>
                  </span>
                )}
                <Kbd className="hidden xl:inline-flex border-zinc-200 bg-zinc-50 text-zinc-600">/</Kbd>
              </div>

              <button
                type="button"
                onClick={handleOpenScanner}
                aria-label="Scan with camera"
                className="hidden md:flex flex-shrink-0 w-[52px] xl:w-auto h-[52px] xl:h-14 xl:px-[18px] rounded-xl bg-white border border-zinc-200 hover:bg-zinc-50 text-zinc-900 items-center justify-center gap-2 transition-colors"
              >
                <Camera className="w-5 h-5 xl:w-[18px] xl:h-[18px] text-zinc-600" />
                <span className="hidden xl:inline text-sm font-semibold">Camera</span>
              </button>
            </form>

            {/* Qty per scan: a case of six is one scan, not six */}
            <div className="flex items-center justify-between md:justify-start gap-3">
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-zinc-600">
                Qty per scan
              </span>
              <div className="flex items-center gap-1.5">
                {QTY_PER_SCAN.map((qty) => (
                  <button
                    key={qty}
                    type="button"
                    onClick={() => setQtyPerScan(qty)}
                    aria-label={`${qty} per scan`}
                    aria-pressed={qtyPerScan === qty}
                    className={`w-10 h-10 rounded-lg text-sm font-bold tabular-nums transition-colors ${
                      qtyPerScan === qty
                        ? 'bg-zinc-900 text-white'
                        : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200/70'
                    }`}
                  >
                    {qty}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* Inline scan notices — nothing here blocks the next scan */}
          {scanAlert && (
            <div
              role="status"
              className={`flex-shrink-0 flex items-start gap-3 p-3.5 rounded-xl border animate-in fade-in slide-in-from-top-2 ${
                scanAlert.tone === 'error'
                  ? 'bg-rose-50 border-rose-200'
                  : 'bg-amber-50 border-amber-200'
              }`}
            >
              {scanAlert.tone === 'error' ? (
                <CircleAlert className="w-5 h-5 flex-shrink-0 text-rose-600" />
              ) : (
                <TriangleAlert className="w-5 h-5 flex-shrink-0 text-amber-600" />
              )}

              <div className="flex-1 min-w-0 flex flex-col gap-3">
                <div className="flex flex-col gap-0.5">
                  <p
                    className={`text-sm leading-5 font-semibold ${
                      scanAlert.tone === 'error' ? 'text-rose-700' : 'text-amber-800'
                    }`}
                  >
                    {scanAlert.barcode ? (
                      <>
                        No product has barcode{' '}
                        <span className="font-mono">{scanAlert.barcode}</span>
                      </>
                    ) : (
                      scanAlert.text
                    )}
                  </p>
                  {scanAlert.tone === 'unknown' && (
                    <p className="text-[13px] leading-5 text-amber-800">
                      {canRegisterProducts
                        ? 'Scanning continues. Register it now or keep going.'
                        : 'Scanning continues. Ask a manager to add it in Inventory.'}
                    </p>
                  )}
                </div>

                {scanAlert.tone === 'unknown' && (
                  <div className="flex items-center gap-2">
                    {canRegisterProducts && (
                      <button
                        type="button"
                        onClick={openProductRegistration}
                        className="inline-flex items-center gap-1.5 h-10 px-3.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-white text-[13px] font-semibold transition-colors"
                      >
                        <Plus className="w-4 h-4" />
                        <span>Register product</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        dismissAlert();
                        setUnregisteredBarcode(null);
                        // The code was typed into the field, where it would go on
                        // filtering Quick add to nothing.
                        if (searchQuery.trim() === scanAlert.barcode) setSearchQuery('');
                        focusScanField();
                      }}
                      className="h-10 px-3.5 rounded-xl text-[13px] font-semibold text-amber-800 hover:bg-amber-100 transition-colors"
                    >
                      Dismiss
                    </button>
                  </div>
                )}
              </div>

              {scanAlert.tone !== 'unknown' && (
                <button
                  type="button"
                  onClick={dismissAlert}
                  aria-label="Dismiss message"
                  className={`w-10 h-10 flex-shrink-0 grid place-items-center rounded-lg ${
                    scanAlert.tone === 'error'
                      ? 'text-rose-600 hover:bg-rose-100'
                      : 'text-amber-700 hover:bg-amber-100'
                  }`}
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          )}

          {/* Last scanned */}
          {lastScan && (
            <div className="flex-shrink-0 bg-white border border-emerald-300 rounded-2xl shadow-md ring-1 ring-emerald-400/20 animate-in fade-in slide-in-from-top-2">
              {/* Phone */}
              <div className="flex md:hidden items-center gap-2.5 p-2.5 pl-3">
                <span className="w-8 h-8 flex-shrink-0 rounded-full bg-emerald-50 text-emerald-600 grid place-items-center">
                  <Check className="w-4 h-4 stroke-[2.5]" />
                </span>
                <div className="flex-1 min-w-0 flex flex-col">
                  <span className="text-sm font-semibold text-zinc-950 truncate">{lastScan.name}</span>
                  <span className="text-xs font-medium text-emerald-700 tabular-nums">
                    {lastScan.repeat ? 'Scanned again' : 'Added'} · now {lastScan.after}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={undoLastScan}
                  className="h-10 px-2.5 flex-shrink-0 rounded-xl text-[13px] font-semibold text-zinc-700 hover:bg-zinc-100 flex items-center gap-1.5"
                >
                  <Undo2 className="w-4 h-4" />
                  <span>Undo</span>
                </button>
              </div>

              {/* Tablet and desktop */}
              <div className="hidden md:flex items-center justify-between gap-4 xl:gap-6 p-3 pl-4 xl:p-4 xl:pl-5">
                <div className="min-w-0 flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    {lastScan.departmentName && (
                      <>
                        <span
                          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: lastScan.departmentColor || '#4f46e5' }}
                        />
                        <span className="hidden xl:inline text-[11px] font-bold uppercase tracking-[0.06em] text-zinc-500 truncate">
                          {lastScan.departmentName}
                        </span>
                      </>
                    )}
                    <span className="inline-flex items-center gap-1 h-5 px-2 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-bold">
                      {lastScan.repeat ? (
                        <Check className="w-3 h-3 stroke-[2.5]" />
                      ) : (
                        <Plus className="w-3 h-3 stroke-[2.5]" />
                      )}
                      <span>{lastScan.repeat ? 'Scanned again' : 'Added'}</span>
                    </span>
                  </div>
                  <span className="text-base xl:text-lg xl:leading-[26px] font-bold text-zinc-950 truncate">
                    {lastScan.name}
                  </span>
                  <span className="font-mono text-xs leading-4 text-zinc-500 truncate">
                    {lastScan.barcode}
                    {lastScan.sku ? ` · ${lastScan.sku}` : ''}
                  </span>
                </div>

                <div className="flex items-center gap-2.5 xl:gap-3 flex-shrink-0">
                  <div className="flex items-center gap-2.5 xl:gap-3.5 px-3 xl:px-4 py-1.5 xl:py-2.5 rounded-xl bg-zinc-50 border border-zinc-200/80">
                    <div className="flex flex-col items-end">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-zinc-500">
                        In order
                      </span>
                      <span className="text-[15px] leading-6 font-bold text-zinc-600 tabular-nums">
                        {lastScan.before}
                      </span>
                    </div>
                    <span className="h-7 px-2.5 rounded-lg bg-emerald-100 text-emerald-800 text-[13px] font-extrabold tabular-nums flex items-center">
                      +{lastScan.delta}
                    </span>
                    <div className="flex flex-col">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-zinc-500">
                        Now
                      </span>
                      <span className="text-xl xl:text-[22px] leading-7 font-extrabold text-zinc-950 tabular-nums">
                        {lastScan.after}
                      </span>
                    </div>
                    <span className="hidden xl:block w-px self-stretch bg-zinc-200" />
                    <div className="hidden xl:flex flex-col items-end">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-zinc-500">
                        Line
                      </span>
                      <span className="text-[22px] leading-7 font-extrabold text-zinc-950 tabular-nums">
                        {money(lastScan.lineTotal)}
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={undoLastScan}
                    aria-label="Undo last scan"
                    className="h-10 w-10 xl:w-auto xl:px-3.5 rounded-xl bg-white border border-zinc-200 hover:bg-zinc-50 text-zinc-700 flex items-center justify-center gap-1.5 text-[13px] font-semibold transition-colors"
                  >
                    <Undo2 className="w-[18px] h-[18px] xl:w-4 xl:h-4" />
                    <span className="hidden xl:inline">Undo</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* The order is the main surface */}
          <section className="flex-1 min-h-[180px] md:min-h-0 bg-white border border-zinc-200/80 rounded-2xl shadow-xs flex flex-col overflow-hidden">
            <header className="h-[52px] md:h-14 xl:h-16 flex-shrink-0 px-3.5 md:px-4 xl:px-6 border-b border-zinc-100 flex items-center justify-between gap-2 md:gap-3">
              <div className="flex items-center gap-2 xl:gap-2.5 min-w-0">
                <Receipt className="hidden xl:block w-[18px] h-[18px] text-zinc-700" />
                <h2 className="text-[15px] xl:text-base font-bold text-zinc-950 whitespace-nowrap">
                  Current order
                </h2>
                <span className="h-6 px-2 rounded-full bg-zinc-100 text-zinc-700 text-xs font-semibold tabular-nums flex items-center flex-shrink-0">
                  {itemCount}
                  <span className="hidden md:inline">&nbsp;item{itemCount === 1 ? '' : 's'}</span>
                </span>
              </div>

              <div className="flex items-center gap-1 md:gap-2 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => setBrowseOpen(true)}
                  className="md:hidden h-10 px-2.5 rounded-xl bg-white border border-zinc-200 text-zinc-900 text-[13px] font-semibold flex items-center gap-1.5"
                >
                  <LayoutGrid className="w-4 h-4 text-zinc-600" />
                  <span>Add items</span>
                </button>
                <button
                  type="button"
                  onClick={clearCart}
                  disabled={cart.length === 0 || isCharging}
                  aria-label="Clear order"
                  className="h-10 w-10 xl:w-auto xl:px-3 rounded-xl text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 disabled:opacity-40 disabled:hover:bg-transparent flex items-center justify-center gap-1.5 text-[13px] font-semibold transition-colors"
                >
                  <Trash2 className="w-[18px] h-[18px] xl:w-4 xl:h-4" />
                  <span className="hidden xl:inline">Clear</span>
                </button>
              </div>
            </header>

            {/* Column labels */}
            <div className="hidden md:grid flex-shrink-0 h-9 xl:h-10 px-4 xl:px-6 gap-3 xl:gap-4 items-center bg-zinc-50 border-b border-zinc-100 text-[11px] font-semibold uppercase tracking-[0.06em] text-zinc-500 [grid-template-columns:minmax(0,1fr)_132px_80px_40px] xl:[grid-template-columns:minmax(0,1fr)_120px_176px_128px_40px]">
              <span>Item</span>
              <span className="hidden xl:block text-right">Price</span>
              <span className="text-center">Quantity</span>
              <span className="text-right">Amount</span>
              <span />
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              {cart.length === 0 ? (
                <div className="h-full min-h-[160px] flex flex-col items-center justify-center text-center gap-2 p-6">
                  <span className="w-11 h-11 rounded-2xl bg-zinc-100 text-zinc-500 grid place-items-center">
                    <ScanBarcode className="w-5 h-5" />
                  </span>
                  <p className="text-[13px] font-semibold text-zinc-700">No items yet</p>
                  <p className="text-xs text-zinc-500 max-w-[240px]">
                    Scan a barcode, or use Quick add for items without one.
                  </p>
                </div>
              ) : (
                orderLines.map((item) => {
                  const justScanned = lastScan?.productId === item.product.id;
                  const lineTotal = Math.round(item.unit_price * item.quantity * 100) / 100;
                  return (
                    <div
                      key={item.product.id}
                      className={`h-[68px] md:h-16 xl:h-[76px] px-3.5 md:px-4 xl:px-6 grid gap-2 md:gap-3 xl:gap-4 items-center border-b border-zinc-100 [grid-template-columns:minmax(0,1fr)_auto_64px] md:[grid-template-columns:minmax(0,1fr)_132px_80px_40px] xl:[grid-template-columns:minmax(0,1fr)_120px_176px_128px_40px] ${
                        justScanned ? 'bg-emerald-50/60' : ''
                      }`}
                    >
                      <div className="min-w-0 flex flex-col gap-0.5 xl:gap-1">
                        <span className="text-sm md:text-[15px] xl:text-base xl:leading-[22px] font-semibold text-zinc-950 line-clamp-2 md:line-clamp-1">
                          {item.product.name}
                        </span>
                        <span className="xl:hidden text-xs text-zinc-500 tabular-nums">
                          {money(item.unit_price)} each
                        </span>
                        <span className="hidden xl:block font-mono text-xs leading-4 text-zinc-500 truncate">
                          {item.product.sku ? `${item.product.sku} · ` : ''}
                          {item.product.barcode}
                        </span>
                      </div>

                      <span className="hidden xl:block text-right text-[15px] text-zinc-600 tabular-nums">
                        {money(item.unit_price)}
                      </span>

                      <div className="flex justify-center">
                        <div className="h-10 md:h-11 inline-flex items-center rounded-xl border border-zinc-200 bg-white overflow-hidden">
                          <button
                            type="button"
                            onClick={() => updateQuantity(item.product.id, -1)}
                            aria-label={`Remove one ${item.product.name}`}
                            className="w-9 md:w-10 xl:w-11 h-full grid place-items-center text-zinc-700 hover:bg-zinc-50 active:bg-zinc-100"
                          >
                            <Minus className="w-4 h-4 xl:w-[18px] xl:h-[18px]" />
                          </button>
                          <span className="w-8 md:w-10 xl:w-12 h-full border-x border-zinc-100 grid place-items-center text-[15px] xl:text-base font-bold text-zinc-950 tabular-nums">
                            {item.quantity}
                          </span>
                          <button
                            type="button"
                            onClick={() => updateQuantity(item.product.id, 1)}
                            aria-label={`Add one ${item.product.name}`}
                            className="w-9 md:w-10 xl:w-11 h-full grid place-items-center text-zinc-700 hover:bg-zinc-50 active:bg-zinc-100"
                          >
                            <Plus className="w-4 h-4 xl:w-[18px] xl:h-[18px]" />
                          </button>
                        </div>
                      </div>

                      <span className="text-right text-[15px] md:text-base xl:text-[17px] font-bold text-zinc-950 tabular-nums">
                        {money(lineTotal)}
                      </span>

                      <button
                        type="button"
                        onClick={() => removeFromCart(item.product.id)}
                        aria-label={`Remove ${item.product.name} from the order`}
                        className="hidden md:grid w-10 h-10 place-items-center rounded-lg text-zinc-500 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                      >
                        <Trash2 className="w-4 h-4 md:w-[18px] md:h-[18px]" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            {/* Customer + hints */}
            <footer className="h-12 md:h-11 xl:h-12 flex-shrink-0 px-3.5 md:px-4 xl:px-6 border-t border-zinc-100 bg-zinc-50 flex items-center justify-between gap-3">
              {customerOpen ? (
                <div className="flex-1 min-w-0 flex items-center gap-2">
                  <UserRound className="w-4 h-4 text-zinc-500 flex-shrink-0" />
                  <input
                    type="text"
                    value={customerName}
                    autoFocus
                    {...fieldFocus}
                    onChange={(e) => setCustomerName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === 'Escape') setCustomerOpen(false);
                    }}
                    placeholder="Customer name"
                    aria-label="Customer name"
                    className="flex-1 min-w-0 h-9 px-2.5 bg-white border border-zinc-200 rounded-lg text-[13px] text-zinc-900 outline-none focus:border-zinc-900 placeholder:text-zinc-500"
                  />
                  <button
                    type="button"
                    onClick={() => setCustomerOpen(false)}
                    className="h-9 px-2.5 rounded-lg text-[13px] font-semibold text-zinc-700 hover:bg-zinc-200/70"
                  >
                    Done
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setCustomerOpen(true)}
                  className="flex items-center gap-2 min-w-0 h-10 -ml-1 px-1 rounded-lg text-[13px] hover:bg-zinc-200/60 transition-colors"
                >
                  {customerName.trim() ? (
                    <>
                      <UserRound className="w-4 h-4 text-zinc-500 flex-shrink-0" />
                      <span className="font-medium text-zinc-700 truncate">{customerName}</span>
                      <ChevronDown className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
                    </>
                  ) : (
                    <>
                      <UserPlus className="w-4 h-4 text-emerald-700 flex-shrink-0" />
                      <span className="font-medium text-zinc-600">Walk-in customer</span>
                      <span className="hidden sm:inline font-semibold text-emerald-700">
                        · Add customer
                      </span>
                    </>
                  )}
                </button>
              )}

              <div className="hidden xl:flex items-center gap-4 text-xs text-zinc-500 flex-shrink-0">
                <span className="flex items-center gap-1.5">
                  <Kbd>/</Kbd>Search
                </span>
                <span className="flex items-center gap-1.5">
                  <Kbd>F8</Kbd>Cash
                </span>
                <span className="flex items-center gap-1.5">
                  <Kbd>F9</Kbd>Card
                </span>
                <span className="flex items-center gap-1.5">
                  <Kbd>Esc</Kbd>Clear search
                </span>
              </div>
              <span className="xl:hidden text-xs text-zinc-500 flex-shrink-0">Newest scan first</span>
            </footer>
          </section>
        </div>

        {/* --------------------------------------- quick add + pay (right) */}
        {/* On a phone this wrapper disappears so the pay card can stick to the
            bottom of the page; Quick add moves into the Add items sheet. */}
        <div className="contents md:flex md:flex-col md:w-[340px] xl:w-[520px] md:flex-shrink-0 md:h-full md:min-h-0 md:gap-3.5 xl:gap-4">
          <section className="hidden md:flex flex-1 min-h-0 bg-white border border-zinc-200/80 rounded-2xl shadow-xs flex-col overflow-hidden">
            <header className="h-12 xl:h-14 flex-shrink-0 px-4 xl:px-5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-zinc-700">
                <LayoutGrid className="w-4 h-4" />
                <h2 className="text-[15px] font-bold text-zinc-950">Quick add</h2>
              </div>
              <span className="text-xs text-zinc-500 whitespace-nowrap">
                <span className="hidden xl:inline">For items without a barcode</span>
                <span className="xl:hidden">No-barcode items</span>
              </span>
            </header>

            {!catalogueEmpty && (
              <div className="flex-shrink-0 px-4 xl:px-5 pb-3 flex items-center gap-2 overflow-x-auto no-scrollbar">
                {departmentChips}
              </div>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto px-4 xl:px-5 pb-4 xl:pb-5">
              {catalogueEmpty ? catalogueEmptyState : noMatches ? noMatchesState : tileGrid(false)}
            </div>
          </section>

          {payCard}
        </div>
      </div>

      {/* --------------------------------------------- phone: Add items sheet */}
      {browseOpen && (
        <div className="md:hidden fixed inset-0 z-50 bg-zinc-50 flex flex-col animate-in fade-in">
          <header className="h-[60px] flex-shrink-0 px-3 pl-2 bg-white border-b border-zinc-200 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1 min-w-0">
              <button
                type="button"
                onClick={() => setBrowseOpen(false)}
                aria-label="Back to the order"
                className="w-11 h-11 grid place-items-center rounded-xl text-zinc-700 hover:bg-zinc-100"
              >
                <X className="w-5 h-5" />
              </button>
              <h2 className="text-[17px] font-bold text-zinc-950">Add items</h2>
            </div>
            <button
              type="button"
              onClick={() => setBrowseOpen(false)}
              className="h-10 px-4 rounded-xl bg-zinc-900 text-white text-sm font-semibold"
            >
              Done
            </button>
          </header>

          <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-3">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitScan();
              }}
              className="flex-shrink-0 h-12 px-3.5 rounded-xl bg-white border border-zinc-200 flex items-center gap-2.5 focus-within:border-zinc-900"
            >
              <Search className="w-[18px] h-[18px] text-zinc-600 flex-shrink-0" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleScanKeyDown}
                {...fieldFocus}
                placeholder="Search by name or SKU"
                aria-label="Search the catalogue"
                className="flex-1 min-w-0 bg-transparent outline-none text-[15px] text-zinc-950 placeholder:text-zinc-500"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear search"
                  className="w-10 h-10 grid place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </form>

            {!catalogueEmpty && (
              <div className="flex-shrink-0 flex items-center gap-2 overflow-x-auto no-scrollbar">
                {departmentChips}
              </div>
            )}

            {catalogueEmpty ? (
              <div className="bg-white border border-zinc-200/80 rounded-2xl">{catalogueEmptyState}</div>
            ) : noMatches ? (
              <div className="bg-white border border-zinc-200/80 rounded-2xl">{noMatchesState}</div>
            ) : (
              tileGrid(true)
            )}

            <div className="flex items-start gap-2 px-1 pt-1 text-zinc-500">
              <ScanBarcode className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span className="text-xs leading-4">
                Items with a barcode are faster to scan from the order screen.
              </span>
            </div>
          </div>

          <footer className="flex-shrink-0 px-3 pt-3 pb-[calc(16px_+_env(safe-area-inset-bottom,0px))] bg-white border-t border-zinc-200 flex items-center justify-between gap-3">
            <div className="flex flex-col min-w-0">
              <span className="text-xs text-zinc-500 tabular-nums">
                {itemCount} item{itemCount === 1 ? '' : 's'}
              </span>
              <span className="text-[17px] font-extrabold text-zinc-950 tabular-nums">
                {money(total)}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setBrowseOpen(false)}
              className="h-12 px-5 rounded-xl bg-zinc-900 text-white text-[15px] font-semibold flex items-center gap-2"
            >
              <span>Back to order</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </footer>
        </div>
      )}

      {/* Barcode camera scanner */}
      <BarcodeScannerModal
        isOpen={scannerOpen}
        onClose={() => {
          setScannerOpen(false);
          declinedCameraPromptRef.current = null;
          focusScanField();
        }}
        onScan={(code) => handleBarcodeScanned(code, true)}
        paused={unknownPrompt !== null}
        title="Scan Item to Add to Order"
        subtitle={`Adds ${qtyPerScan} per scan · point the camera at the barcode`}
        continuous={true}
        lastLine={scannedLine}
        onAdjustLastLine={
          lastScan && !isCharging ? (delta) => updateQuantity(lastScan.productId, delta) : undefined
        }
        orderSummary={{ itemCount, total }}
      />

      {/* A scan found nothing: ask now, above the camera if it is open */}
      <UnregisteredProductDialog
        barcode={unknownPrompt}
        canRegister={canRegisterProducts}
        onRegister={() => {
          setUnregisteredBarcode(unknownPrompt);
          setUnknownPrompt(null);
          openProductRegistration();
        }}
        onClose={() => {
          if (scannerOpen) declinedCameraPromptRef.current = unknownPrompt;
          setUnknownPrompt(null);
          if (!scannerOpen) focusScanField();
        }}
      />

      {/* Quick add / register product */}
      <ProductModal
        isOpen={productModalOpen}
        onClose={() => {
          setProductModalOpen(false);
          dismissAlert();
          setUnregisteredBarcode(null);
          focusScanField();
        }}
        onSave={handleSaveNewProduct}
        departments={departments}
        initialBarcode={unregisteredBarcode || ''}
        onDepartmentCreated={async () => {
          await refreshData();
        }}
      />

      {/* Undo toast — replaces the Clear order confirm() */}
      {toast && (
        <div
          role="status"
          className="fixed left-1/2 -translate-x-1/2 z-40 bottom-[calc(97px_+_env(safe-area-inset-bottom,0px))] md:bottom-6 flex items-center gap-3 px-4 py-3 rounded-xl bg-zinc-900 text-white shadow-lg text-[13px] font-semibold animate-in fade-in slide-in-from-top-2"
        >
          <Check className="w-4 h-4 text-emerald-400 stroke-[2.5]" />
          <span className="tabular-nums">{toast.text}</span>
          {toast.undo && (
            <>
              <span className="w-px h-5 bg-white/15" />
              <button
                type="button"
                onClick={toast.undo}
                className="h-10 px-2.5 rounded-lg text-emerald-400 hover:bg-white/10 font-semibold flex items-center gap-1.5"
              >
                <Undo2 className="w-3.5 h-3.5" />
                <span>Undo</span>
              </button>
            </>
          )}
        </div>
      )}

      {/* Printable receipt */}
      <ReceiptModal isOpen={receiptOpen} onClose={() => setReceiptOpen(false)} sale={completedSale} />
    </div>
  );
};
