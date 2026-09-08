import React, { useState, useEffect, useCallback } from 'react';
import { Department, Product, CartItem } from './types';
import { api } from './utils/api';
import { Sidebar, ActiveTab } from './components/Sidebar';
import { InstallAppModal } from './components/InstallAppModal';
import { POSPage } from './pages/POSPage';
import { InventoryPage } from './pages/InventoryPage';
import { QuickScannerPage } from './pages/QuickScannerPage';
import { MovementHistoryPage } from './pages/MovementHistoryPage';
import { AnalyticsPage } from './pages/AnalyticsPage';

export function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('pos');
  const [departments, setDepartments] = useState<Department[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // PWA Installation & Standalone detection
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [isStandalone, setIsStandalone] = useState<boolean>(false);
  const [installModalOpen, setInstallModalOpen] = useState<boolean>(false);

  useEffect(() => {
    // Detect if running as standalone installed app on iOS or Android
    const checkStandalone = () => {
      const isStandaloneMode =
        window.matchMedia('(display-mode: standalone)').matches ||
        (window.navigator as any).standalone === true;
      setIsStandalone(isStandaloneMode);
    };

    checkStandalone();

    // Listen to Android Chrome PWA install prompt
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    };
  }, []);

  const loadInitialData = useCallback(async () => {
    try {
      setError(null);
      const [deptData, prodData] = await Promise.all([
        api.getDepartments(),
        api.getProducts(),
      ]);
      setDepartments(deptData);
      setProducts(prodData);
    } catch (err: any) {
      console.error('Data initialization error:', err);
      setError(err.message || 'Could not connect to retail server. Is it running on port 5000?');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInitialData();
  }, [loadInitialData]);

  const totalCartItemCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-50 flex flex-col items-center justify-center p-4">
        <div className="w-10 h-10 border-2 border-zinc-900 border-t-transparent rounded-full animate-spin mb-3" />
        <h2 className="text-sm font-bold text-zinc-900">Nexus POS & Inventory</h2>
        <p className="text-xs text-zinc-400 mt-1">Connecting to database ledger...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-zinc-50 flex flex-col items-center justify-center p-4">
        <div className="max-w-md w-full bg-white p-6 rounded-2xl border border-rose-200 shadow-sm text-center">
          <div className="w-10 h-10 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center mx-auto mb-3">
            ✕
          </div>
          <h2 className="text-base font-bold text-zinc-900 mb-1">Server Connection Error</h2>
          <p className="text-xs text-zinc-600 mb-4">{error}</p>
          <button
            onClick={() => {
              setLoading(true);
              loadInitialData();
            }}
            className="px-4 py-2 bg-zinc-900 text-white text-xs font-semibold rounded-xl"
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 flex flex-col md:flex-row w-full max-w-full overflow-x-hidden">
      {/* Left Sidebar Navigation */}
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        cartCount={totalCartItemCount}
        onOpenInstallModal={() => setInstallModalOpen(true)}
        isStandalone={isStandalone}
      />

      {/* Main Full-Width Content Workspace */}
      <div className="flex-1 md:pl-64 flex flex-col min-w-0 w-full max-w-full overflow-x-hidden pb-16 md:pb-6">
        <main className="flex-1 w-full max-w-full min-w-0">
          {activeTab === 'pos' && (
            <POSPage
              products={products}
              departments={departments}
              refreshData={loadInitialData}
              cart={cart}
              setCart={setCart}
            />
          )}

          {activeTab === 'inventory' && (
            <InventoryPage
              products={products}
              departments={departments}
              refreshData={loadInitialData}
            />
          )}

          {activeTab === 'scanner' && (
            <QuickScannerPage
              products={products}
              refreshData={loadInitialData}
            />
          )}

          {activeTab === 'history' && (
            <MovementHistoryPage
              departments={departments}
            />
          )}

          {activeTab === 'analytics' && (
            <AnalyticsPage
              departments={departments}
            />
          )}
        </main>
      </div>

      {/* PWA Mobile Installation Modal */}
      <InstallAppModal
        isOpen={installModalOpen}
        onClose={() => setInstallModalOpen(false)}
        deferredPrompt={deferredPrompt}
        isStandalone={isStandalone}
      />
    </div>
  );
}

export default App;
