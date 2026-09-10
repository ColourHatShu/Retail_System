import React, { useState, useEffect } from 'react';
import { X, Barcode, Sparkles, Camera, Check, Loader2, Wand2, Plus, FolderPlus } from 'lucide-react';
import { Department, Product } from '../types';
import { BarcodeScannerModal } from './BarcodeScannerModal';
import { lookupBarcodeOnline } from '../utils/productLookup';
import { playScanSuccessSound } from '../utils/audio';
import { useHardwareBarcodeScanner } from '../utils/barcodeListener';
import { api } from '../utils/api';

interface ProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (productData: Partial<Product>) => Promise<void>;
  product?: Product | null;
  departments: Department[];
  defaultDepartmentId?: number;
  initialBarcode?: string;
  onDepartmentCreated?: (dept: Department) => Promise<void> | void;
}

export const ProductModal: React.FC<ProductModalProps> = ({
  isOpen,
  onClose,
  onSave,
  product,
  departments,
  defaultDepartmentId,
  initialBarcode,
  onDepartmentCreated,
}) => {
  // 0 means "nothing chosen". Falling back to departments[0] used to file an
  // unmatched product under whichever department happened to sort first, with
  // nothing on screen saying so. handleSubmit refuses to save while it is 0.
  const [departmentId, setDepartmentId] = useState<number>(defaultDepartmentId || 0);
  const [name, setName] = useState('');
  const [barcode, setBarcode] = useState('');
  const [sku, setSku] = useState('');
  const [price, setPrice] = useState('');
  const [costPrice, setCostPrice] = useState('');
  const [stockQuantity, setStockQuantity] = useState('1');
  const [minStockLevel, setMinStockLevel] = useState('5');
  const [unit, setUnit] = useState('pcs');
  const [isSaving, setIsSaving] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [autofillSuccess, setAutofillSuccess] = useState<string | null>(null);

  // Quick Inline Department Creation State
  const [localDepartments, setLocalDepartments] = useState<Department[]>(departments);
  const [showNewDeptForm, setShowNewDeptForm] = useState(false);
  const [newDeptName, setNewDeptName] = useState('');
  const [newDeptCode, setNewDeptCode] = useState('');
  const [newDeptCodeTouched, setNewDeptCodeTouched] = useState(false);
  const [newDeptColor, setNewDeptColor] = useState('#0ea5e9');
  const [isCreatingDept, setIsCreatingDept] = useState(false);

  useEffect(() => {
    setLocalDepartments(departments);
  }, [departments]);

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
        // Price is never autofilled: the registries quote figures in US dollars,
        // and writing one into the price field would misprice the product.
        const source = result.source || 'product registry';
        setAutofillSuccess(
          result.departmentId
            ? `✓ Autofilled "${result.name}" from ${source}`
            : `✓ Autofilled "${result.name}" from ${source} — please choose a department`,
        );
        playScanSuccessSound();
      } else {
        if (result.sku && !sku) setSku(result.sku);
        setAutofillSuccess('Not in the product registries — please type the name and price.');
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
      setShowNewDeptForm(false);
    } else {
      setDepartmentId(defaultDepartmentId || 0);
      setName('');
      setBarcode(initialBarcode || '');
      setSku('');
      setPrice('');
      setCostPrice('');
      setStockQuantity('1');
      setMinStockLevel('5');
      setUnit('pcs');
      if (departments.length === 0) {
        setShowNewDeptForm(true);
      } else {
        setShowNewDeptForm(false);
      }
      if (initialBarcode) {
        performBarcodeAutofill(initialBarcode);
      }
    }
    setError(null);
    setAutofillSuccess(null);
  // `departments` is deliberately NOT a dependency. App rebuilds that array on
  // every refreshData(), and including it re-ran this whole reset — blanking a
  // half-typed product mid-entry, and re-triggering the barcode lookup.
  }, [product, defaultDepartmentId, initialBarcode, isOpen]);

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
      const selectedDept = localDepartments.find((d) => d.id === newDeptId);
      if (selectedDept) {
        setSku(`${selectedDept.code}-${Math.floor(100 + Math.random() * 900)}`);
      }
    }
  };

  // Quick Create Department Handler
  const handleCreateQuickDepartment = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleanName = newDeptName.trim();
    if (!cleanName) {
      setError('Please enter a department name');
      return;
    }

    const cleanCode = (
      newDeptCode.trim() ||
      cleanName.replace(/[^a-zA-Z]/g, '').slice(0, 4) ||
      'DEPT'
    ).toUpperCase();

    try {
      setIsCreatingDept(true);
      setError(null);
      const created = await api.createDepartment({
        name: cleanName,
        code: cleanCode,
        color: newDeptColor,
      });

      setLocalDepartments((prev) => [...prev.filter((d) => d.id !== created.id), created]);
      setDepartmentId(created.id);
      setShowNewDeptForm(false);
      setNewDeptName('');
      setNewDeptCode('');
      setNewDeptCodeTouched(false);

      if (!sku) {
        setSku(`${cleanCode}-${Math.floor(100 + Math.random() * 900)}`);
      }

      playScanSuccessSound();
      setAutofillSuccess(`✓ Department "${created.name}" created and selected`);
      setTimeout(() => setAutofillSuccess(null), 3500);

      if (onDepartmentCreated) {
        await onDepartmentCreated(created);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to create department');
    } finally {
      setIsCreatingDept(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    let activeDeptId = departmentId;

    // If user filled in quick department fields, auto-create it now
    if ((!activeDeptId || showNewDeptForm) && newDeptName.trim()) {
      try {
        setIsCreatingDept(true);
        const cleanCode = (
          newDeptCode.trim() ||
          newDeptName.trim().replace(/[^a-zA-Z]/g, '').slice(0, 4) ||
          'DEPT'
        ).toUpperCase();
        const created = await api.createDepartment({
          name: newDeptName.trim(),
          code: cleanCode,
          color: newDeptColor,
        });
        activeDeptId = created.id;
        setDepartmentId(created.id);
        setLocalDepartments((prev) => [...prev.filter((d) => d.id !== created.id), created]);
        setShowNewDeptForm(false);
        if (onDepartmentCreated) {
          await onDepartmentCreated(created);
        }
      } catch (deptErr: any) {
        setError(deptErr.message || 'Failed to create department');
        setIsCreatingDept(false);
        return;
      } finally {
        setIsCreatingDept(false);
      }
    }

    if (!activeDeptId || activeDeptId === 0) {
      setError('Please select or create a department for this product');
      return;
    }

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
        department_id: Number(activeDeptId),
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

            {/* Department Selection & Dropdown Creator */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-zinc-700 uppercase tracking-wider">
                  Department *
                </label>
                <button
                  type="button"
                  onClick={() => setShowNewDeptForm(!showNewDeptForm)}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 transition-colors"
                >
                  <Plus className="w-3 h-3" />
                  <span>{showNewDeptForm ? 'Cancel Dept' : '+ Add New Department'}</span>
                </button>
              </div>

              <select
                value={showNewDeptForm ? '__NEW__' : departmentId || ''}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === '__NEW__') {
                    setShowNewDeptForm(true);
                  } else {
                    setShowNewDeptForm(false);
                    handleDepartmentChange(Number(val));
                  }
                }}
                className="w-full px-3 py-2.5 text-sm bg-white border border-zinc-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900 font-medium"
                required={!showNewDeptForm}
              >
                {localDepartments.length === 0 ? (
                  <option value="__NEW__">➕ + Add New Department...</option>
                ) : (
                  <>
                    <option value="" disabled>
                      Select Department
                    </option>
                    {localDepartments.map((dept) => (
                      <option key={dept.id} value={dept.id}>
                        {dept.name} ({dept.code})
                      </option>
                    ))}
                    <option value="__NEW__">➕ + Add New Department...</option>
                  </>
                )}
              </select>

              {/* Inline Quick Department Creator Form */}
              {showNewDeptForm && (
                <div className="p-3.5 bg-zinc-50 border border-zinc-200/90 rounded-xl space-y-3 animate-in fade-in slide-in-from-top-2 duration-150 shadow-2xs">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-zinc-900 flex items-center gap-1.5">
                      <FolderPlus className="w-3.5 h-3.5 text-indigo-600" />
                      Create New Department
                    </span>
                    {localDepartments.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowNewDeptForm(false)}
                        className="text-[11px] text-zinc-400 hover:text-zinc-700"
                      >
                        Cancel
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div>
                      <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">
                        Department Name *
                      </label>
                      <input
                        type="text"
                        value={newDeptName}
                        onChange={(e) => {
                          const val = e.target.value;
                          setNewDeptName(val);
                          if (!newDeptCodeTouched) {
                            const code = val.replace(/[^a-zA-Z]/g, '').slice(0, 4).toUpperCase();
                            setNewDeptCode(code);
                          }
                        }}
                        placeholder="e.g. Beverages, Snacks..."
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-zinc-300 rounded-lg focus:ring-2 focus:ring-zinc-900 focus:outline-none"
                        autoFocus
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">
                        Short Code *
                      </label>
                      <input
                        type="text"
                        value={newDeptCode}
                        onChange={(e) => {
                          setNewDeptCodeTouched(true);
                          setNewDeptCode(e.target.value.toUpperCase());
                        }}
                        placeholder="e.g. BEV"
                        className="w-full px-2.5 py-1.5 text-xs font-mono uppercase bg-white border border-zinc-300 rounded-lg focus:ring-2 focus:ring-zinc-900 focus:outline-none"
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-zinc-400 font-medium">Color:</span>
                      {[
                        '#0ea5e9',
                        '#10b981',
                        '#f59e0b',
                        '#ec4899',
                        '#8b5cf6',
                        '#6366f1',
                        '#14b8a6',
                        '#f43f5e',
                      ].map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setNewDeptColor(c)}
                          className={`w-4 h-4 rounded-full border-2 transition-transform ${
                            newDeptColor === c
                              ? 'border-zinc-900 scale-125'
                              : 'border-transparent hover:scale-110'
                          }`}
                          style={{ backgroundColor: c }}
                        />
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={handleCreateQuickDepartment}
                      disabled={isCreatingDept || !newDeptName.trim()}
                      className="px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-50 text-white text-xs font-bold rounded-lg shadow-xs flex items-center gap-1.5 transition-all active:scale-95"
                    >
                      {isCreatingDept ? (
                        <Loader2 className="w-3 h-3 animate-spin text-white" />
                      ) : (
                        <Check className="w-3 h-3 text-emerald-400" />
                      )}
                      <span>Create & Select</span>
                    </button>
                  </div>
                </div>
              )}
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
