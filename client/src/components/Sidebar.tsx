import React, { useState } from 'react';
import {
  ShoppingCart,
  Package,
  ScanLine,
  History,
  BarChart3,
  Store,
  Menu,
  X,
  Zap,
  Radio,
  Clock,
} from 'lucide-react';

export type ActiveTab = 'pos' | 'inventory' | 'scanner' | 'history' | 'analytics';

interface SidebarProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  cartCount?: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  setActiveTab,
  cartCount = 0,
}) => {
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

  const navItems: Array<{
    id: ActiveTab;
    label: string;
    description: string;
    icon: React.FC<{ className?: string }>;
    badge?: number;
  }> = [
    {
      id: 'pos',
      label: 'POS Register',
      description: 'Checkout & cash register',
      icon: ShoppingCart,
      badge: cartCount,
    },
    {
      id: 'inventory',
      label: 'Inventory',
      description: 'Department products & stock',
      icon: Package,
    },
    {
      id: 'scanner',
      label: 'Stock Scan (+/-)',
      description: 'Rapid barcode stock in/out',
      icon: ScanLine,
    },
    {
      id: 'history',
      label: 'Movement History',
      description: 'Customer & receipt audit ledger',
      icon: History,
    },
    {
      id: 'analytics',
      label: 'Sales & Audit',
      description: 'Revenue & tender reports',
      icon: BarChart3,
    },
  ];

  const handleSelectTab = (id: ActiveTab) => {
    setActiveTab(id);
    setMobileDrawerOpen(false);
  };

  const SidebarContent = () => (
    <div className="flex flex-col h-full justify-between bg-zinc-950 text-zinc-200 select-none">
      {/* Top Header & Brand */}
      <div className="p-5 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-zinc-800 border border-zinc-700/60 text-white flex items-center justify-center shadow-sm">
              <Store className="w-5 h-5 text-emerald-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-extrabold tracking-tight text-white uppercase">
                  NEXUS POS
                </span>
                <span className="text-[9px] font-bold uppercase tracking-wider bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-500/30">
                  LIVE
                </span>
              </div>
              <p className="text-[11px] text-zinc-400 font-medium">Terminal #01 • Retail</p>
            </div>
          </div>

          <button
            onClick={() => setMobileDrawerOpen(false)}
            className="md:hidden p-1.5 text-zinc-400 hover:text-white rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation Items */}
        <nav className="space-y-1.5 pt-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => handleSelectTab(item.id)}
                className={`w-full flex items-center justify-between px-3.5 py-3 rounded-xl text-left transition-all ${
                  isActive
                    ? 'bg-zinc-800 text-white shadow-sm ring-1 ring-zinc-700/60 font-bold'
                    : 'text-zinc-400 hover:text-white hover:bg-zinc-900/80 font-medium'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Icon
                    className={`w-4 h-4 flex-shrink-0 ${
                      isActive ? 'text-emerald-400 stroke-[2.5]' : 'text-zinc-400 stroke-2'
                    }`}
                  />
                  <div className="truncate">
                    <div className="text-xs leading-tight">{item.label}</div>
                    <div className="text-[10px] text-zinc-400 font-normal leading-tight mt-0.5 truncate">
                      {item.description}
                    </div>
                  </div>
                </div>

                {item.badge !== undefined && item.badge > 0 && (
                  <span className="w-5 h-5 rounded-full bg-emerald-500 text-zinc-950 text-[10px] flex items-center justify-center font-extrabold shadow-sm">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Bottom Footer Info (Hardware scanner status & Store terminal stats) */}
      <div className="p-4 border-t border-zinc-800/80 bg-zinc-900/40 space-y-3">
        {/* Hardware scanner wedge status */}
        <div className="flex items-center justify-between p-2.5 rounded-xl bg-zinc-900/90 border border-zinc-800 text-[11px]">
          <div className="flex items-center gap-2 text-zinc-300 font-medium">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span>USB/BT Scanner</span>
          </div>
          <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/60 px-1.5 py-0.5 rounded border border-emerald-800/40">
            READY
          </span>
        </div>

        {/* Terminal Info */}
        <div className="flex items-center justify-between text-[10px] text-zinc-400 font-mono px-1">
          <span>v2.1.0 • Standalone</span>
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3 text-zinc-400" />
            Active
          </span>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Fixed Left Sidebar */}
      <aside className="hidden md:flex flex-col w-64 fixed inset-y-0 left-0 z-30 shadow-xl">
        <SidebarContent />
      </aside>

      {/* Mobile Top Header with Hamburger Toggle */}
      <div className="md:hidden sticky top-0 z-30 bg-zinc-950 text-white border-b border-zinc-800 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => setMobileDrawerOpen(true)}
            className="p-1.5 text-zinc-400 hover:text-white rounded-lg hover:bg-zinc-800"
          >
            <Menu className="w-5 h-5" />
          </button>
          <span className="text-xs font-bold uppercase tracking-wider text-white">
            NEXUS POS
          </span>
        </div>

        <div className="flex items-center gap-2">
          {cartCount > 0 && (
            <span className="px-2 py-0.5 bg-emerald-500 text-zinc-950 text-[10px] font-bold rounded-full">
              {cartCount} in Cart
            </span>
          )}
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
        </div>
      </div>

      {/* Mobile Slide-Out Drawer */}
      {mobileDrawerOpen && (
        <div className="md:hidden fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex">
          <div className="w-72 max-w-[85vw] h-full shadow-2xl">
            <SidebarContent />
          </div>
          <div className="flex-1" onClick={() => setMobileDrawerOpen(false)} />
        </div>
      )}

      {/* Mobile Bottom Navigation Strip */}
      <div className="md:hidden fixed bottom-0 inset-x-0 z-20 bg-zinc-950/95 backdrop-blur-md border-t border-zinc-800 pb-safe">
        <nav className="flex items-center justify-around px-1 py-1.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => handleSelectTab(item.id)}
                className={`flex flex-col items-center justify-center py-1 px-2 rounded-xl transition-all relative ${
                  isActive ? 'text-emerald-400 font-bold' : 'text-zinc-400 font-medium'
                }`}
              >
                <div className="relative">
                  <Icon className={`w-5 h-5 ${isActive ? 'stroke-[2.5]' : 'stroke-2'}`} />
                  {item.badge !== undefined && item.badge > 0 && (
                    <span className="absolute -top-1.5 -right-2 w-4 h-4 rounded-full bg-emerald-500 text-zinc-950 text-[10px] flex items-center justify-center font-bold">
                      {item.badge}
                    </span>
                  )}
                </div>
                <span className="text-[10px] mt-0.5 tracking-tight">{item.label.split(' ')[0]}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </>
  );
};
