import React, { useState, useEffect, useCallback } from 'react';
import { Department, Product, CartItem, User } from './types';
import { api } from './utils/api';
import { getToken, onUnauthorized, setToken } from './utils/auth';
import { Sidebar, ActiveTab, TABS_FOR_ROLE } from './components/Sidebar';
import { InstallAppModal } from './components/InstallAppModal';
import { LoginPage } from './pages/LoginPage';
import { POSPage } from './pages/POSPage';
import { InventoryPage } from './pages/InventoryPage';
import { QuickScannerPage } from './pages/QuickScannerPage';
import { MovementHistoryPage } from './pages/MovementHistoryPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { UsersPage } from './pages/UsersPage';
import { ReturnsPage } from './pages/ReturnsPage';

type AuthState = 'checking' | 'setup' | 'login' | 'ready';

export function App() {
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [user, setUser] = useState<User | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

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
    const checkStandalone = () => {
      const isStandaloneMode =
        window.matchMedia('(display-mode: standalone)').matches ||
        (window.navigator as any).standalone === true;
      setIsStandalone(isStandaloneMode);
    };
    checkStandalone();

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
  }, []);

  // ---- Session -----------------------------------------------------------

  const signOutLocally = useCallback(() => {
    setToken(null);
    setUser(null);
    setCart([]);
    setActiveTab('pos');
    setAuthState('login');
  }, []);

  // Any 401 from the API (expired, revoked, deactivated) drops us to sign-in.
  useEffect(() => onUnauthorized(signOutLocally), [signOutLocally]);

  const checkSession = useCallback(async () => {
    setAuthError(null);
    try {
      const status = await api.getAuthStatus();
      if (status.needs_setup) {
        setAuthState('setup');
        return;
      }
      if (!getToken()) {
        setAuthState('login');
        return;
      }
      const me = await api.me();
      setUser(me);
      setAuthState('ready');
    } catch (err: any) {
      if (err?.code === 'NETWORK_ERROR' || err?.code === 'DATABASE_UNAVAILABLE') {
        setAuthError(err.message);
        setAuthState('checking');
      } else {
        setToken(null);
        setAuthState('login');
      }
    }
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  const handleSignedIn = (session: { user: User; token: string }) => {
    setToken(session.token);
    setUser(session.user);
    setActiveTab('pos');
    setLoading(true);
    setAuthState('ready');
  };

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {
      // The token may already be dead; signing out locally is what matters.
    }
    signOutLocally();
  };

  // ---- Data --------------------------------------------------------------

  const loadInitialData = useCallback(async () => {
    try {
      setError(null);
      const [deptData, prodData] = await Promise.all([api.getDepartments(), api.getProducts()]);
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
    if (authState === 'ready') loadInitialData();
  }, [authState, loadInitialData]);

  // Never leave a user on a tab their role cannot use.
  useEffect(() => {
    if (user && !TABS_FOR_ROLE[user.role].includes(activeTab)) setActiveTab('pos');
  }, [user, activeTab]);

  const totalCartItemCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  // ---- Screens -----------------------------------------------------------

  if (authState === 'checking') {
    return (
      <div className="min-h-screen bg-zinc-50 flex flex-col items-center justify-center p-4">
        {authError ? (
          <div className="max-w-md w-full bg-white p-6 rounded-2xl border border-rose-200 shadow-sm text-center">
            <h2 className="text-base font-bold text-zinc-900 mb-1">Server Connection Error</h2>
            <p className="text-xs text-zinc-600 mb-4">{authError}</p>
            <button onClick={checkSession} className="px-4 py-2 bg-zinc-900 text-white text-xs font-semibold rounded-xl">
              Retry Connection
            </button>
          </div>
        ) : (
          <>
            <div className="w-10 h-10 border-2 border-zinc-900 border-t-transparent rounded-full animate-spin mb-3" />
            <h2 className="text-sm font-bold text-zinc-900">Nexus POS & Inventory</h2>
            <p className="text-xs text-zinc-400 mt-1">Checking session...</p>
          </>
        )}
      </div>
    );
  }

  if (authState === 'setup' || authState === 'login' || !user) {
    return <LoginPage mode={authState === 'setup' ? 'setup' : 'login'} onSuccess={handleSignedIn} />;
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-50 flex flex-col items-center justify-center p-4">
        <div className="w-10 h-10 border-2 border-zinc-900 border-t-transparent rounded-full animate-spin mb-3" />
        <h2 className="text-sm font-bold text-zinc-900">Nexus POS & Inventory</h2>
        <p className="text-xs text-zinc-400 mt-1">Loading catalogue...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-zinc-50 flex flex-col items-center justify-center p-4">
        <div className="max-w-md w-full bg-white p-6 rounded-2xl border border-rose-200 shadow-sm text-center">
          <div className="w-10 h-10 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center mx-auto mb-3">✕</div>
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
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        user={user}
        onLogout={handleLogout}
        cartCount={totalCartItemCount}
        onOpenInstallModal={() => setInstallModalOpen(true)}
        isStandalone={isStandalone}
      />

      <div className="flex-1 md:pl-64 flex flex-col min-w-0 w-full max-w-full overflow-x-hidden pb-16 md:pb-6">
        <main className="flex-1 w-full max-w-full min-w-0">
          {activeTab === 'pos' && (
            <POSPage products={products} departments={departments} refreshData={loadInitialData} cart={cart} setCart={setCart} />
          )}
          {activeTab === 'returns' && <ReturnsPage currentUser={user} refreshData={loadInitialData} />}
          {activeTab === 'inventory' && (
            <InventoryPage products={products} departments={departments} refreshData={loadInitialData} />
          )}
          {activeTab === 'scanner' && <QuickScannerPage products={products} refreshData={loadInitialData} />}
          {activeTab === 'history' && <MovementHistoryPage departments={departments} />}
          {activeTab === 'analytics' && <AnalyticsPage departments={departments} />}
          {activeTab === 'users' && <UsersPage currentUser={user} />}
        </main>
      </div>

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
