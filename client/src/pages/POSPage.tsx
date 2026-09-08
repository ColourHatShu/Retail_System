import React, { useState, useMemo } from 'react';
import {
  Search,
  Camera,
  Plus,
  Minus,
  Trash2,
  CreditCard,
  Banknote,
  QrCode,
  ArrowRight,
  ShoppingBag,
  AlertTriangle,
  Barcode as BarcodeIcon,
  Check,
} from 'lucide-react';
import { Department, Product, CartItem, Sale } from '../types';
import { api } from '../utils/api';
import { playScanSuccessSound, playPaymentSuccessSound, playScanErrorSound } from '../utils/audio';
import { BarcodeScannerModal } from '../components/BarcodeScannerModal';
import { ReceiptModal } from '../components/ReceiptModal';
import { useHardwareBarcodeScanner } from '../utils/barcodeListener';

interface POSPageProps {
  products: Product[];
  departments: Department[];
  refreshData: () => Promise<void>;
  cart: CartItem[];
  setCart: React.Dispatch<React.SetStateAction<CartItem[]>>;
}

export const POSPage: React.FC<POSPageProps> = ({
  products,
  departments,
  refreshData,
  cart,
  setCart,
}) => {
  const [selectedDeptId, setSelectedDeptId] = useState<number | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [checkoutModalOpen, setCheckoutModalOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'CARD' | 'UPI_QR' | 'SPLIT'>('CASH');
  const [amountTendered, setAmountTendered] = useState<string>('');
  const [customerName, setCustomerName] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [completedSale, setCompletedSale] = useState<Sale | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [mobileCartOpen, setMobileCartOpen] = useState(false);

  // Cart calculations
  const subtotal = useMemo(() => {
    return cart.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
  }, [cart]);

  const taxRate = 5.0; // 5% default tax
  const taxAmount = useMemo(() => (subtotal * taxRate) / 100, [subtotal]);
  const total = useMemo(() => subtotal + taxAmount, [subtotal, taxAmount]);

  const changeDue = useMemo(() => {
    const tendered = parseFloat(amountTendered);
    if (isNaN(tendered) || tendered < total) return 0;
    return tendered - total;
  }, [amountTendered, total]);

  // Handle adding product to cart (or incrementing)
  const addToCart = (product: Product) => {
    if (product.stock_quantity <= 0) {
      playScanErrorSound();
      alert(`"${product.name}" is out of stock!`);
      return;
    }

    setCart((prev) => {
      const existing = prev.find((item) => item.product.id === product.id);
      if (existing) {
        if (existing.quantity >= product.stock_quantity) {
          playScanErrorSound();
          alert(`Maximum available stock reached (${product.stock_quantity})`);
          return prev;
        }
        return prev.map((item) =>
          item.product.id === product.id
            ? { ...item, quantity: item.quantity + 1 }
            : item
        );
      } else {
        return [...prev, { product, quantity: 1, unit_price: product.price }];
      }
    });
    playScanSuccessSound();
  };

  const updateQuantity = (productId: number, delta: number) => {
    setCart((prev) => {
      return prev
        .map((item) => {
          if (item.product.id === productId) {
            const newQty = item.quantity + delta;
            if (newQty > item.product.stock_quantity) {
              alert(`Maximum available stock reached (${item.product.stock_quantity})`);
              return item;
            }
            return { ...item, quantity: newQty };
          }
          return item;
        })
        .filter((item) => item.quantity > 0);
    });
  };

  const removeFromCart = (productId: number) => {
    setCart((prev) => prev.filter((item) => item.product.id !== productId));
  };

  const clearCart = () => {
    if (cart.length === 0) return;
    if (confirm('Clear current order?')) {
      setCart([]);
    }
  };

  // Barcode scanned either from Camera or Hardware Laser Scanner
  const handleBarcodeScanned = (barcode: string) => {
    const clean = barcode.trim();
    const found = products.find((p) => p.barcode === clean);
    if (found) {
      addToCart(found);
    } else {
      playScanErrorSound();
      alert(`No product found with barcode "${clean}"`);
    }
  };

  // Active hardware wedge listener
  useHardwareBarcodeScanner(handleBarcodeScanned);

  // Filter products by department and search
  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      const matchesDept = selectedDeptId === 'ALL' || p.department_id === selectedDeptId;
      const matchesSearch =
        !searchQuery ||
        p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.barcode.includes(searchQuery) ||
        (p.sku && p.sku.toLowerCase().includes(searchQuery.toLowerCase()));
    });
  }, [products, selectedDeptId, searchQuery]);

  // Open Camera Scanner safely dismissing any virtual keyboard
  const handleOpenScanner = () => {
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setScannerOpen(true);
  };

  // Open Checkout Modal
  const openCheckout = () => {
    if (cart.length === 0) return;
    setCheckoutError(null);
    setPaymentMethod('CASH');
    setAmountTendered(total.toFixed(2));
    setCheckoutModalOpen(true);
  };

  // Process Checkout
  const handleProcessSale = async () => {
    if (cart.length === 0) return;
    setCheckoutError(null);

    const tenderedNum = parseFloat(amountTendered);
    if (paymentMethod === 'CASH' && (isNaN(tenderedNum) || tenderedNum < total)) {
      setCheckoutError(`Tendered amount must be at least $${total.toFixed(2)}`);
      return;
    }

    try {
      setIsProcessing(true);
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
        discount: 0,
        total,
        payment_method: paymentMethod,
        amount_paid: paymentMethod === 'CASH' ? tenderedNum : total,
        customer_name: customerName.trim() || 'Walk-in Customer',
      });

      playPaymentSuccessSound();
      setCompletedSale(saleResult);
      setCheckoutModalOpen(false);
      setCart([]);
      setMobileCartOpen(false);
      setCustomerName('');
      setReceiptOpen(true);

      // Refresh product stock and movements
      await refreshData();
    } catch (err: any) {
      setCheckoutError(err.message || 'Checkout failed. Please review stock availability.');
      playScanErrorSound();
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="w-full px-3 sm:px-6 py-4 sm:py-6 pb-32 sm:pb-36 lg:pb-8">
      <div className="flex flex-col lg:flex-row gap-6 items-start">
        {/* Main Tabular Product Register (Left / Center) */}
        <div className="flex-1 min-w-0 space-y-4">
          {/* Top Search & Filter Bar */}
          <div className="bg-white p-3.5 sm:p-4 rounded-2xl border border-zinc-200/80 shadow-xs space-y-3">
            <div className="flex gap-2 sm:gap-2.5">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search product, barcode, SKU..."
                  className="w-full pl-9 pr-3 py-2 sm:py-2.5 text-xs sm:text-sm bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:bg-white placeholder:text-zinc-400 transition-colors"
                />
              </div>

              {/* Camera Scanner Trigger */}
              <button
                type="button"
                onClick={handleOpenScanner}
                className="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 sm:py-2.5 bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-semibold rounded-xl shadow-sm transition-all flex-shrink-0"
              >
                <Camera className="w-4 h-4 text-emerald-400" />
                <span className="hidden sm:inline">Camera Scan</span>
                <span className="sm:hidden">Scan</span>
              </button>
            </div>

            {/* Department Filter Pills */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar text-xs">
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
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: dept.color || '#4f46e5' }}
                    />
                    <span>{dept.name}</span>
                    <span className="text-[10px] opacity-70">({dept.product_count || 0})</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Professional Tabular Register View */}
          <div className="bg-white rounded-2xl border border-zinc-200/80 shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-zinc-50/90 text-zinc-500 font-semibold border-b border-zinc-200 uppercase tracking-wider text-[10px]">
                  <tr>
                    <th className="py-2.5 sm:py-3 px-3 sm:px-4">Product</th>
                    <th className="hidden md:table-cell py-3 px-4">Barcode / SKU</th>
                    <th className="hidden sm:table-cell py-3 px-4">Department</th>
                    <th className="py-2.5 sm:py-3 px-2.5 sm:px-4 text-right">Price</th>
                    <th className="py-2.5 sm:py-3 px-2 sm:px-4 text-center">Stock</th>
                    <th className="py-2.5 sm:py-3 px-2.5 sm:px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {filteredProducts.map((p) => {
                    const isOutOfStock = p.stock_quantity <= 0;
                    const isLowStock = p.stock_quantity <= p.min_stock_level && !isOutOfStock;
                    const inCartCount = cart.find((i) => i.product.id === p.id)?.quantity || 0;

                    return (
                      <tr
                        key={p.id}
                        onClick={() => !isOutOfStock && addToCart(p)}
                        className={`transition-colors cursor-pointer group ${
                          isOutOfStock
                            ? 'bg-zinc-50/50 opacity-60 cursor-not-allowed'
                            : 'hover:bg-zinc-50 active:bg-zinc-100/80'
                        }`}
                      >
                        {/* Product Name (with mobile barcode & department inline) */}
                        <td className="py-2.5 sm:py-3 px-3 sm:px-4">
                          <div className="font-semibold text-zinc-950 text-xs leading-snug">
                            {p.name}
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5 md:hidden">
                            <span className="font-mono text-[10px] text-zinc-400">
                              {p.barcode}
                            </span>
                            <span
                              className="inline-block w-1.5 h-1.5 rounded-full"
                              style={{ backgroundColor: p.department_color || '#4f46e5' }}
                              title={p.department_name}
                            />
                            <span className="text-[10px] text-zinc-400 sm:hidden truncate max-w-[100px]">
                              {p.department_name}
                            </span>
                          </div>
                          <span className="text-[11px] text-zinc-400 font-normal hidden md:inline">
                            Sold per {p.unit || 'pcs'}
                          </span>
                        </td>

                        {/* Barcode & SKU (Desktop) */}
                        <td className="hidden md:table-cell py-3 px-4 whitespace-nowrap">
                          <div className="font-mono text-xs font-semibold text-zinc-800 flex items-center gap-1.5">
                            <BarcodeIcon className="w-3.5 h-3.5 text-zinc-400 group-hover:text-zinc-700" />
                            <span>{p.barcode}</span>
                          </div>
                          {p.sku && (
                            <span className="text-[10px] font-mono text-zinc-400 bg-zinc-100 px-1 py-0.2 rounded mt-0.5 inline-block">
                              {p.sku}
                            </span>
                          )}
                        </td>

                        {/* Department Badge (Tablet & Desktop) */}
                        <td className="hidden sm:table-cell py-3 px-4 whitespace-nowrap">
                          <span
                            className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-semibold"
                            style={{
                              backgroundColor: `${p.department_color || '#4f46e5'}15`,
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

                        {/* Unit Price */}
                        <td className="py-2.5 sm:py-3 px-2.5 sm:px-4 text-right whitespace-nowrap">
                          <span className="text-xs sm:text-sm font-extrabold text-zinc-950 font-mono">
                            ${Number(p.price).toFixed(2)}
                          </span>
                        </td>

                        {/* Stock on Hand */}
                        <td className="py-2.5 sm:py-3 px-2 sm:px-4 text-center whitespace-nowrap">
                          <div className="inline-flex flex-col items-center">
                            <span
                              className={`px-1.5 sm:px-2 py-0.5 rounded-md font-mono text-[10px] sm:text-xs font-bold ${
                                isOutOfStock
                                  ? 'bg-rose-100 text-rose-800'
                                  : isLowStock
                                  ? 'bg-amber-100 text-amber-800'
                                  : 'bg-emerald-50 text-emerald-800'
                              }`}
                            >
                              {p.stock_quantity} {p.unit}
                            </span>
                            {isLowStock && (
                              <span className="text-[9px] text-amber-600 font-semibold mt-0.5">
                                Low
                              </span>
                            )}
                            {isOutOfStock && (
                              <span className="text-[9px] text-rose-600 font-semibold mt-0.5">
                                Out
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Action (+ Add to Cart) */}
                        <td className="py-2.5 sm:py-3 px-2.5 sm:px-4 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              addToCart(p);
                            }}
                            disabled={isOutOfStock}
                            className={`inline-flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3 py-1.5 text-[11px] sm:text-xs font-bold rounded-xl shadow-2xs transition-all ${
                              isOutOfStock
                                ? 'bg-zinc-100 text-zinc-400 cursor-not-allowed'
                                : inCartCount > 0
                                ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                                : 'bg-zinc-900 hover:bg-zinc-800 text-white'
                            }`}
                          >
                            <Plus className="w-3 sm:w-3.5 h-3 sm:h-3.5" />
                            <span>{inCartCount > 0 ? `(${inCartCount})` : 'Add'}</span>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {filteredProducts.length === 0 && (
                <div className="p-12 text-center text-zinc-400">
                  <ShoppingBag className="w-8 h-8 mx-auto mb-2 text-zinc-300" />
                  <p className="text-sm font-semibold text-zinc-700">No items match your search</p>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    Try searching by barcode or select a different department.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right-Hand Order Cart Panel (Sticky Desktop) */}
        <div className="hidden lg:block w-96 xl:w-[420px] flex-shrink-0 sticky top-4">
          <div className="bg-white rounded-2xl border border-zinc-200/90 shadow-sm overflow-hidden flex flex-col max-h-[calc(100vh-2rem)]">
            {/* Cart Header */}
            <div className="p-4 border-b border-zinc-100 flex items-center justify-between bg-zinc-50/60">
              <div className="flex items-center gap-2">
                <ShoppingBag className="w-4 h-4 text-zinc-900" />
                <h2 className="text-sm font-bold text-zinc-900">Current Order</h2>
                <span className="text-xs font-extrabold px-2 py-0.5 bg-zinc-900 text-white rounded-full">
                  {cart.reduce((s, i) => s + i.quantity, 0)}
                </span>
              </div>
              {cart.length > 0 && (
                <button
                  onClick={clearCart}
                  className="text-xs text-rose-600 hover:text-rose-700 font-semibold hover:underline"
                >
                  Clear Order
                </button>
              )}
            </div>

            {/* Customer input */}
            <div className="px-4 py-2.5 border-b border-zinc-100 bg-zinc-50/30">
              <input
                type="text"
                placeholder="Customer Name (e.g. Walk-in Customer)"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                className="w-full px-3 py-1.5 text-xs bg-white border border-zinc-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-900 placeholder:text-zinc-400 font-medium"
              />
            </div>

            {/* Cart Line Items */}
            <div className="flex-1 overflow-y-auto p-4 divide-y divide-zinc-100 min-h-[220px]">
              {cart.length === 0 ? (
                <div className="h-56 flex flex-col items-center justify-center text-center text-zinc-400">
                  <ShoppingBag className="w-9 h-9 stroke-1 mb-2 text-zinc-300" />
                  <p className="text-xs font-semibold text-zinc-700">Cart is empty</p>
                  <p className="text-[11px] text-zinc-400 mt-0.5 max-w-[200px]">
                    Click any item in the table or scan a barcode to add to order
                  </p>
                </div>
              ) : (
                cart.map((item) => (
                  <div key={item.product.id} className="py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <h4 className="text-xs font-semibold text-zinc-900 truncate">
                        {item.product.name}
                      </h4>
                      <p className="text-[10px] text-zinc-400 font-mono">
                        ${item.unit_price.toFixed(2)} / {item.product.unit}
                      </p>
                    </div>

                    {/* Quantity Stepper */}
                    <div className="flex items-center gap-1 bg-zinc-100 p-1 rounded-lg">
                      <button
                        onClick={() => updateQuantity(item.product.id, -1)}
                        className="w-5 h-5 flex items-center justify-center rounded text-zinc-600 hover:bg-white hover:text-zinc-950 transition-colors"
                      >
                        <Minus className="w-3 h-3" />
                      </button>
                      <span className="w-6 text-center text-xs font-bold text-zinc-900 font-mono">
                        {item.quantity}
                      </span>
                      <button
                        onClick={() => updateQuantity(item.product.id, 1)}
                        className="w-5 h-5 flex items-center justify-center rounded text-zinc-600 hover:bg-white hover:text-zinc-950 transition-colors"
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                    </div>

                    {/* Total Price */}
                    <div className="text-right min-w-[55px]">
                      <span className="text-xs font-extrabold text-zinc-950 font-mono">
                        ${(item.unit_price * item.quantity).toFixed(2)}
                      </span>
                    </div>

                    <button
                      onClick={() => removeFromCart(item.product.id)}
                      className="p-1 text-zinc-300 hover:text-rose-600 rounded"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* Calculations & Checkout Button */}
            <div className="p-4 bg-zinc-50 border-t border-zinc-200/80 space-y-3">
              <div className="space-y-1.5 text-xs text-zinc-600">
                <div className="flex justify-between">
                  <span>Subtotal</span>
                  <span className="font-semibold text-zinc-900 font-mono">${subtotal.toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Tax ({taxRate}%)</span>
                  <span className="font-mono">${taxAmount.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-base font-black text-zinc-950 pt-2 border-t border-zinc-200">
                  <span>Total</span>
                  <span className="font-mono">${total.toFixed(2)}</span>
                </div>
              </div>

              <button
                onClick={openCheckout}
                disabled={cart.length === 0}
                className="w-full flex items-center justify-center gap-2 py-3 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold rounded-xl shadow-md transition-all active:scale-[0.99]"
              >
                <span>Charge ${total.toFixed(2)}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile Sticky Bottom Bar */}
      <div className="lg:hidden fixed bottom-14 md:bottom-0 inset-x-0 z-20 p-3 bg-white/95 backdrop-blur-md border-t border-zinc-200">
        <div className="flex items-center justify-between gap-3 max-w-md mx-auto">
          <button
            onClick={() => setMobileCartOpen(true)}
            className="flex items-center gap-2 text-left"
          >
            <div className="relative">
              <ShoppingBag className="w-5 h-5 text-zinc-900" />
              <span className="absolute -top-1.5 -right-2 w-4 h-4 bg-zinc-900 text-white rounded-full text-[10px] font-bold flex items-center justify-center">
                {cart.reduce((s, i) => s + i.quantity, 0)}
              </span>
            </div>
            <div>
              <p className="text-xs font-bold text-zinc-950 font-mono">${total.toFixed(2)}</p>
              <p className="text-[10px] text-zinc-400">View items</p>
            </div>
          </button>

          <button
            onClick={openCheckout}
            disabled={cart.length === 0}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-white text-xs font-bold rounded-xl shadow-sm"
          >
            <span>Charge ${total.toFixed(2)}</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Mobile Cart Drawer */}
      {mobileCartOpen && (
        <div className="lg:hidden fixed inset-0 z-50 bg-zinc-950/60 backdrop-blur-sm flex flex-col justify-end">
          <div className="bg-white rounded-t-3xl border-t border-zinc-200 p-5 max-h-[80vh] flex flex-col pb-safe">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-100">
              <h3 className="text-sm font-bold text-zinc-900">Current Order ({cart.length} items)</h3>
              <button
                onClick={() => setMobileCartOpen(false)}
                className="text-xs font-semibold text-zinc-500 hover:text-zinc-900"
              >
                Close
              </button>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-zinc-100 py-3">
              {cart.map((item) => (
                <div key={item.product.id} className="py-2.5 flex items-center justify-between">
                  <div>
                    <h4 className="text-xs font-semibold text-zinc-900">{item.product.name}</h4>
                    <span className="text-[11px] text-zinc-400">
                      ${item.unit_price.toFixed(2)} each
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1 bg-zinc-100 p-1 rounded-lg">
                      <button
                        onClick={() => updateQuantity(item.product.id, -1)}
                        className="w-5 h-5 flex items-center justify-center text-zinc-600"
                      >
                        <Minus className="w-3 h-3" />
                      </button>
                      <span className="w-6 text-center text-xs font-bold">{item.quantity}</span>
                      <button
                        onClick={() => updateQuantity(item.product.id, 1)}
                        className="w-5 h-5 flex items-center justify-center text-zinc-600"
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                    </div>
                    <span className="text-xs font-bold w-12 text-right">
                      ${(item.unit_price * item.quantity).toFixed(2)}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <div className="pt-3 border-t border-zinc-100 space-y-2">
              <div className="flex justify-between text-sm font-bold">
                <span>Total</span>
                <span>${total.toFixed(2)}</span>
              </div>
              <button
                onClick={() => {
                  setMobileCartOpen(false);
                  openCheckout();
                }}
                disabled={cart.length === 0}
                className="w-full py-3 bg-zinc-900 text-white text-xs font-bold rounded-xl"
              >
                Proceed to Payment (${total.toFixed(2)})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Payment Modal */}
      {checkoutModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-zinc-950/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl border border-zinc-200 overflow-hidden flex flex-col max-h-[92vh]">
            <div className="p-4 sm:p-5 border-b border-zinc-100 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-zinc-900">Complete Payment</h3>
                <p className="text-xs text-zinc-500">
                  Select payment method & settle order
                </p>
              </div>
              <button
                onClick={() => setCheckoutModalOpen(false)}
                className="text-zinc-400 hover:text-zinc-700"
              >
                ✕
              </button>
            </div>

            <div className="p-4 sm:p-6 space-y-4 sm:space-y-5 overflow-y-auto">
              {checkoutError && (
                <div className="p-3 text-xs bg-rose-50 border border-rose-200 text-rose-700 rounded-xl flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                  <span>{checkoutError}</span>
                </div>
              )}

              {/* Total Due Banner */}
              <div className="p-4 bg-zinc-50 rounded-xl border border-zinc-200/80 text-center">
                <span className="text-xs uppercase tracking-wider font-semibold text-zinc-500">
                  Total Amount Due
                </span>
                <div className="text-3xl font-black text-zinc-950 font-mono mt-0.5">
                  ${total.toFixed(2)}
                </div>
                <span className="text-[11px] text-zinc-400">
                  Tax included (${taxAmount.toFixed(2)})
                </span>
              </div>

              {/* Payment Methods */}
              <div>
                <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-2">
                  Payment Method
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setPaymentMethod('CASH')}
                    className={`p-3 rounded-xl border flex flex-col items-center gap-1.5 transition-all ${
                      paymentMethod === 'CASH'
                        ? 'border-zinc-900 bg-zinc-900 text-white shadow-sm'
                        : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50'
                    }`}
                  >
                    <Banknote className="w-5 h-5" />
                    <span className="text-xs font-bold">Cash</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaymentMethod('CARD')}
                    className={`p-3 rounded-xl border flex flex-col items-center gap-1.5 transition-all ${
                      paymentMethod === 'CARD'
                        ? 'border-zinc-900 bg-zinc-900 text-white shadow-sm'
                        : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50'
                    }`}
                  >
                    <CreditCard className="w-5 h-5" />
                    <span className="text-xs font-bold">Card</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaymentMethod('UPI_QR')}
                    className={`p-3 rounded-xl border flex flex-col items-center gap-1.5 transition-all ${
                      paymentMethod === 'UPI_QR'
                        ? 'border-zinc-900 bg-zinc-900 text-white shadow-sm'
                        : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50'
                    }`}
                  >
                    <QrCode className="w-5 h-5" />
                    <span className="text-xs font-bold">UPI / QR</span>
                  </button>
                </div>
              </div>

              {/* Cash Tendered & Quick Bills */}
              {paymentMethod === 'CASH' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-zinc-700 uppercase tracking-wider">
                      Cash Received ($)
                    </label>
                    <span className="text-xs font-bold text-emerald-600 font-mono">
                      Change Due: ${changeDue.toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="number"
                    step="0.01"
                    min={total}
                    value={amountTendered}
                    onChange={(e) => setAmountTendered(e.target.value)}
                    className="w-full px-3 py-2 text-lg font-bold font-mono bg-white border border-zinc-300 rounded-xl focus:ring-2 focus:ring-zinc-900"
                  />

                  <div className="flex gap-1.5 pt-1">
                    {[
                      { label: 'Exact', val: total },
                      { label: '$10', val: 10 },
                      { label: '$20', val: 20 },
                      { label: '$50', val: 50 },
                      { label: '$100', val: 100 },
                    ]
                      .filter((b) => b.val >= total || b.label === 'Exact')
                      .map((b, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setAmountTendered(b.val.toFixed(2))}
                          className="flex-1 py-1.5 text-xs font-semibold bg-zinc-100 hover:bg-zinc-200 text-zinc-800 rounded-lg transition-colors"
                        >
                          {b.label}
                        </button>
                      ))}
                  </div>
                </div>
              )}

              {/* Customer Name */}
              <div>
                <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-1">
                  Customer / Purchaser Name
                </label>
                <input
                  type="text"
                  placeholder="e.g. John Doe"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-white border border-zinc-300 rounded-xl focus:ring-2 focus:ring-zinc-900"
                />
              </div>

              {/* Action Buttons */}
              <div className="pt-2 flex gap-3">
                <button
                  type="button"
                  onClick={() => setCheckoutModalOpen(false)}
                  className="flex-1 py-2.5 text-xs font-semibold text-zinc-700 bg-zinc-100 hover:bg-zinc-200 rounded-xl"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleProcessSale}
                  disabled={isProcessing}
                  className="flex-2 flex items-center justify-center gap-2 py-2.5 px-6 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-sm"
                >
                  {isProcessing ? 'Processing...' : 'Confirm & Deduct Stock'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Barcode Camera Scanner Modal */}
      <BarcodeScannerModal
        isOpen={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScan={handleBarcodeScanned}
        title="Scan Item to Add to Order"
        subtitle="Point camera at product barcode"
        continuous={true}
      />

      {/* Printable Receipt Modal */}
      <ReceiptModal
        isOpen={receiptOpen}
        onClose={() => setReceiptOpen(false)}
        sale={completedSale}
      />
    </div>
  );
};
