import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  ArrowDownUp,
  Camera,
  EllipsisVertical,
  FileSpreadsheet,
  FolderTree,
  Minus,
  Package,
  PackageSearch,
  Pencil,
  Plus,
  Printer,
  Search,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { Department, Product } from '../types';
import { api, ApiError } from '../utils/api';
import { ProductModal } from '../components/ProductModal';
import { DepartmentModal } from '../components/DepartmentModal';
import { BarcodeLabelModal } from '../components/BarcodeLabelModal';
import { ExcelImportModal } from '../components/ExcelImportModal';
import { BarcodeScannerModal } from '../components/BarcodeScannerModal';
import { playScanSuccessSound } from '../utils/audio';

interface InventoryPageProps {
  products: Product[];
  departments: Department[];
  refreshData: () => Promise<void>;
}

type StockFilter = 'ALL' | 'LOW' | 'OUT';
type StockHealth = 'OK' | 'LOW' | 'OUT';

interface AdjustReason {
  value: string;
  label: string;
  type: 'RESTOCK' | 'ADJUSTMENT_ADD' | 'ADJUSTMENT_REMOVE';
}

/**
 * The same reason → movement-type mapping Stock Scan uses. A correction made from
 * this table and one made on the scanner must land in Movement History as the same
 * kind of movement, or the restock figures stop meaning anything.
 */
const STOCK_IN_REASONS: AdjustReason[] = [
  { value: 'Supplier Delivery', label: 'Supplier Delivery', type: 'RESTOCK' },
  { value: 'Stock Transfer In', label: 'Transfer In / Other Store', type: 'RESTOCK' },
  { value: 'Count Correction', label: 'Count Correction (Found Stock)', type: 'ADJUSTMENT_ADD' },
  { value: 'Reversed Mis-Scan', label: 'Reversed Mis-Scan', type: 'ADJUSTMENT_ADD' },
  { value: 'Other', label: 'Other (Custom)', type: 'ADJUSTMENT_ADD' },
];

const STOCK_OUT_REASONS: AdjustReason[] = [
  { value: 'Damaged / Broken', label: 'Damaged / Broken', type: 'ADJUSTMENT_REMOVE' },
  { value: 'Expired', label: 'Expired', type: 'ADJUSTMENT_REMOVE' },
  { value: 'Customer Return Defect', label: 'Defective Return', type: 'ADJUSTMENT_REMOVE' },
  { value: 'Store Display / Sample', label: 'Store Display Sample', type: 'ADJUSTMENT_REMOVE' },
  { value: 'Inventory Shrinkage', label: 'Shrinkage / Missing', type: 'ADJUSTMENT_REMOVE' },
  { value: 'Other', label: 'Other (Custom)', type: 'ADJUSTMENT_REMOVE' },
];

const QUANTITY_PRESETS = [1, 5, 10, 25];

// Shared surface tokens (SPEC.md): cards 16px radius on white with the zinc-200/80
// hairline, controls 12px radius on the solid zinc-200 border.
const CARD = 'bg-white rounded-2xl border border-zinc-200/80 shadow-xs';
const STAT_LABEL = 'text-[11px] leading-4 font-semibold uppercase tracking-[0.06em] text-zinc-500';
const STAT_FIGURE = 'text-[28px] leading-8 font-extrabold tracking-[-0.02em] text-zinc-950 tabular-nums';
const STAT_CAPTION = 'text-xs leading-4 text-zinc-500';
const PILL = 'h-[22px] px-2 rounded-full text-xs font-semibold inline-flex items-center whitespace-nowrap';
const SECONDARY_BTN =
  'h-10 px-3.5 inline-flex items-center gap-2 rounded-xl bg-white border border-zinc-200 text-[13px] font-semibold text-zinc-800 hover:bg-zinc-50 shadow-xs transition-colors';
const ICON_BTN =
  'w-10 h-10 flex items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 transition-colors';
const PHONE_ICON_BTN =
  'w-11 h-11 flex-shrink-0 flex items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-700 active:bg-zinc-50 transition-colors';
const FIELD =
  'w-full h-11 px-3 text-sm bg-white border border-zinc-200 rounded-xl text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900';
const SHEET_BACKDROP =
  'fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-zinc-950/60 backdrop-blur-sm animate-in fade-in duration-150';
const SHEET_PANEL =
  'relative w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl border border-zinc-200 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]';

// Desktop gets the full six-column table; below xl the department moves into the
// product's own meta line so the name keeps its width.
const TABLE_GRID =
  'grid gap-3 xl:gap-4 grid-cols-[minmax(0,1fr)_76px_76px_104px_196px] lg:grid-cols-[minmax(0,1fr)_84px_92px_150px_196px] xl:grid-cols-[minmax(0,1fr)_180px_140px_130px_240px_200px]';

const money = (value: number) => `$${Number(value || 0).toFixed(2)}`;

const healthOf = (p: Product): StockHealth =>
  p.stock_quantity <= 0 ? 'OUT' : p.stock_quantity <= p.min_stock_level ? 'LOW' : 'OK';

const HEALTH_PILL: Record<StockHealth, string> = {
  OK: 'bg-emerald-50 text-emerald-700',
  LOW: 'bg-amber-50 text-amber-700',
  OUT: 'bg-rose-50 text-rose-700',
};

const HEALTH_LABEL: Record<StockHealth, string> = {
  OK: 'In stock',
  LOW: 'Low stock',
  OUT: 'Out of stock',
};

const HEALTH_DOT: Record<StockHealth, string> = {
  OK: 'bg-emerald-500',
  LOW: 'bg-amber-500',
  OUT: 'bg-rose-500',
};

const capitalize = (value: string) => (value ? value[0].toUpperCase() + value.slice(1) : value);

export const InventoryPage: React.FC<InventoryPageProps> = ({
  products,
  departments,
  refreshData,
}) => {
  const [selectedDeptId, setSelectedDeptId] = useState<number | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [stockFilter, setStockFilter] = useState<StockFilter>('ALL');
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [deptModalOpen, setDeptModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [labelProduct, setLabelProduct] = useState<Product | null>(null);
  const [labelPickerOpen, setLabelPickerOpen] = useState(false);
  const [excelImportOpen, setExcelImportOpen] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [phoneMenuOpen, setPhoneMenuOpen] = useState(false);
  const [adjustProduct, setAdjustProduct] = useState<Product | null>(null);
  const [actionsProduct, setActionsProduct] = useState<Product | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<
    { product: Product; mode: 'delete' | 'archive' | 'archive-after-delete' } | null
  >(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<number | null>(null);

  // Archived products are excluded from the list App.tsx loads, so the only honest
  // way to offer "Show N archived" is to ask the server for them.
  const [archived, setArchived] = useState<Product[]>([]);
  const [archivedKnown, setArchivedKnown] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const loadArchived = useCallback(async () => {
    try {
      const all = await api.getProducts({ include_archived: true });
      setArchived(all.filter((p) => p.is_active === false));
      setArchivedKnown(true);
    } catch {
      // A failed lookup must not break the catalogue: hide the control rather than
      // show a count that might be wrong.
      setArchived([]);
      setArchivedKnown(false);
    }
  }, []);

  useEffect(() => {
    void loadArchived();
  }, [loadArchived]);

  const matchesFilters = useCallback(
    (p: Product) => {
      const raw = searchQuery.trim();
      const query = raw.toLowerCase();
      const matchDept = selectedDeptId === 'ALL' || p.department_id === selectedDeptId;
      const matchSearch =
        !raw ||
        p.name.toLowerCase().includes(query) ||
        p.barcode.includes(raw) ||
        (p.sku ? p.sku.toLowerCase().includes(query) : false);
      const matchStock =
        stockFilter === 'ALL' ||
        (stockFilter === 'OUT'
          ? p.stock_quantity <= 0
          : p.stock_quantity <= p.min_stock_level && p.stock_quantity > 0);
      return matchDept && matchSearch && matchStock;
    },
    [searchQuery, selectedDeptId, stockFilter],
  );

  const filteredProducts = useMemo(() => products.filter(matchesFilters), [products, matchesFilters]);
  const filteredArchived = useMemo(() => archived.filter(matchesFilters), [archived, matchesFilters]);

  // Overall Inventory Stats
  const stats = useMemo(() => {
    const totalStock = products.reduce((acc, p) => acc + p.stock_quantity, 0);
    const retailValue = products.reduce((acc, p) => acc + p.stock_quantity * p.price, 0);
    const costValue = products.reduce((acc, p) => acc + p.stock_quantity * (p.cost_price || 0), 0);
    const lowStockCount = products.filter(
      (p) => p.stock_quantity <= p.min_stock_level && p.stock_quantity > 0,
    ).length;
    const outOfStockCount = products.filter((p) => p.stock_quantity <= 0).length;

    return { totalStock, retailValue, costValue, lowStockCount, outOfStockCount };
  }, [products]);

  // Anything the shopkeeper has to act on — drives both the filter counts and
  // whether the alert styling is earned at all.
  const alertCount = stats.lowStockCount + stats.outOfStockCount;

  /**
   * The server's `department.product_count` comes from a join with no is_active
   * filter, so a department holding only archived stock advertises a count and then
   * opens an empty list. Count the products actually on screen instead.
   */
  const deptCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const p of products) counts.set(p.department_id, (counts.get(p.department_id) ?? 0) + 1);
    return counts;
  }, [products]);

  const stockedDepartments = departments.filter((d) => (deptCounts.get(d.id) ?? 0) > 0);
  const emptyDepartmentCount = departments.length - stockedDepartments.length;

  // "196 bottles" only reads correctly while every product is measured the same way.
  const unitLabel = useMemo(() => {
    const units = new Set(
      products.map((p) => (p.unit || '').trim().toLowerCase()).filter((u) => u.length > 0),
    );
    return units.size === 1 ? Array.from(units)[0] : 'units';
  }, [products]);

  const openNewProduct = () => {
    setEditingProduct(null);
    setProductModalOpen(true);
  };

  const openEditProduct = (product: Product) => {
    setEditingProduct(product);
    setProductModalOpen(true);
  };

  const handleSaveProduct = async (data: Partial<Product>) => {
    if (editingProduct) {
      await api.updateProduct(editingProduct.id, data);
    } else {
      await api.createProduct(data);
    }
    await refreshData();
    // An edit can flip is_active, which moves the product between the two lists.
    await loadArchived();
  };

  const handleRestoreProduct = async (product: Product) => {
    setPageError(null);
    try {
      setRestoringId(product.id);
      await api.restoreProduct(product.id);
      await refreshData();
      await loadArchived();
    } catch (err) {
      setPageError(err instanceof Error ? err.message : 'Failed to restore product');
    } finally {
      setRestoringId(null);
    }
  };

  const runConfirmedAction = async () => {
    if (!confirmTarget || confirmBusy) return;
    const { product, mode } = confirmTarget;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      if (mode === 'delete') {
        try {
          await api.deleteProduct(product.id);
        } catch (err) {
          // A product that has been sold cannot be deleted — its receipt lines would
          // be left pointing at nothing. Offer what the user actually wants instead
          // of leaving them at a dead end.
          if (err instanceof ApiError && err.code === 'HAS_HISTORY') {
            setConfirmTarget({ product, mode: 'archive-after-delete' });
            return;
          }
          throw err;
        }
      } else {
        await api.archiveProduct(product.id);
      }
      await refreshData();
      await loadArchived();
      setConfirmTarget(null);
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setConfirmBusy(false);
    }
  };

  const handleAddDepartment = async (dept: Partial<Department>) => {
    await api.createDepartment(dept);
    await refreshData();
  };

  const handleDeleteDepartment = async (id: number) => {
    await api.deleteDepartment(id);
    await refreshData();
  };

  // Escape closes the light-weight overlays; the modals below own their own keys.
  useEffect(() => {
    if (!phoneMenuOpen && !actionsProduct && !labelPickerOpen && !confirmTarget) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setPhoneMenuOpen(false);
      setActionsProduct(null);
      setLabelPickerOpen(false);
      if (!confirmBusy) setConfirmTarget(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phoneMenuOpen, actionsProduct, labelPickerOpen, confirmTarget, confirmBusy]);

  const archivedToggle = (className: string) =>
    archivedKnown && archived.length > 0 ? (
      <button
        type="button"
        onClick={() => setShowArchived((v) => !v)}
        className={className}
        aria-expanded={showArchived}
      >
        {showArchived ? 'Hide archived' : `Show ${archived.length} archived`}
      </button>
    ) : null;

  const stockSegments: Array<{ id: StockFilter; label: string; count: number | null }> = [
    { id: 'ALL', label: 'All stock', count: null },
    { id: 'LOW', label: 'Low', count: stats.lowStockCount },
    { id: 'OUT', label: 'Out', count: stats.outOfStockCount },
  ];

  const stockFilterControl = (className: string) => (
    <div
      className={`h-10 flex rounded-xl border border-zinc-200 bg-white overflow-hidden text-[13px] font-semibold ${className}`}
      role="group"
      aria-label="Filter by stock level"
    >
      {stockSegments.map((segment, index) => (
        <button
          key={segment.id}
          type="button"
          onClick={() => setStockFilter(segment.id)}
          aria-pressed={stockFilter === segment.id}
          className={`flex-1 md:flex-none px-3.5 inline-flex items-center justify-center gap-1.5 transition-colors ${
            index > 0 ? 'border-l border-zinc-200' : ''
          } ${stockFilter === segment.id ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-600 hover:bg-zinc-50'}`}
        >
          <span>{segment.label}</span>
          {segment.count !== null && (
            <span className="tabular-nums text-zinc-500">{segment.count}</span>
          )}
        </button>
      ))}
    </div>
  );

  const departmentChip = (dept: Department) => {
    const count = deptCounts.get(dept.id) ?? 0;
    const isSelected = selectedDeptId === dept.id;
    const isEmpty = count === 0;
    return (
      <button
        key={dept.id}
        type="button"
        onClick={() => setSelectedDeptId(dept.id)}
        aria-pressed={isSelected}
        className={`h-9 px-3 inline-flex items-center gap-2 rounded-lg text-[13px] whitespace-nowrap flex-shrink-0 transition-colors ${
          isSelected
            ? 'bg-zinc-900 text-white font-semibold'
            : isEmpty
            ? 'bg-white border border-zinc-100 text-zinc-500 font-medium hover:bg-zinc-50'
            : 'bg-zinc-100 text-zinc-800 font-semibold hover:bg-zinc-200/70'
        }`}
      >
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${isEmpty ? 'opacity-45' : ''}`}
          style={{ backgroundColor: dept.color || '#4f46e5' }}
        />
        <span>{dept.name}</span>
        <span className={`tabular-nums ${isSelected ? 'text-zinc-300' : 'text-zinc-500'}`}>
          {count}
        </span>
      </button>
    );
  };

  const productRow = (p: Product, isArchivedRow: boolean) => {
    const health = healthOf(p);
    return (
      <div
        key={p.id}
        className={`${TABLE_GRID} h-16 xl:h-[68px] px-4 xl:px-5 items-center border-b border-zinc-100 transition-colors ${
          isArchivedRow ? 'bg-zinc-50/60' : 'hover:bg-zinc-50/70'
        }`}
      >
        {/* Name, department (below xl) and the codes */}
        <div className="min-w-0 flex flex-col gap-1">
          <span
            className={`truncate text-sm leading-5 font-semibold ${
              isArchivedRow ? 'text-zinc-600' : 'text-zinc-950'
            }`}
          >
            {p.name}
          </span>
          <span className="flex items-center gap-1.5 min-w-0 text-xs leading-4 text-zinc-500">
            <span className="xl:hidden flex items-center gap-1.5 min-w-0 flex-shrink-0">
              <span
                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: p.department_color || '#4f46e5' }}
              />
              <span className="truncate">{p.department_name}</span>
              <span aria-hidden="true">·</span>
            </span>
            <span className="font-mono truncate">
              {[p.sku, p.barcode].filter(Boolean).join(' · ')}
            </span>
          </span>
        </div>

        {/* Department — its own column only where there is room for one */}
        <div className="hidden xl:flex items-center gap-2 min-w-0 text-[13px] text-zinc-600">
          <span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: p.department_color || '#4f46e5' }}
          />
          <span className="truncate">{p.department_name}</span>
        </div>

        {/* Price over cost */}
        <div className="flex flex-col items-end gap-0.5 min-w-0">
          <span className="text-[15px] leading-5 font-semibold text-zinc-950 tabular-nums">
            {money(p.price)}
          </span>
          {!!p.cost_price && p.cost_price > 0 && (
            <span className="text-xs leading-4 text-zinc-500 tabular-nums">
              cost {money(p.cost_price)}
            </span>
          )}
        </div>

        {/* On hand */}
        <div className="flex items-baseline justify-end gap-1 min-w-0 text-[13px] text-zinc-500">
          <span className="text-[15px] font-bold text-zinc-950 tabular-nums">{p.stock_quantity}</span>
          <span className="truncate">{p.unit}</span>
        </div>

        {/* Stock health against this product's own minimum */}
        <div className="flex items-center gap-2 min-w-0">
          {isArchivedRow ? (
            <span className={`${PILL} bg-zinc-100 text-zinc-700`}>Archived</span>
          ) : (
            <span className={`${PILL} ${HEALTH_PILL[health]}`}>{HEALTH_LABEL[health]}</span>
          )}
          <span className="hidden lg:inline text-xs leading-4 text-zinc-500 tabular-nums">
            min {p.min_stock_level}
          </span>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2">
          {isArchivedRow ? (
            <button
              type="button"
              onClick={() => handleRestoreProduct(p)}
              disabled={restoringId === p.id}
              className={`${SECONDARY_BTN} disabled:opacity-50`}
            >
              <ArchiveRestore className="w-4 h-4 text-zinc-600" />
              {restoringId === p.id ? 'Restoring…' : 'Restore'}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setAdjustProduct(p)}
                className={SECONDARY_BTN}
                aria-label={`Adjust stock for ${p.name}`}
              >
                <ArrowDownUp className="w-4 h-4 text-zinc-600" />
                Adjust
              </button>
              <button
                type="button"
                onClick={() => openEditProduct(p)}
                className={ICON_BTN}
                aria-label={`Edit ${p.name}`}
              >
                <Pencil className="w-4 h-4" />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setActionsProduct(p)}
            className={ICON_BTN}
            aria-label={`More actions for ${p.name}`}
          >
            <EllipsisVertical className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  };

  const phoneRow = (p: Product, isArchivedRow: boolean) => {
    const health = healthOf(p);
    return (
      <div
        key={p.id}
        className={`min-h-[72px] flex items-center gap-2 pl-4 pr-1.5 border-b border-zinc-100 ${
          isArchivedRow ? 'bg-zinc-50/60' : ''
        }`}
      >
        <button
          type="button"
          onClick={() => openEditProduct(p)}
          className="flex-1 min-w-0 flex flex-col items-start gap-0.5 py-3.5 text-left"
          aria-label={`Edit ${p.name}`}
        >
          <span
            className={`w-full truncate text-[15px] leading-5 font-semibold ${
              isArchivedRow ? 'text-zinc-600' : 'text-zinc-950'
            }`}
          >
            {p.name}
          </span>
          <span className="w-full flex items-center gap-1.5 min-w-0 text-xs leading-4 text-zinc-500">
            <span className="font-mono truncate">{p.sku || p.barcode}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums flex-shrink-0">{money(p.price)}</span>
            {isArchivedRow && (
              <>
                <span aria-hidden="true">·</span>
                <span className="flex-shrink-0">Archived</span>
              </>
            )}
          </span>
        </button>

        <div className="flex-shrink-0 flex flex-col items-end gap-0.5">
          <span className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${HEALTH_DOT[health]}`} aria-hidden="true" />
            <span className="text-[15px] leading-5 font-bold text-zinc-950 tabular-nums">
              {p.stock_quantity}
            </span>
          </span>
          <span className="text-xs leading-4 text-zinc-500 tabular-nums">
            min {p.min_stock_level}
          </span>
        </div>

        {isArchivedRow ? (
          <button
            type="button"
            onClick={() => handleRestoreProduct(p)}
            disabled={restoringId === p.id}
            className={`${PHONE_ICON_BTN} disabled:opacity-50`}
            aria-label={`Restore ${p.name}`}
          >
            <ArchiveRestore className="w-[18px] h-[18px]" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setAdjustProduct(p)}
            className={PHONE_ICON_BTN}
            aria-label={`Adjust stock for ${p.name}`}
          >
            <ArrowDownUp className="w-[18px] h-[18px]" />
          </button>
        )}
        <button
          type="button"
          onClick={() => setActionsProduct(p)}
          className={PHONE_ICON_BTN}
          aria-label={`More actions for ${p.name}`}
        >
          <EllipsisVertical className="w-[18px] h-[18px]" />
        </button>
      </div>
    );
  };

  // Archived rows on screen are still rows: "nothing matches" would contradict them.
  const archivedRowsShown = showArchived && filteredArchived.length > 0;

  const emptyState =
    products.length === 0 && !archivedRowsShown ? (
      <div className="px-6 py-12 text-center flex flex-col items-center gap-3">
        <span className="w-12 h-12 rounded-2xl bg-zinc-100 text-zinc-500 flex items-center justify-center">
          <Package className="w-6 h-6" />
        </span>
        <span className="text-base font-bold text-zinc-950">Your inventory is empty</span>
        <span className="max-w-sm text-[13px] leading-5 text-zinc-500">
          Add products one at a time, import a catalogue from Excel, or scan product barcodes on
          Stock Scan.
        </span>
        <button
          type="button"
          onClick={openNewProduct}
          className="mt-1 h-11 px-4 inline-flex items-center gap-2 rounded-xl bg-zinc-900 text-white text-[13px] font-semibold hover:bg-zinc-800 shadow-xs active:scale-98 transition-all"
        >
          <Plus className="w-4 h-4" />
          Add first product
        </button>
      </div>
    ) : filteredProducts.length === 0 && !archivedRowsShown ? (
      <div className="px-6 py-12 text-center flex flex-col items-center gap-2">
        <span className="w-12 h-12 rounded-2xl bg-zinc-100 text-zinc-500 flex items-center justify-center">
          <PackageSearch className="w-6 h-6" />
        </span>
        <span className="text-sm font-bold text-zinc-950">No products match these filters</span>
        <span className="text-[13px] leading-5 text-zinc-500">
          Clear the search or pick another department.
        </span>
      </div>
    ) : null;

  return (
    <div className="w-full max-w-full min-w-0 p-4 md:p-5 xl:p-6 flex flex-col gap-3 xl:gap-4 overflow-x-hidden">
      {/* Page header */}
      <div className="flex items-start md:items-center justify-between gap-4">
        <div className="min-w-0 flex flex-col gap-0.5">
          <h2 className="text-[20px] md:text-[22px] leading-7 font-bold tracking-[-0.01em] text-zinc-950">
            Inventory
          </h2>
          <p className="hidden md:block text-[13px] leading-5 text-zinc-500">
            <span className="xl:hidden">Products, prices and stock against each minimum.</span>
            <span className="hidden xl:inline">
              Products, prices and stock. Each product is checked against its own minimum.
            </span>
          </p>
          <p className="md:hidden text-xs leading-4 text-zinc-500 tabular-nums">
            {products.length} active · {departments.length} departments
          </p>
        </div>

        {/* Desktop and tablet actions */}
        <div className="hidden md:flex items-center gap-2 flex-shrink-0">
          <button type="button" onClick={() => setExcelImportOpen(true)} className={SECONDARY_BTN}>
            <FileSpreadsheet className="w-4 h-4 text-zinc-600" />
            <span>
              Import<span className="hidden xl:inline"> from Excel</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => setLabelPickerOpen(true)}
            className={SECONDARY_BTN}
            disabled={products.length === 0}
          >
            <Printer className="w-4 h-4 text-zinc-600" />
            <span className="hidden xl:inline">Print labels</span>
            <span className="xl:hidden">Labels</span>
          </button>
          <button
            type="button"
            onClick={openNewProduct}
            className="h-10 px-4 inline-flex items-center gap-2 rounded-xl bg-zinc-900 text-white text-[13px] font-semibold hover:bg-zinc-800 shadow-xs active:scale-98 transition-all"
          >
            <Plus className="w-4 h-4" />
            Add product
          </button>
        </div>

        {/* Phone actions: the secondary set collapses into one menu */}
        <div className="flex md:hidden items-center gap-2 flex-shrink-0">
          <div className="relative">
            <button
              type="button"
              onClick={() => setPhoneMenuOpen((v) => !v)}
              className={PHONE_ICON_BTN}
              aria-label="More inventory actions"
              aria-expanded={phoneMenuOpen}
            >
              <EllipsisVertical className="w-[18px] h-[18px]" />
            </button>
            {phoneMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setPhoneMenuOpen(false)}
                  aria-hidden="true"
                />
                <div
                  className="absolute right-0 top-12 z-50 w-56 rounded-2xl border border-zinc-200 bg-white shadow-2xl overflow-hidden animate-in fade-in slide-in-from-top-2"
                  role="menu"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPhoneMenuOpen(false);
                      setExcelImportOpen(true);
                    }}
                    className="w-full h-12 px-4 flex items-center gap-3 text-sm font-semibold text-zinc-800 active:bg-zinc-50"
                  >
                    <FileSpreadsheet className="w-4 h-4 text-zinc-500" />
                    Import from Excel
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={products.length === 0}
                    onClick={() => {
                      setPhoneMenuOpen(false);
                      setLabelPickerOpen(true);
                    }}
                    className="w-full h-12 px-4 flex items-center gap-3 text-sm font-semibold text-zinc-800 active:bg-zinc-50 disabled:opacity-40 border-t border-zinc-100"
                  >
                    <Printer className="w-4 h-4 text-zinc-500" />
                    Print labels
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPhoneMenuOpen(false);
                      setDeptModalOpen(true);
                    }}
                    className="w-full h-12 px-4 flex items-center gap-3 text-sm font-semibold text-zinc-800 active:bg-zinc-50 border-t border-zinc-100"
                  >
                    <FolderTree className="w-4 h-4 text-zinc-500" />
                    Departments
                    <span className="ml-auto text-xs text-zinc-500 tabular-nums">
                      {departments.length}
                    </span>
                  </button>
                </div>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={openNewProduct}
            className="h-11 pl-3.5 pr-4 inline-flex items-center gap-1.5 rounded-xl bg-zinc-900 text-white text-sm font-semibold shadow-xs active:scale-98 transition-all"
          >
            <Plus className="w-[18px] h-[18px]" />
            Add
          </button>
        </div>
      </div>

      {pageError && (
        <div className="flex items-start gap-2 p-3 rounded-xl bg-rose-50 border border-rose-200 text-[13px] leading-5 text-rose-700">
          <TriangleAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span className="flex-1 min-w-0">{pageError}</span>
          <button
            type="button"
            onClick={() => setPageError(null)}
            className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-rose-100"
            aria-label="Dismiss error"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Phone search + camera */}
      <div className="flex md:hidden items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="w-[18px] h-[18px] text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Name, SKU or barcode"
            aria-label="Search products"
            className="w-full h-11 pl-10 pr-3 text-[15px] bg-white border border-zinc-200 rounded-xl text-zinc-900 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
          />
        </div>
        <button
          type="button"
          onClick={() => setScannerOpen(true)}
          className={PHONE_ICON_BTN}
          aria-label="Scan a barcode with the camera"
        >
          <Camera className="w-5 h-5" />
        </button>
      </div>

      {/* Stats — desktop and tablet */}
      <div className="hidden md:grid grid-cols-4 gap-3 xl:gap-4">
        <div className={`${CARD} px-4 xl:px-5 py-3.5 xl:py-4 flex flex-col gap-1`}>
          <span className={STAT_LABEL}>Active products</span>
          <span className={STAT_FIGURE}>{products.length}</span>
          <span className={STAT_CAPTION}>
            In {stockedDepartments.length} of {departments.length} departments
          </span>
        </div>
        <div className={`${CARD} px-4 xl:px-5 py-3.5 xl:py-4 flex flex-col gap-1`}>
          <span className={STAT_LABEL}>Units on hand</span>
          <span className={STAT_FIGURE}>{stats.totalStock.toLocaleString()}</span>
          <span className={STAT_CAPTION}>
            {capitalize(unitLabel)} across {products.length} products
          </span>
        </div>
        <div className={`${CARD} px-4 xl:px-5 py-3.5 xl:py-4 flex flex-col gap-1`}>
          <span className={STAT_LABEL}>Retail value</span>
          <span className={STAT_FIGURE}>{money(stats.retailValue)}</span>
          <span className={`${STAT_CAPTION} tabular-nums`}>
            {stats.costValue > 0 ? `At cost ${money(stats.costValue)}` : 'No cost prices recorded'}
          </span>
        </div>
        <div className={`${CARD} px-4 xl:px-5 py-3.5 xl:py-4 flex flex-col gap-1`}>
          <span className={STAT_LABEL}>Below minimum</span>
          {/* A fully stocked shelf is good news, not an alert — amber and rose only
              appear once a count has something in it. */}
          <div className="flex items-center gap-2.5 min-w-0">
            <span className={STAT_FIGURE}>{alertCount}</span>
            {alertCount === 0 ? (
              <span className={`${PILL} bg-emerald-50 text-emerald-700`}>All stocked</span>
            ) : (
              <span className="flex items-center gap-1.5 min-w-0">
                {stats.lowStockCount > 0 && (
                  <span className={`${PILL} bg-amber-50 text-amber-700 tabular-nums`}>
                    {stats.lowStockCount} low
                  </span>
                )}
                {stats.outOfStockCount > 0 && (
                  <span className={`${PILL} bg-rose-50 text-rose-700 tabular-nums`}>
                    {stats.outOfStockCount} out
                  </span>
                )}
              </span>
            )}
          </div>
          <span className={`${STAT_CAPTION} tabular-nums`}>
            {stats.lowStockCount} low · {stats.outOfStockCount} out of stock
          </span>
        </div>
      </div>

      {/* Stats — phone */}
      <div className={`${CARD} md:hidden px-4 py-3 grid grid-cols-3 gap-3`}>
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className={STAT_LABEL}>On hand</span>
          <span className="text-[22px] leading-7 font-extrabold tracking-[-0.02em] text-zinc-950 tabular-nums">
            {stats.totalStock.toLocaleString()}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className={STAT_LABEL}>Value</span>
          <span className="text-[22px] leading-7 font-extrabold tracking-[-0.02em] text-zinc-950 tabular-nums truncate">
            {money(stats.retailValue)}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className={STAT_LABEL}>Below min</span>
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="text-[22px] leading-7 font-extrabold tracking-[-0.02em] text-zinc-950 tabular-nums">
              {alertCount}
            </span>
            {alertCount === 0 && (
              <span className={`${PILL} bg-emerald-50 text-emerald-700`}>OK</span>
            )}
          </span>
        </div>
      </div>

      {/* Filters — desktop and tablet */}
      <div className={`${CARD} hidden md:flex flex-wrap items-center gap-3 p-3`}>
        <div className="relative h-10 flex-1 min-w-[220px] xl:flex-none xl:w-[360px]">
          <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search name, SKU or barcode"
            aria-label="Search products"
            className="w-full h-10 pl-9 pr-3 text-[13px] bg-white border border-zinc-200 rounded-xl text-zinc-900 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
          />
        </div>

        {/* basis-[420px] is what makes the chips take their own line on a tablet and
            share the single desktop row; a 0 basis would let them collapse instead. */}
        <div className="order-3 xl:order-none flex-1 basis-[420px] xl:basis-0 min-w-0 flex items-center gap-2 overflow-x-auto no-scrollbar">
          <button
            type="button"
            onClick={() => setSelectedDeptId('ALL')}
            aria-pressed={selectedDeptId === 'ALL'}
            className={`h-9 px-3 inline-flex items-center gap-2 rounded-lg text-[13px] font-semibold whitespace-nowrap flex-shrink-0 transition-colors ${
              selectedDeptId === 'ALL'
                ? 'bg-zinc-900 text-white'
                : 'bg-zinc-100 text-zinc-800 hover:bg-zinc-200/70'
            }`}
          >
            <span>All</span>
            <span
              className={`tabular-nums ${
                selectedDeptId === 'ALL' ? 'text-zinc-300' : 'text-zinc-500'
              }`}
            >
              {products.length}
            </span>
          </button>
          {departments.map(departmentChip)}
        </div>

        {stockFilterControl('flex-shrink-0')}

        <button
          type="button"
          onClick={() => setDeptModalOpen(true)}
          className={`${SECONDARY_BTN} order-4 xl:order-none flex-shrink-0`}
        >
          <FolderTree className="w-4 h-4 text-zinc-600" />
          <span>Departments</span>
          <span className="tabular-nums text-zinc-500">{departments.length}</span>
        </button>
      </div>

      {/* Filters — phone: chips then the stock segments */}
      <div className="md:hidden flex flex-col gap-2">
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
          <button
            type="button"
            onClick={() => setSelectedDeptId('ALL')}
            aria-pressed={selectedDeptId === 'ALL'}
            className={`h-9 px-3 inline-flex items-center gap-2 rounded-lg text-[13px] font-semibold whitespace-nowrap flex-shrink-0 transition-colors ${
              selectedDeptId === 'ALL'
                ? 'bg-zinc-900 text-white'
                : 'bg-zinc-100 text-zinc-800 active:bg-zinc-200/70'
            }`}
          >
            <span>All</span>
            <span
              className={`tabular-nums ${
                selectedDeptId === 'ALL' ? 'text-zinc-300' : 'text-zinc-500'
              }`}
            >
              {products.length}
            </span>
          </button>
          {/* Empty departments are counted, not listed: a phone row of zeroes is noise. */}
          {stockedDepartments.map(departmentChip)}
          {selectedDeptId !== 'ALL' &&
            !stockedDepartments.some((d) => d.id === selectedDeptId) &&
            departments
              .filter((d) => d.id === selectedDeptId)
              .map(departmentChip)}
          {emptyDepartmentCount > 0 && (
            <span className="h-9 px-2.5 inline-flex items-center text-[13px] text-zinc-500 whitespace-nowrap flex-shrink-0">
              {emptyDepartmentCount} empty hidden
            </span>
          )}
        </div>
        {stockFilterControl('w-full')}
      </div>

      {/* Products — table on tablet and desktop */}
      <div className={`${CARD} hidden md:flex flex-col overflow-hidden`}>
        <div
          className={`${TABLE_GRID} h-11 px-4 xl:px-5 items-center bg-zinc-50 border-b border-zinc-200 ${STAT_LABEL}`}
        >
          <span>Product</span>
          <span className="hidden xl:block">Department</span>
          <span className="text-right">Price</span>
          <span className="text-right">On hand</span>
          <span>
            <span className="hidden xl:inline">Stock health</span>
            <span className="xl:hidden">Health</span>
          </span>
          <span className="text-right">Actions</span>
        </div>

        {filteredProducts.map((p) => productRow(p, false))}

        {showArchived && filteredArchived.length > 0 && (
          <div className="h-10 px-4 xl:px-5 flex items-center bg-zinc-50/80 border-b border-zinc-100">
            <span className={STAT_LABEL}>Archived · {filteredArchived.length}</span>
          </div>
        )}
        {showArchived && filteredArchived.map((p) => productRow(p, true))}

        {emptyState}

        <div className="h-12 xl:h-[52px] px-4 xl:px-5 flex items-center justify-between gap-4">
          <span className="text-[13px] leading-5 text-zinc-500 truncate">
            Showing {filteredProducts.length} of {products.length} active products · sorted by name
          </span>
          {archivedToggle(
            'h-10 px-3 inline-flex items-center rounded-xl text-[13px] font-semibold text-emerald-700 hover:bg-emerald-50 transition-colors flex-shrink-0',
          )}
        </div>
      </div>

      {/* Products — card list on phone (a 640px table cannot be read on 390px) */}
      <div className={`${CARD} md:hidden flex flex-col overflow-hidden`}>
        {filteredProducts.map((p) => phoneRow(p, false))}

        {showArchived && filteredArchived.length > 0 && (
          <div className="h-9 px-4 flex items-center bg-zinc-50/80 border-b border-zinc-100">
            <span className={STAT_LABEL}>Archived · {filteredArchived.length}</span>
          </div>
        )}
        {showArchived && filteredArchived.map((p) => phoneRow(p, true))}

        {emptyState}

        <div className="min-h-[44px] pl-4 pr-1 py-1 flex items-center justify-between gap-3">
          <span className="text-xs leading-4 text-zinc-500">Tap a product to edit</span>
          {archivedToggle(
            'h-11 px-3 inline-flex items-center rounded-xl text-[13px] font-semibold text-emerald-700 active:bg-emerald-50 transition-colors flex-shrink-0',
          )}
        </div>
      </div>

      {/* Stock in / out sheet — replaces the one-tap ±1 buttons, which wrote a
          movement with a canned reason and no way back. */}
      {adjustProduct && (
        <StockAdjustSheet
          product={adjustProduct}
          onClose={() => setAdjustProduct(null)}
          refreshData={refreshData}
        />
      )}

      {/* Per-product actions that do not earn a place in the row */}
      {actionsProduct && (
        <div
          className={SHEET_BACKDROP}
          onClick={() => setActionsProduct(null)}
          role="dialog"
          aria-modal="true"
          aria-label={`Actions for ${actionsProduct.name}`}
        >
          <div className={SHEET_PANEL} onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-zinc-100 flex items-start justify-between gap-3">
              <div className="min-w-0 flex flex-col gap-0.5">
                <span className="truncate text-sm font-semibold text-zinc-950">
                  {actionsProduct.name}
                </span>
                <span className="truncate font-mono text-xs text-zinc-500">
                  {[actionsProduct.sku, actionsProduct.barcode].filter(Boolean).join(' · ')}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setActionsProduct(null)}
                className="w-10 h-10 -mr-2 -mt-1 flex-shrink-0 flex items-center justify-center rounded-xl text-zinc-500 hover:bg-zinc-100"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex flex-col">
              <button
                type="button"
                onClick={() => {
                  const product = actionsProduct;
                  setActionsProduct(null);
                  setLabelProduct(product);
                }}
                className="h-14 px-5 flex items-center gap-3 text-sm font-semibold text-zinc-800 hover:bg-zinc-50 border-b border-zinc-100"
              >
                <Printer className="w-4 h-4 text-zinc-500" />
                Print barcode label
              </button>
              <button
                type="button"
                onClick={() => {
                  const product = actionsProduct;
                  setActionsProduct(null);
                  openEditProduct(product);
                }}
                className="h-14 px-5 flex items-center gap-3 text-sm font-semibold text-zinc-800 hover:bg-zinc-50 border-b border-zinc-100"
              >
                <Pencil className="w-4 h-4 text-zinc-500" />
                Edit product
              </button>
              {actionsProduct.is_active === false ? (
                <button
                  type="button"
                  onClick={() => {
                    const product = actionsProduct;
                    setActionsProduct(null);
                    void handleRestoreProduct(product);
                  }}
                  className="h-14 px-5 flex items-center gap-3 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 border-b border-zinc-100"
                >
                  <ArchiveRestore className="w-4 h-4" />
                  Restore to catalogue
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    const product = actionsProduct;
                    setActionsProduct(null);
                    setConfirmError(null);
                    setConfirmTarget({ product, mode: 'archive' });
                  }}
                  className="h-14 px-5 flex items-center gap-3 text-sm font-semibold text-zinc-800 hover:bg-zinc-50 border-b border-zinc-100"
                >
                  <Archive className="w-4 h-4 text-zinc-500" />
                  Archive product
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  const product = actionsProduct;
                  setActionsProduct(null);
                  setConfirmError(null);
                  setConfirmTarget({ product, mode: 'delete' });
                }}
                className="h-14 px-5 flex items-center gap-3 text-sm font-semibold text-rose-700 hover:bg-rose-50"
              >
                <Trash2 className="w-4 h-4" />
                Delete product
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete / archive confirmation. Deleting a product that appears on a receipt
          is refused by the server; that refusal turns into the archive offer. */}
      {confirmTarget && (
        <div
          className={SHEET_BACKDROP}
          role="dialog"
          aria-modal="true"
          aria-label="Confirm action"
        >
          <div className={`${SHEET_PANEL} sm:max-w-sm`}>
            <div className="p-5 flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <span
                  className={`w-10 h-10 flex-shrink-0 rounded-xl flex items-center justify-center ${
                    confirmTarget.mode === 'delete'
                      ? 'bg-rose-50 text-rose-600'
                      : 'bg-amber-50 text-amber-700'
                  }`}
                >
                  {confirmTarget.mode === 'delete' ? (
                    <Trash2 className="w-5 h-5" />
                  ) : (
                    <Archive className="w-5 h-5" />
                  )}
                </span>
                <div className="min-w-0 flex flex-col gap-1">
                  <span className="text-sm font-bold text-zinc-950">
                    {confirmTarget.mode === 'delete'
                      ? `Delete "${confirmTarget.product.name}"?`
                      : confirmTarget.mode === 'archive'
                      ? `Archive "${confirmTarget.product.name}"?`
                      : `"${confirmTarget.product.name}" has already been sold`}
                  </span>
                  <span className="text-[13px] leading-5 text-zinc-500">
                    {confirmTarget.mode === 'delete'
                      ? 'It leaves the catalogue and the register for good. This cannot be undone.'
                      : confirmTarget.mode === 'archive'
                      ? 'It disappears from the register and this list, but every receipt, refund and stock record keeps working. You can restore it from "Show archived".'
                      : 'It cannot be deleted — the receipts it appears on would be left pointing at nothing. Archive it instead? Every receipt, refund and stock record keeps working.'}
                  </span>
                </div>
              </div>

              {confirmError && (
                <div className="flex items-start gap-2 p-3 rounded-xl bg-rose-50 border border-rose-200 text-[13px] leading-5 text-rose-700">
                  <TriangleAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span className="min-w-0">{confirmError}</span>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setConfirmTarget(null)}
                  disabled={confirmBusy}
                  className="flex-1 h-12 rounded-xl border border-zinc-200 bg-white text-sm font-semibold text-zinc-800 hover:bg-zinc-50 disabled:opacity-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={runConfirmedAction}
                  disabled={confirmBusy}
                  className={`flex-1 h-12 rounded-xl text-sm font-semibold text-white disabled:opacity-60 transition-colors ${
                    confirmTarget.mode === 'delete'
                      ? 'bg-rose-600 hover:bg-rose-700'
                      : 'bg-zinc-900 hover:bg-zinc-800'
                  }`}
                >
                  {confirmBusy
                    ? 'Working…'
                    : confirmTarget.mode === 'delete'
                    ? 'Delete product'
                    : confirmTarget.mode === 'archive'
                    ? 'Archive product'
                    : 'Archive instead'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* "Print labels" needs a product; pick one rather than guess. */}
      {labelPickerOpen && (
        <div
          className={SHEET_BACKDROP}
          onClick={() => setLabelPickerOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Print barcode labels"
        >
          <div className={SHEET_PANEL} onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-zinc-100 flex items-start justify-between gap-3">
              <div className="min-w-0 flex flex-col gap-0.5">
                <span className="text-sm font-semibold text-zinc-950">Print barcode labels</span>
                <span className="text-xs text-zinc-500">
                  Choose the product to print a shelf label for.
                </span>
              </div>
              <button
                type="button"
                onClick={() => setLabelPickerOpen(false)}
                className="w-10 h-10 -mr-2 -mt-1 flex-shrink-0 flex items-center justify-center rounded-xl text-zinc-500 hover:bg-zinc-100"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {(filteredProducts.length > 0 ? filteredProducts : products).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setLabelPickerOpen(false);
                    setLabelProduct(p);
                  }}
                  className="w-full min-h-[56px] px-5 py-3 flex items-center gap-3 text-left hover:bg-zinc-50 border-b border-zinc-100"
                >
                  <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                    <span className="truncate text-sm font-semibold text-zinc-950">{p.name}</span>
                    <span className="truncate font-mono text-xs text-zinc-500">
                      {[p.sku, p.barcode].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <Printer className="w-4 h-4 flex-shrink-0 text-zinc-500" />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Modals */}
      <ProductModal
        isOpen={productModalOpen}
        onClose={() => {
          setProductModalOpen(false);
          setEditingProduct(null);
        }}
        onSave={handleSaveProduct}
        product={editingProduct}
        departments={departments}
        defaultDepartmentId={selectedDeptId === 'ALL' ? undefined : selectedDeptId}
        onDepartmentCreated={async () => {
          await refreshData();
        }}
      />

      <DepartmentModal
        isOpen={deptModalOpen}
        onClose={() => setDeptModalOpen(false)}
        departments={departments}
        onAddDepartment={handleAddDepartment}
        onDeleteDepartment={handleDeleteDepartment}
      />

      <BarcodeLabelModal
        isOpen={!!labelProduct}
        onClose={() => setLabelProduct(null)}
        product={labelProduct}
      />

      <ExcelImportModal
        isOpen={excelImportOpen}
        onClose={() => setExcelImportOpen(false)}
        departments={departments}
        onImportComplete={refreshData}
      />

      <BarcodeScannerModal
        isOpen={scannerOpen}
        onClose={() => setScannerOpen(false)}
        title="Find a product"
        subtitle="Point the camera at the barcode to filter this list"
        onScan={(barcode) => {
          const code = barcode.trim();
          const match = products.find((p) => p.barcode === code);
          // Clear the other filters, or a match could still be hidden behind them.
          setSelectedDeptId('ALL');
          setStockFilter('ALL');
          setSearchQuery(code);
          if (!match) {
            return { accepted: false, message: `No active product carries the barcode ${code}.` };
          }
          setScannerOpen(false);
          return true;
        }}
      />
    </div>
  );
};

interface StockAdjustSheetProps {
  product: Product;
  onClose: () => void;
  refreshData: () => Promise<void>;
}

/**
 * Stock in / out for one product. The old ±1 buttons posted a movement on a single
 * tap with a canned reason, so a mis-tap arrived in Movement History as a delivery.
 * Quantity and reason are both deliberate here, and the resulting count is shown
 * before anything is sent.
 */
const StockAdjustSheet: React.FC<StockAdjustSheetProps> = ({ product, onClose, refreshData }) => {
  const [mode, setMode] = useState<'IN' | 'OUT'>('IN');
  const [quantity, setQuantity] = useState(1);
  const [inReason, setInReason] = useState(STOCK_IN_REASONS[0].value);
  const [outReason, setOutReason] = useState(STOCK_OUT_REASONS[0].value);
  const [customReason, setCustomReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reasons = mode === 'OUT' ? STOCK_OUT_REASONS : STOCK_IN_REASONS;
  const selectedValue = mode === 'OUT' ? outReason : inReason;
  const reason = reasons.find((r) => r.value === selectedValue) ?? reasons[0];
  const signedChange = mode === 'OUT' ? -quantity : quantity;
  const resultingStock = product.stock_quantity + signedChange;
  // The server refuses to take stock below zero; say so before the round trip.
  const exceedsStock = mode === 'OUT' && quantity > product.stock_quantity;
  const canSubmit = quantity >= 1 && !exceedsStock && !busy;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const finalReason =
        reason.value === 'Other'
          ? customReason.trim() || (mode === 'OUT' ? 'Manual adjustment' : 'Manual stock increase')
          : reason.value;

      await api.scanAdjustStock({
        barcode: product.barcode,
        change_quantity: quantity,
        type: reason.type,
        reason: finalReason,
      });
      playScanSuccessSound();
      await refreshData();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Stock adjustment failed');
      setBusy(false);
    }
  };

  return (
    <div className={SHEET_BACKDROP} role="dialog" aria-modal="true" aria-label={`Adjust stock for ${product.name}`}>
      <div className={SHEET_PANEL}>
        <div className="px-5 py-4 border-b border-zinc-100 flex items-start justify-between gap-3">
          <div className="min-w-0 flex flex-col gap-0.5">
            <span className="truncate text-sm font-semibold text-zinc-950">{product.name}</span>
            <span className="truncate font-mono text-xs text-zinc-500">
              {[product.sku, product.barcode].filter(Boolean).join(' · ')}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="w-10 h-10 -mr-2 -mt-1 flex-shrink-0 flex items-center justify-center rounded-xl text-zinc-500 hover:bg-zinc-100 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-zinc-50 border border-zinc-100">
            <span className="text-[13px] text-zinc-500">On hand now</span>
            <span className="flex items-baseline gap-1.5">
              <span className="text-[22px] leading-7 font-extrabold text-zinc-950 tabular-nums">
                {product.stock_quantity}
              </span>
              <span className="text-[13px] text-zinc-500">
                {product.unit} · min {product.min_stock_level}
              </span>
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {(['IN', 'OUT'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                aria-pressed={mode === value}
                className={`h-11 rounded-xl text-sm font-semibold inline-flex items-center justify-center gap-2 border transition-colors ${
                  mode === value
                    ? value === 'IN'
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                      : 'bg-rose-50 border-rose-200 text-rose-700'
                    : 'bg-white border-zinc-200 text-zinc-600 hover:bg-zinc-50'
                }`}
              >
                {value === 'IN' ? <Plus className="w-4 h-4" /> : <Minus className="w-4 h-4" />}
                {value === 'IN' ? 'Stock in' : 'Stock out'}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <span className={STAT_LABEL}>Quantity</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                className={`${ICON_BTN} w-11 h-11`}
                aria-label="Decrease quantity"
              >
                <Minus className="w-4 h-4" />
              </button>
              <input
                type="number"
                min={1}
                inputMode="numeric"
                value={quantity}
                onChange={(e) => {
                  const next = parseInt(e.target.value, 10);
                  setQuantity(Number.isFinite(next) && next > 0 ? next : 1);
                }}
                aria-label="Quantity"
                className={`${FIELD} flex-1 text-center text-base font-bold tabular-nums`}
              />
              <button
                type="button"
                onClick={() => setQuantity((q) => q + 1)}
                className={`${ICON_BTN} w-11 h-11`}
                aria-label="Increase quantity"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
            <div className="flex items-center gap-2">
              {QUANTITY_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setQuantity(preset)}
                  aria-pressed={quantity === preset}
                  className={`h-9 flex-1 rounded-lg text-[13px] font-semibold tabular-nums transition-colors ${
                    quantity === preset
                      ? 'bg-zinc-900 text-white'
                      : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200/70'
                  }`}
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="adjust-reason" className={STAT_LABEL}>
              Reason
            </label>
            <select
              id="adjust-reason"
              value={selectedValue}
              onChange={(e) =>
                mode === 'OUT' ? setOutReason(e.target.value) : setInReason(e.target.value)
              }
              className={FIELD}
            >
              {reasons.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            {reason.value === 'Other' && (
              <input
                type="text"
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                placeholder="Specify custom reason…"
                aria-label="Custom reason"
                className={FIELD}
              />
            )}
            <span className="text-xs leading-4 text-zinc-500">
              Recorded in Movement History as{' '}
              <span className="font-semibold text-zinc-600">{reason.type.replace(/_/g, ' ')}</span>.
            </span>
          </div>

          <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-zinc-200">
            <span className="text-[13px] text-zinc-500">After this adjustment</span>
            <span className="flex items-center gap-2">
              <span className="text-[13px] text-zinc-500 tabular-nums">
                {product.stock_quantity} →
              </span>
              <span
                className={`text-[22px] leading-7 font-extrabold tabular-nums ${
                  exceedsStock ? 'text-rose-600' : 'text-zinc-950'
                }`}
              >
                {resultingStock}
              </span>
            </span>
          </div>

          {exceedsStock && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-50 border border-amber-200 text-[13px] leading-5 text-amber-800">
              <TriangleAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span className="min-w-0">
                Only {product.stock_quantity} {product.unit} on hand. Stock cannot go below zero.
              </span>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-rose-50 border border-rose-200 text-[13px] leading-5 text-rose-700">
              <TriangleAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span className="min-w-0">{error}</span>
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-zinc-100 flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex-1 h-12 rounded-xl border border-zinc-200 bg-white text-sm font-semibold text-zinc-800 hover:bg-zinc-50 disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="flex-2 h-12 rounded-xl bg-zinc-900 text-white text-sm font-semibold hover:bg-zinc-800 disabled:opacity-50 active:scale-98 transition-all"
          >
            {busy
              ? 'Saving…'
              : mode === 'IN'
              ? `Add ${quantity} to stock`
              : `Remove ${quantity} from stock`}
          </button>
        </div>
      </div>
    </div>
  );
};
