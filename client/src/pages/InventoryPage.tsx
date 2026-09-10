import React, { useState, useMemo } from 'react';
import {
  Search,
  Plus,
  Filter,
  AlertTriangle,
  FolderTree,
  Barcode as BarcodeIcon,
  Edit2,
  Trash2,
  ArrowUpRight,
  Printer,
  ChevronDown,
  FileSpreadsheet,
  Package,
} from 'lucide-react';
import { Department, Product } from '../types';
import { api, ApiError } from '../utils/api';
import { ProductModal } from '../components/ProductModal';
import { DepartmentModal } from '../components/DepartmentModal';
import { BarcodeLabelModal } from '../components/BarcodeLabelModal';
import { ExcelImportModal } from '../components/ExcelImportModal';
import { playScanSuccessSound } from '../utils/audio';

interface InventoryPageProps {
  products: Product[];
  departments: Department[];
  refreshData: () => Promise<void>;
}

export const InventoryPage: React.FC<InventoryPageProps> = ({
  products,
  departments,
  refreshData,
}) => {
  const [selectedDeptId, setSelectedDeptId] = useState<number | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [showLowStockOnly, setShowLowStockOnly] = useState(false);
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [deptModalOpen, setDeptModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [labelProduct, setLabelProduct] = useState<Product | null>(null);
  const [excelImportOpen, setExcelImportOpen] = useState(false);
  const [isAdjusting, setIsAdjusting] = useState<number | null>(null);

  // Filtered list
  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      const matchDept = selectedDeptId === 'ALL' || p.department_id === selectedDeptId;
      const matchSearch =
        !searchQuery ||
        p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.barcode.includes(searchQuery) ||
        (p.sku && p.sku.toLowerCase().includes(searchQuery.toLowerCase()));
      const matchLowStock = !showLowStockOnly || p.stock_quantity <= p.min_stock_level;
      return matchDept && matchSearch && matchLowStock;
    });
  }, [products, selectedDeptId, searchQuery, showLowStockOnly]);

  // Overall Inventory Stats
  const stats = useMemo(() => {
    const totalStock = products.reduce((acc, p) => acc + p.stock_quantity, 0);
    const totalValuation = products.reduce((acc, p) => acc + p.stock_quantity * p.price, 0);
    const lowStockCount = products.filter((p) => p.stock_quantity <= p.min_stock_level && p.stock_quantity > 0).length;
    const outOfStockCount = products.filter((p) => p.stock_quantity <= 0).length;

    return { totalStock, totalValuation, lowStockCount, outOfStockCount };
  }, [products]);

  // Quick Stock Step (+1 or -1) directly from inventory table
  const handleQuickAdjust = async (product: Product, delta: number) => {
    try {
      setIsAdjusting(product.id);
      await api.scanAdjustStock({
        barcode: product.barcode,
        change_quantity: Math.abs(delta),
        type: delta > 0 ? 'RESTOCK' : 'ADJUSTMENT_REMOVE',
        reason: delta > 0 ? 'Quick stock increase' : 'Quick manual deduction',
      });
      playScanSuccessSound();
      await refreshData();
    } catch (err: any) {
      alert(err.message || 'Stock adjustment failed');
    } finally {
      setIsAdjusting(null);
    }
  };

  const handleSaveProduct = async (data: Partial<Product>) => {
    if (editingProduct) {
      await api.updateProduct(editingProduct.id, data);
    } else {
      await api.createProduct(data);
    }
    await refreshData();
  };

  const handleDeleteProduct = async (id: number, name: string) => {
    if (!confirm(`Are you sure you want to delete "${name}" from inventory?`)) return;
    try {
      await api.deleteProduct(id);
      await refreshData();
    } catch (err) {
      // A product that has been sold cannot be deleted — its receipt lines would
      // be left pointing at nothing. Offer what the user actually wants instead
      // of leaving them at a dead end.
      if (err instanceof ApiError && err.code === 'HAS_HISTORY') {
        const archive = confirm(
          `"${name}" has already been sold, so it cannot be deleted — the receipts it appears on would be left pointing at nothing.\n\n` +
            `Archive it instead?\n\n` +
            `It disappears from the register and this list, but every receipt, refund and stock record keeps working.`,
        );
        if (archive) {
          await api.archiveProduct(id);
          await refreshData();
        }
        return;
      }
      alert(err instanceof Error ? err.message : 'Failed to delete product');
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

  return (
    <div className="w-full max-w-full min-w-0 px-2.5 sm:px-6 py-3 sm:py-6 space-y-4 sm:space-y-6 pb-24 md:pb-8 overflow-x-hidden">
      {/* Top Header & Stat Tiles */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
        <div>
          <h2 className="text-lg sm:text-xl font-bold tracking-tight text-zinc-950">
            Department-Wise Inventory
          </h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            Manage your catalog, stock levels, and barcode identifiers
          </p>
        </div>

        <div className="flex items-center flex-wrap gap-2">
          <button
            onClick={() => setExcelImportOpen(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-xl shadow-xs transition-colors"
          >
            <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
            <span className="hidden xs:inline">Import via</span> Excel
          </button>
          <button
            onClick={() => setDeptModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-zinc-700 bg-white hover:bg-zinc-50 border border-zinc-200 rounded-xl shadow-xs transition-colors"
          >
            <FolderTree className="w-4 h-4 text-zinc-600" />
            Depts ({departments.length})
          </button>
          <button
            onClick={() => {
              setEditingProduct(null);
              setProductModalOpen(true);
            }}
            className="flex items-center gap-1.5 px-3.5 sm:px-4 py-2 text-xs font-semibold text-white bg-zinc-900 hover:bg-zinc-800 rounded-xl shadow-sm transition-all"
          >
            <Plus className="w-4 h-4" />
            Add Product
          </button>
        </div>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
        <div className="p-3.5 sm:p-4 bg-white rounded-2xl border border-zinc-200/80 shadow-xs">
          <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
            Total Catalog Items
          </span>
          <div className="text-xl font-bold text-zinc-950 mt-1">{products.length}</div>
          <span className="text-[11px] text-zinc-400 mt-0.5 block">
            Across {departments.length} departments
          </span>
        </div>

        <div className="p-3.5 sm:p-4 bg-white rounded-2xl border border-zinc-200/80 shadow-xs">
          <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
            Total Stock On Hand
          </span>
          <div className="text-xl font-bold text-zinc-950 mt-1 font-mono">
            {stats.totalStock.toLocaleString()}
          </div>
          <span className="text-[11px] text-zinc-400 mt-0.5 block">Individual units</span>
        </div>

        <div className="p-3.5 sm:p-4 bg-white rounded-2xl border border-zinc-200/80 shadow-xs">
          <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
            Inventory Valuation
          </span>
          <div className="text-xl font-bold text-emerald-700 mt-1">
            ${stats.totalValuation.toFixed(2)}
          </div>
          <span className="text-[11px] text-zinc-400 mt-0.5 block">At retail price</span>
        </div>

        <div className="p-3.5 sm:p-4 bg-white rounded-2xl border border-zinc-200/80 shadow-xs">
          <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
            Stock Alerts
          </span>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xl font-bold text-amber-600">
              {stats.lowStockCount} Low
            </span>
            <span className="text-zinc-300">•</span>
            <span className="text-xl font-bold text-rose-600">
              {stats.outOfStockCount} Out
            </span>
          </div>
          <span className="text-[11px] text-zinc-400 mt-0.5 block">Requires replenishment</span>
        </div>
      </div>

      {/* Filter & Department Tabs */}
      <div className="bg-white p-4 rounded-2xl border border-zinc-200/80 shadow-sm space-y-4">
        {/* Search & Low Stock Toggle */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter by name, barcode, or SKU..."
              className="w-full pl-9 pr-3 py-2 text-xs bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:bg-white"
            />
          </div>

          <button
            onClick={() => setShowLowStockOnly(!showLowStockOnly)}
            className={`flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-xl border transition-colors ${
              showLowStockOnly
                ? 'bg-amber-50 text-amber-800 border-amber-300'
                : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50'
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
            Low Stock Only ({stats.lowStockCount + stats.outOfStockCount})
          </button>
        </div>

        {/* Department Filter Pills */}
        <div className="w-full max-w-full min-w-0 overflow-x-auto pb-1 no-scrollbar">
          <div className="flex items-center gap-1.5 text-xs w-max">
            <button
              onClick={() => setSelectedDeptId('ALL')}
              className={`px-3 py-1.5 rounded-lg font-semibold whitespace-nowrap transition-colors ${
                selectedDeptId === 'ALL'
                  ? 'bg-zinc-900 text-white shadow-xs'
                  : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200/70'
              }`}
            >
              All Departments ({products.length})
            </button>

            {departments.map((dept) => {
              const isSelected = selectedDeptId === dept.id;
              return (
                <button
                  key={dept.id}
                  onClick={() => setSelectedDeptId(dept.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-semibold whitespace-nowrap transition-colors ${
                    isSelected
                      ? 'bg-zinc-900 text-white shadow-xs'
                      : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200/70'
                  }`}
                >
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: dept.color || '#4f46e5' }}
                  />
                  <span>{dept.name}</span>
                  <span className="text-[10px] opacity-70">({dept.product_count || 0})</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Inventory Products Table */}
      <div className="bg-white rounded-2xl border border-zinc-200/80 shadow-sm overflow-hidden w-full max-w-full min-w-0">
        <div className="overflow-x-auto w-full max-w-full">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="bg-zinc-50/80 text-zinc-500 font-semibold border-b border-zinc-200 uppercase tracking-wider text-[10px]">
              <tr>
                <th className="py-3.5 pl-4 pr-3">Product / Barcode</th>
                <th className="py-3.5 px-3">Department</th>
                <th className="py-3.5 px-3 text-right">Price</th>
                <th className="py-3.5 px-3 text-right">Cost</th>
                <th className="py-3.5 px-3 text-center">Stock Level</th>
                <th className="py-3.5 px-3 text-center">Quick Adjust</th>
                <th className="py-3.5 pl-3 pr-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {filteredProducts.map((p) => {
                const isOutOfStock = p.stock_quantity <= 0;
                const isLowStock = p.stock_quantity <= p.min_stock_level && !isOutOfStock;

                return (
                  <tr key={p.id} className="hover:bg-zinc-50/70 transition-colors">
                    {/* Name & Barcode */}
                    <td className="py-3 pl-4 pr-3">
                      <div className="font-semibold text-zinc-900 text-xs">{p.name}</div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="font-mono text-[11px] text-zinc-500 flex items-center gap-1">
                          <BarcodeIcon className="w-3 h-3 text-zinc-400" />
                          {p.barcode}
                        </span>
                        {p.sku && (
                          <span className="text-[10px] font-mono text-zinc-400 bg-zinc-100 px-1 rounded">
                            {p.sku}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Department Badge */}
                    <td className="py-3 px-3">
                      <span
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold"
                        style={{
                          backgroundColor: `${p.department_color || '#4f46e5'}18`,
                          color: p.department_color || '#4f46e5',
                        }}
                      >
                        <span
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ backgroundColor: p.department_color || '#4f46e5' }}
                        />
                        {p.department_name}
                      </span>
                    </td>

                    {/* Price */}
                    <td className="py-3 px-3 text-right font-bold text-zinc-950">
                      ${Number(p.price).toFixed(2)}
                    </td>

                    {/* Cost */}
                    <td className="py-3 px-3 text-right text-zinc-500">
                      ${Number(p.cost_price || 0).toFixed(2)}
                    </td>

                    {/* Stock Level */}
                    <td className="py-3 px-3 text-center">
                      <div className="inline-flex flex-col items-center">
                        <span
                          className={`px-2 py-0.5 rounded-md font-mono text-xs font-bold ${
                            isOutOfStock
                              ? 'bg-rose-100 text-rose-700'
                              : isLowStock
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-emerald-50 text-emerald-800'
                          }`}
                        >
                          {p.stock_quantity} {p.unit}
                        </span>
                        {isLowStock && (
                          <span className="text-[9px] text-amber-600 font-semibold mt-0.5">
                            Min: {p.min_stock_level}
                          </span>
                        )}
                        {isOutOfStock && (
                          <span className="text-[9px] text-rose-600 font-semibold mt-0.5">
                            Out of Stock
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Quick Adjust Buttons (+ / -) */}
                    <td className="py-3 px-3 text-center">
                      <div className="inline-flex items-center gap-1 bg-zinc-100 p-1 rounded-lg">
                        <button
                          onClick={() => handleQuickAdjust(p, -1)}
                          disabled={isAdjusting === p.id || p.stock_quantity <= 0}
                          className="w-6 h-6 rounded bg-white hover:bg-zinc-200 text-zinc-700 disabled:opacity-40 flex items-center justify-center font-bold text-xs shadow-xs"
                          title="Reduce stock by 1"
                        >
                          -1
                        </button>
                        <button
                          onClick={() => handleQuickAdjust(p, 1)}
                          disabled={isAdjusting === p.id}
                          className="w-6 h-6 rounded bg-white hover:bg-zinc-200 text-zinc-700 disabled:opacity-40 flex items-center justify-center font-bold text-xs shadow-xs"
                          title="Increase stock by 1"
                        >
                          +1
                        </button>
                      </div>
                    </td>

                    {/* Actions */}
                    <td className="py-3 pl-3 pr-4 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          onClick={() => setLabelProduct(p)}
                          className="p-1.5 text-zinc-400 hover:text-zinc-900 rounded-lg hover:bg-zinc-100 transition-colors"
                          title="Generate and print barcode label"
                        >
                          <Printer className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => {
                            setEditingProduct(p);
                            setProductModalOpen(true);
                          }}
                          className="p-1.5 text-zinc-400 hover:text-zinc-900 rounded-lg hover:bg-zinc-100 transition-colors"
                          title="Edit product"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDeleteProduct(p.id, p.name)}
                          className="p-1.5 text-zinc-400 hover:text-rose-600 rounded-lg hover:bg-rose-50 transition-colors"
                          title="Delete product"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {products.length === 0 ? (
            <div className="p-8 sm:p-12 text-center text-zinc-500 space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-zinc-100 flex items-center justify-center mx-auto text-zinc-400">
                <Package className="w-6 h-6" />
              </div>
              <h3 className="text-sm font-bold text-zinc-900">Your Inventory is Currently Empty</h3>
              <p className="text-xs text-zinc-500 max-w-sm mx-auto mt-1">
                Add products manually, import catalog from Excel, or scan product barcodes.
              </p>
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditingProduct(null);
                    setProductModalOpen(true);
                  }}
                  className="px-4 py-2 bg-zinc-900 text-white text-xs font-semibold rounded-xl hover:bg-zinc-800 transition-all shadow-xs"
                >
                  + Add First Product
                </button>
              </div>
            </div>
          ) : filteredProducts.length === 0 ? (
            <div className="p-12 text-center text-zinc-400">
              <BarcodeIcon className="w-8 h-8 mx-auto mb-2 text-zinc-300" />
              <p className="text-sm font-semibold text-zinc-700">No products match your filters</p>
              <p className="text-xs text-zinc-400 mt-0.5">
                Try clearing search filters or add a new product.
              </p>
            </div>
          ) : null}
        </div>
      </div>

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
    </div>
  );
};
