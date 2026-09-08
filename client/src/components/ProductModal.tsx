import React, { useState, useEffect } from 'react';
import { X, Barcode, Sparkles, Camera, Check, Loader2, Wand2 } from 'lucide-react';
import { Department, Product } from '../types';
import { BarcodeScannerModal } from './BarcodeScannerModal';
import { lookupBarcodeOnline } from '../utils/productLookup';
import { playScanSuccessSound } from '../utils/audio';
import { useHardwareBarcodeScanner } from '../utils/barcodeListener';

interface ProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (productData: Partial<Product>) => Promise<void>;
  product?: Product | null;
  departments: Department[];
  defaultDepartmentId?: number;
  initialBarcode?: string;
}

export const ProductModal: React.FC<ProductModalProps> = ({
  isOpen,
  onClose,
  onSave,
  product,
  departments,
  defaultDepartmentId,
  initialBarcode,
}) => {
  const [departmentId, setDepartmentId] = useState<number>(defaultDepartmentId || (departments[0]?.id || 1));
  const [name, setName] = useState('');
  const [barcode, setBarcode] = useState('');
  const [sku, setSku] = useState('');
  const [price, setPrice] = useState('');
  const [costPrice, setCostPrice] = useState('');
  const [stockQuantity, setStockQuantity] = useState('10');
  const [minStockLevel, setMinStockLevel] = useState('5');
  const [unit, setUnit] = useState('pcs');
  const [isSaving, setIsSaving] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [autofillSuccess, setAutofillSuccess] = useState<string | null>(null);

  const performBarcodeAutofill = async (codeToLookup: string) => {
    const clean = codeToLookup.trim();
    if (!clean || clean.length < 6) return;

    setIsLookingUp(true);
    setAutofillSuccess(null);
    try {
      const result = await lookupBarcodeOnline(clean, departments);
      if (result.found && result.name) {
        setName(result.name);
        if (result.departmentId) {
          setDepartmentId(result.departmentId);
        }
        if (result.unit) {
          setUnit(result.unit);
        }
        if (result.sku) {
          setSku(result.sku);
        }
        if (result.suggestedPrice && (!price || price === '0' || price === '0.00')) {
          setPrice(result.suggestedPrice.toFixed(2));
        }
        setAutofillSuccess(`✓ Autofilled "${result.name}" from ${result.source || 'product registry'}`);
        playScanSuccessSound();
      } else if (result.sku && !sku) {
        setSku(result.sku);
        setAutofillSuccess(`Barcode set. (Generated SKU: ${result.sku})`);
      }
    } catch (err) {
      console.warn('Autofill lookup error:', err);
    } finally {
      setIsLookingUp(false);
    }
  };

  // Hardware barcode scanner support
  useHardwareBarcodeScanner((scanned) => {
    if (isOpen && !scannerOpen) {
      setBarcode(scanned);
      performBarcodeAutofill(scanned);
    }
  });

  useEffect(() => {
    if (product) {
      setDepartmentId(product.department_id);
      setName(product.name);
      setBarcode(product.barcode);
      setSku(product.sku || '');
      setPrice(product.price.toString());
      setCostPrice(product.cost_price?.toString() || '0');
      setStockQuantity(product.stock_quantity.toString());
      setMinStockLevel(product.min_stock_level.toString());
      setUnit(product.unit || 'pcs');
    } else {
      setDepartmentId(defaultDepartmentId || (departments[0]?.id || 1));
      setName('');
      setBarcode(initialBarcode || '');
      setSku('');
      setPrice('');
      setCostPrice('');
      setStockQuantity('10');
      setMinStockLevel('5');
      setUnit('pcs');
      if (initialBarcode) {
        performBarcodeAutofill(initialBarcode);
      }
    }
    setError(null);
    setAutofillSuccess(null);
  }, [product, defaultDepartmentId, initialBarcode, isOpen, departments]);

  if (!isOpen) return null;

  const generateRandomBarcode = () => {
    // Generate a clean 13-digit EAN style barcode
    const random12 = '890' + Math.floor(100000000 + Math.random() * 900000000).toString();
    // Simple checksum
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      sum += parseInt(random12[i], 10) * (i % 2 === 0 ? 1 : 3);
    }
    const checkDigit = (10 - (sum % 10)) % 10;
    setBarcode(random12 + checkDigit);
  };

  const handleDepartmentChange = (newDeptId: number) => {
    setDepartmentId(newDeptId);
    if (!sku && !product) {
      const selectedDept = departments.find((d) => d.id === newDeptId);
      if (selectedDept) {
        setSku(`${selectedDept.code}-${Math.floor(100 + Math.random() * 900)}`);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Product name is required');
      return;
    }
    if (!barcode.trim()) {
      setError('Barcode is required');
      return;
    }
    if (!price || parseFloat(price) <= 0) {
      setError('Valid selling price is required');
      return;
    }

    try {
      setIsSaving(true);
      await onSave({
        department_id: Number(departmentId),
        name: name.trim(),
        barcode: barcode.trim(),
        sku: sku.trim() || undefined,
        price: parseFloat(price),
        cost_price: costPrice ? parseFloat(costPrice) : 0,
        stock_quantity: parseInt(stockQuantity, 10) || 0,
        min_stock_level: parseInt(minStockLevel, 10) || 5,
        unit: unit.trim() || 'pcs',
      });
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to save product');
    } finally {
      setIsSaving(false);
    }
  };

  const handleOpenScanner = () => {
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setScannerOpen(true);
  };

  return (
    <>
      <div className="fixed inset-0 z-40 flex items-center justify-center p-3 sm:p-4 bg-zinc-950/60 backdrop-blur-sm animate-in fade-in duration-150">
        <div className="relative w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-zinc-200 overflow-hidden flex flex-col max-h-[92vh]">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-100">
            <div>
              <h3 className="text-base font-semibold text-zinc-900">
                {product ? 'Edit Product' : 'Add Product to Inventory'}
              </h3>
              <p className="text-xs text-zinc-500 mt-0.5">
                Department-categorized inventory item with barcode tracking
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 text-zinc-400 hover:text-zinc-700 rounded-lg hover:bg-zinc-100"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-4">
            {error && (
              <div className="p-3 text-xs bg-rose-50 border border-rose-200 text-rose-700 rounded-xl">
                {error}
              </div>
            )}

            {/* Department Selection */}
            <div>
              <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-1.5">
                Department *
              </label>
              <select
                value={departmentId}
                onChange={(e) => handleDepartmentChange(Number(e.target.value))}
                className="w-full px-3 py-2.5 text-sm bg-white border border-zinc-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900 font-medium"
                required
              >
                {departments.map((dept) => (
                  <option key={dept.id} value={dept.id}>
                    {dept.name} ({dept.code})
                  </option>
                ))}
              </select>
            </div>

            {/* Product Name */}
            <div>
              <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-1.5">
                Product Name *
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Organic Almond Milk 1L"
                className="w-full px-3 py-2 text-sm bg-white border border-zinc-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900 placeholder:text-zinc-400"
                required
              />
            </div>

            {/* Barcode with Scan, Auto-Fill, & Generate Helpers */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-zinc-700 uppercase tracking-wider">
                  Barcode (UPC / EAN / Code 128) *
                </label>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleOpenScanner}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-600 hover:text-indigo-700 px-2 py-0.5 rounded-md hover:bg-indigo-50 border border-indigo-100"
                  >
                    <Camera className="w-3 h-3" />
                    Scan
                  </button>
                  <button
                    type="button"
                    onClick={() => performBarcodeAutofill(barcode)}
                    disabled={isLookingUp || !barcode.trim()}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 hover:text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-2 py-0.5 rounded-md transition-colors disabled:opacity-40"
                    title="Lookup product name and details online"
                  >
                    {isLookingUp ? (
                      <Loader2 className="w-3 h-3 animate-spin text-emerald-600" />
                    ) : (
                      <Wand2 className="w-3 h-3 text-emerald-600" />
                    )}
                    <span>{isLookingUp ? 'Searching...' : 'Auto-Fill'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={generateRandomBarcode}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-600 hover:text-zinc-900 px-2 py-0.5 rounded-md hover:bg-zinc-100"
                  >
                    <Sparkles className="w-3 h-3 text-amber-500" />
                    Generate
                  </button>
                </div>
              </div>

              <div className="relative">
                <Barcode className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={barcode}
                  onChange={(e) => setBarcode(e.target.value)}
                  placeholder="Scan or type barcode (e.g. 8901234567890)"
                  className="w-full pl-9 pr-3 py-2 text-sm font-mono bg-white border border-zinc-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900 placeholder:text-zinc-400"
                  required
                />
              </div>

              {/* Online Lookup Status */}
              {isLookingUp && (
                <div className="mt-2 flex items-center gap-2 p-2 bg-indigo-50 border border-indigo-200 text-indigo-700 text-xs rounded-xl animate-pulse">
                  <Loader2 className="w-4 h-4 animate-spin text-indigo-600 flex-shrink-0" />
                  <span>Searching global product database for barcode details...</span>
                </div>
              )}

              {autofillSuccess && !isLookingUp && (
                <div className="mt-2 flex items-center gap-2 p-2 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs rounded-xl font-medium">
                  <Check className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                  <span className="truncate">{autofillSuccess}</span>
                </div>
              )}
            </div>

            {/* Price & Cost */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-1.5">
                  Retail Price ($) *
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0.00"
                  className="w-full px-3 py-2 text-sm bg-white border border-zinc-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-1.5">
                  Cost Price ($)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={costPrice}
                  onChange={(e) => setCostPrice(e.target.value)}
                  placeholder="0.00"
                  className="w-full px-3 py-2 text-sm bg-white border border-zinc-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
                />
              </div>
            </div>

            {/* Stock Quantity, Min Level & Unit */}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-1.5">
                  {product ? 'Current Stock' : 'Initial Stock'}
                </label>
                <input
                  type="number"
                  min="0"
                  value={stockQuantity}
                  onChange={(e) => setStockQuantity(e.target.value)}
                  disabled={!!product} // In edit mode, stock should be adjusted via stock movement / scanner
                  className={`w-full px-3 py-2 text-sm border border-zinc-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 ${
                    product ? 'bg-zinc-100 text-zinc-500 cursor-not-allowed' : 'bg-white'
                  }`}
                />
                {product && (
                  <span className="text-[10px] text-zinc-400 mt-1 block">
                    Use Stock In/Out scanner to adjust
                  </span>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-1.5">
                  Low Stock Alert
                </label>
                <input
                  type="number"
                  min="0"
                  value={minStockLevel}
                  onChange={(e) => setMinStockLevel(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-white border border-zinc-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-1.5">
                  Unit
                </label>
                <input
                  type="text"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  placeholder="pcs, kg, bottle"
                  className="w-full px-3 py-2 text-sm bg-white border border-zinc-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900"
                />
              </div>
            </div>

            {/* SKU (Optional) */}
            <div>
              <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-1.5">
                SKU / Item Code <span className="text-zinc-400 font-normal">(Optional)</span>
              </label>
              <input
                type="text"
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                placeholder="e.g. BEV-092"
                className="w-full px-3 py-2 text-sm font-mono bg-white border border-zinc-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900 placeholder:text-zinc-400"
              />
            </div>

            {/* Actions */}
            <div className="pt-3 flex gap-3">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 px-4 py-2.5 text-xs font-semibold text-zinc-700 bg-zinc-100 hover:bg-zinc-200 rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSaving}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-zinc-900 hover:bg-zinc-800 disabled:opacity-50 rounded-xl transition-colors shadow-sm"
              >
                <Check className="w-4 h-4" />
                {isSaving ? 'Saving...' : product ? 'Save Changes' : 'Add to Inventory'}
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Embedded Barcode Camera Scanner */}
      <BarcodeScannerModal
        isOpen={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScan={(scanned) => {
          setBarcode(scanned);
          setScannerOpen(false);
          performBarcodeAutofill(scanned);
        }}
        title="Scan Barcode for Product"
      />
    </>
  );
};
