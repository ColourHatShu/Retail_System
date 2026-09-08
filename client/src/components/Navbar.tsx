import React from 'react';
import { ShoppingCart, Package, ScanLine, History, BarChart3, Store } from 'lucide-react';

export type ActiveTab = 'pos' | 'inventory' | 'scanner' | 'history' | 'analytics';

interface NavbarProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  cartCount?: number;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  setActiveTab,
  cartCount = 0,
}) => {
  const navItems: Array<{ id: ActiveTab; label: string; icon: React.FC<{ className?: string }>; badge?: number }> = [
    { id: 'pos', label: 'POS Register', icon: ShoppingCart, badge: cartCount },
    { id: 'inventory', label: 'Inventory', icon: Package },
    { id: 'scanner', label: 'Stock Scan (+/-)', icon: ScanLine },
    { id: 'history', label: 'Movement History', icon: History },
    { id: 'analytics', label: 'Sales & Audit', icon: BarChart3 },
  ];

  return (
    <>
      {/* Top Desktop & Tablet Header */}
      <header className="sticky top-0 z-30 bg-white border-b border-zinc-200/80 shadow-[0_1px_3px_rgba(0,0,0,0.02)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Logo / Brand */}
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-zinc-900 text-white flex items-center justify-center shadow-sm">
                <Store className="w-5 h-5 text-zinc-100" />
              </div>
              <div>
                <h1 className="text-sm font-bold tracking-tight text-zinc-950 flex items-center gap-2">
                  NEXUS POS
                  <span className="text-[10px] uppercase font-semibold tracking-wider bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded border border-emerald-200/60">
                    Live
                  </span>
                </h1>
                <p className="text-[11px] text-zinc-500 font-medium">
                  Inventory & Movement Ledger
                </p>
              </div>
            </div>

            {/* Desktop Navigation Links */}
            <nav className="hidden md:flex items-center gap-1 bg-zinc-100/80 p-1 rounded-xl border border-zinc-200/60">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => setActiveTab(item.id)}
                    className={`relative flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                      isActive
                        ? 'bg-white text-zinc-950 shadow-sm'
                        : 'text-zinc-600 hover:text-zinc-950 hover:bg-zinc-200/50'
                    }`}
                  >
                    <Icon className={`w-4 h-4 ${isActive ? 'text-zinc-950' : 'text-zinc-500'}`} />
                    <span>{item.label}</span>
                    {item.badge !== undefined && item.badge > 0 && (
                      <span className="w-4 h-4 rounded-full bg-zinc-900 text-white text-[10px] flex items-center justify-center font-bold">
                        {item.badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>

            {/* Barcode scanner live status indicator */}
            <div className="hidden sm:flex items-center gap-2 text-[11px] text-zinc-500 bg-zinc-50 px-3 py-1.5 rounded-lg border border-zinc-200">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span>Hardware Scanner Ready</span>
            </div>
          </div>
        </div>
      </header>

      {/* Mobile Bottom Navigation Bar */}
      <div className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white/95 backdrop-blur-md border-t border-zinc-200/80 pb-safe">
        <nav className="flex items-center justify-around px-2 py-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`flex flex-col items-center justify-center py-1 px-2.5 rounded-xl transition-all relative ${
                  isActive ? 'text-zinc-950 font-bold' : 'text-zinc-500 font-medium'
                }`}
              >
                <div className="relative">
                  <Icon className={`w-5 h-5 ${isActive ? 'stroke-[2.5]' : 'stroke-2'}`} />
                  {item.badge !== undefined && item.badge > 0 && (
                    <span className="absolute -top-1.5 -right-2 w-4 h-4 rounded-full bg-zinc-900 text-white text-[10px] flex items-center justify-center font-bold">
                      {item.badge}
                    </span>
                  )}
                </div>
                <span className="text-[10px] mt-1 tracking-tight">{item.label.split(' ')[0]}</span>
                {isActive && (
                  <span className="w-1 h-1 rounded-full bg-zinc-900 mt-0.5" />
                )}
              </button>
            );
          })}
        </nav>
      </div>
    </>
  );
};
