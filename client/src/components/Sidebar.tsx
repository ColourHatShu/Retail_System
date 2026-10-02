import React, { useEffect, useState } from 'react';
import {
  ShoppingCart,
  Package,
  ScanLine,
  History,
  BarChart3,
  Store,
  Menu,
  X,
  Smartphone,
  Users,
  LogOut,
  Undo2,
  Ellipsis,
} from 'lucide-react';
import { Role, User } from '../types';

export type ActiveTab = 'pos' | 'returns' | 'inventory' | 'scanner' | 'history' | 'analytics' | 'users' | 'profile';

/** Which tabs each role may open. Enforced again by the server on every request. */
export const TABS_FOR_ROLE: Record<Role, ActiveTab[]> = {
  CASHIER: ['pos', 'returns'],
  MANAGER: ['pos', 'returns', 'inventory', 'scanner', 'history', 'analytics'],
  OWNER: ['pos', 'returns', 'inventory', 'scanner', 'history', 'analytics', 'users', 'profile'],
};

const ROLE_LABELS: Record<Role, string> = { OWNER: 'Owner', MANAGER: 'Manager', CASHIER: 'Cashier' };

/**
 * A phone bottom bar can carry five targets before the labels stop being
 * readable. It used to render all seven and cut each label to its first word,
 * so "Stock Scan (+/-)" read "Stock" and "Movement History" read "Movement".
 * Four destinations now sit in the bar and the rest live behind More, with
 * their full names. Both lists are intersected with TABS_FOR_ROLE, so a role
 * can never reach a screen through More that the bar would have denied it —
 * a cashier gets two tabs and no More button at all.
 */
const PHONE_PRIMARY_TABS: ActiveTab[] = ['pos', 'returns', 'inventory', 'analytics'];
const PHONE_MORE_TABS: ActiveTab[] = ['scanner', 'history', 'users', 'profile'];

/** Height of the phone bottom bar without its safe-area inset: 1px border + 64px row + 16px. */
const PHONE_NAV_HEIGHT = 81;

interface NavItem {
  id: ActiveTab;
  /** Full name — sidebar, More sheet and every accessible name. */
  label: string;
  /** Fits the 72px rail and the 5-up bottom bar. */
  shortLabel: string;
  icon: React.FC<{ className?: string }>;
  badge?: number;
}

interface SidebarProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  user: User;
  onLogout: () => void;
  cartCount?: number;
  onOpenInstallModal?: () => void;
  isStandalone?: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  setActiveTab,
  user,
  onLogout,
  cartCount = 0,
  onOpenInstallModal,
  isStandalone = false,
}) => {
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);

  const allowed = TABS_FOR_ROLE[user.role];

  const allNavItems: NavItem[] = [
    { id: 'pos', label: 'POS Register', shortLabel: 'Register', icon: ShoppingCart, badge: cartCount },
    { id: 'returns', label: 'Returns & Refunds', shortLabel: 'Returns', icon: Undo2 },
    { id: 'inventory', label: 'Inventory', shortLabel: 'Inventory', icon: Package },
    { id: 'scanner', label: 'Stock Scan (+/-)', shortLabel: 'Stock', icon: ScanLine },
    { id: 'history', label: 'Movement History', shortLabel: 'History', icon: History },
    { id: 'analytics', label: 'Sales & Audit', shortLabel: 'Sales', icon: BarChart3 },
    { id: 'users', label: 'Staff & Access', shortLabel: 'Staff', icon: Users },
    { id: 'profile', label: 'Store Profile', shortLabel: 'Profile', icon: Store },
  ];
  const navItems = allNavItems.filter((item) => allowed.includes(item.id));

  const byId = (ids: ActiveTab[]) => ids.map((id) => navItems.find((item) => item.id === id)).filter((i): i is NavItem => !!i);
  const phoneTabs = byId(PHONE_PRIMARY_TABS);
  const moreTabs = byId(PHONE_MORE_TABS);
  const moreIsActive = moreTabs.some((item) => item.id === activeTab);
  const phoneColumns = phoneTabs.length + (moreTabs.length > 0 ? 1 : 0);

  const initial = (user.display_name || user.username || '?').trim().charAt(0).toUpperCase();

  const closeOverlays = () => {
    setMobileDrawerOpen(false);
    setMoreOpen(false);
    setAccountMenuOpen(false);
  };

  const handleSelectTab = (id: ActiveTab) => {
    setActiveTab(id);
    closeOverlays();
  };

  // Every overlay here is a menu, so Escape has to dismiss it.
  useEffect(() => {
    if (!mobileDrawerOpen && !moreOpen && !accountMenuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeOverlays();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileDrawerOpen, moreOpen, accountMenuOpen]);

  /** 256px panel — the desktop sidebar, and the whole phone drawer. */
  const renderPanel = (showClose: boolean) => (
    <div className="flex h-full flex-col justify-between bg-zinc-950 select-none">
      <div className="no-scrollbar flex min-h-0 flex-col gap-6 overflow-y-auto p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-zinc-700/60 bg-zinc-800 text-emerald-400">
            <Store className="h-5 w-5" />
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-extrabold leading-5 tracking-tight text-white">NEXUS POS</span>
              <span className="rounded border border-emerald-500/30 bg-emerald-500/20 px-1.5 py-0.5 text-[11px] font-bold uppercase leading-none tracking-wider text-emerald-400">
                LIVE
              </span>
            </div>
            <span className="truncate text-[11px] font-medium leading-4 text-zinc-400">Terminal #01 • Retail</span>
          </div>

          {showClose && (
            <button
              type="button"
              onClick={() => setMobileDrawerOpen(false)}
              className="ml-auto flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
              aria-label="Close menu"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        <nav className="flex flex-col gap-1 pt-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleSelectTab(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`flex h-11 items-center justify-between gap-3 rounded-xl pl-3.5 pr-3 text-left transition-colors ${
                  isActive ? 'bg-zinc-800 ring-1 ring-zinc-700/60' : 'text-zinc-400 hover:bg-zinc-900/80 hover:text-white'
                }`}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <Icon
                    className={`h-[18px] w-[18px] flex-shrink-0 ${
                      isActive ? 'stroke-[2.5] text-emerald-400' : 'stroke-2'
                    }`}
                  />
                  <span className={`truncate text-[13px] ${isActive ? 'font-bold text-white' : 'font-medium'}`}>
                    {item.label}
                  </span>
                </span>

                {!!item.badge && (
                  <span className="flex h-5 min-w-[20px] flex-shrink-0 items-center justify-center rounded-full bg-emerald-500 px-1.5 text-[11px] font-extrabold tabular-nums text-zinc-950">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="flex flex-shrink-0 flex-col gap-2 border-t border-zinc-800/80 bg-zinc-900/40 p-4">
        <div className="flex items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-zinc-900/90 p-2 pl-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[13px] font-bold text-emerald-400">
              {initial}
            </div>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] font-bold leading-[18px] text-white">{user.display_name}</span>
              <span className="truncate text-[11px] leading-4 text-zinc-400">
                {ROLE_LABELS[user.role]} · {user.username}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[10px] border border-zinc-700/60 text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>

        <div className="flex h-9 items-center justify-between gap-2 px-2 text-xs font-medium text-zinc-400">
          {onOpenInstallModal ? (
            <button
              type="button"
              onClick={onOpenInstallModal}
              className="-mx-2 flex h-9 min-w-0 items-center gap-2 rounded-lg px-2 transition-colors hover:bg-zinc-800/60 hover:text-white"
            >
              <Smartphone className="h-3.5 w-3.5 flex-shrink-0 text-emerald-400" />
              <span className="truncate">{isStandalone ? 'Installed (App Mode)' : 'Install on phone'}</span>
            </button>
          ) : (
            <span />
          )}
          <span className="flex-shrink-0 text-[11px] tabular-nums text-zinc-400">v3.0.0</span>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar — 256px, xl and up. */}
      <aside
        className="fixed bottom-0 left-0 z-30 hidden w-64 flex-col shadow-xl xl:flex"
        style={{ top: 'var(--admin-banner, 0px)' }}
      >
        {renderPanel(false)}
      </aside>

      {/* Tablet icon rail — 72px, md up to xl. */}
      <aside
        className="fixed bottom-0 left-0 z-30 hidden w-[72px] flex-col items-center justify-between bg-zinc-950 py-4 shadow-xl md:flex xl:hidden"
        style={{ top: 'var(--admin-banner, 0px)' }}
      >
        <div className="flex min-h-0 flex-col items-center gap-5">
          <div
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-zinc-700/60 bg-zinc-800 text-emerald-400"
            title="Nexus POS · Terminal #01"
          >
            <Store className="h-5 w-5" />
          </div>

          <nav className="no-scrollbar flex min-h-0 flex-col items-center gap-1 overflow-y-auto">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleSelectTab(item.id)}
                  aria-current={isActive ? 'page' : undefined}
                  title={item.label}
                  className={`flex h-14 w-16 flex-shrink-0 flex-col items-center justify-center gap-1 rounded-xl transition-colors ${
                    isActive ? 'text-white' : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  <span
                    className={`relative flex h-8 w-12 items-center justify-center rounded-full ${
                      isActive ? 'bg-zinc-800 text-emerald-400' : ''
                    }`}
                  >
                    <Icon className={`h-5 w-5 ${isActive ? 'stroke-[2.5]' : 'stroke-2'}`} />
                    {!!item.badge && (
                      <span className="absolute -top-1 right-0 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-emerald-500 px-1 text-[11px] font-extrabold tabular-nums text-zinc-950 ring-2 ring-zinc-950">
                        {item.badge}
                      </span>
                    )}
                  </span>
                  <span className={`text-[11px] leading-[14px] ${isActive ? 'font-semibold' : 'font-medium'}`}>
                    {item.shortLabel}
                  </span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* The rail has no room for a footer, so the account row it replaces
            (sign out, install) opens from the avatar. */}
        <button
          type="button"
          onClick={() => setAccountMenuOpen((open) => !open)}
          aria-expanded={accountMenuOpen}
          aria-label={`Account: ${user.display_name}, ${ROLE_LABELS[user.role]}`}
          className="mt-2 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-zinc-700/60 bg-zinc-800 text-[13px] font-bold text-emerald-400 transition-colors hover:border-zinc-600 hover:text-white"
        >
          {initial}
        </button>
      </aside>

      {/* Rail account menu */}
      {accountMenuOpen && (
        <div className="hidden md:block xl:hidden">
          <div className="fixed inset-0 z-40" onClick={() => setAccountMenuOpen(false)} />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Account"
            className="animate-in fade-in fixed bottom-4 left-[80px] z-50 flex w-60 flex-col gap-1 rounded-2xl border border-zinc-800 bg-zinc-950 p-2 shadow-2xl"
          >
            <div className="flex min-w-0 items-center gap-2.5 rounded-xl bg-zinc-900/90 p-2 pl-2.5">
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[13px] font-bold text-emerald-400">
                {initial}
              </div>
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[13px] font-bold leading-[18px] text-white">{user.display_name}</span>
                <span className="truncate text-[11px] leading-4 text-zinc-400">
                  {ROLE_LABELS[user.role]} · {user.username}
                </span>
              </div>
            </div>

            {onOpenInstallModal && (
              <button
                type="button"
                onClick={() => {
                  setAccountMenuOpen(false);
                  onOpenInstallModal();
                }}
                className="flex h-11 items-center gap-3 rounded-xl px-3 text-[13px] font-medium text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-white"
              >
                <Smartphone className="h-[18px] w-[18px] flex-shrink-0 text-emerald-400" />
                <span className="truncate">{isStandalone ? 'Installed (App Mode)' : 'Install on phone'}</span>
              </button>
            )}

            <button
              type="button"
              onClick={onLogout}
              className="flex h-11 items-center gap-3 rounded-xl px-3 text-[13px] font-medium text-zinc-300 transition-colors hover:bg-zinc-900 hover:text-white"
            >
              <LogOut className="h-[18px] w-[18px] flex-shrink-0" />
              Sign out
            </button>
          </div>
        </div>
      )}

      {/* Phone top bar — 56px. */}
      <div
        className="sticky z-30 flex h-14 flex-shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-950 pl-1.5 pr-4 md:hidden"
        style={{ top: 'var(--admin-banner, 0px)' }}
      >
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setMobileDrawerOpen(true)}
            className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex min-w-0 flex-col">
            <span className="text-xs font-bold uppercase leading-4 tracking-[0.05em] text-white">NEXUS POS</span>
            <span className="truncate text-[11px] font-medium leading-[14px] text-zinc-400">{user.display_name}</span>
          </div>
        </div>

        <div className="flex flex-shrink-0 items-center gap-2.5">
          {cartCount > 0 && (
            <span
              role="status"
              aria-label={`${cartCount} items in order`}
              className="flex h-5 min-w-[22px] items-center justify-center rounded-full bg-emerald-500 px-1.5 text-[11px] font-extrabold tabular-nums text-zinc-950"
            >
              {cartCount}
            </span>
          )}
          <span role="img" aria-label="Live" className="h-2 w-2 rounded-full bg-emerald-400 ring-[3px] ring-emerald-400/20" />
        </div>
      </div>

      {/* Phone bottom nav — four destinations plus More. */}
      <div
        className="fixed inset-x-0 bottom-0 z-50 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur-xs md:hidden"
        style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))' }}
      >
        <nav className="grid px-1" style={{ gridTemplateColumns: `repeat(${phoneColumns}, minmax(0, 1fr))` }}>
          {phoneTabs.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleSelectTab(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`flex h-16 touch-manipulation flex-col items-center justify-center gap-1 transition-transform active:scale-98 ${
                  isActive ? 'text-emerald-400' : 'text-zinc-400'
                }`}
              >
                <span
                  className={`relative flex h-[30px] w-12 items-center justify-center rounded-full ${
                    isActive ? 'bg-zinc-800' : ''
                  }`}
                >
                  <Icon className={`h-5 w-5 ${isActive ? 'stroke-[2.5]' : 'stroke-2'}`} />
                  {!!item.badge && (
                    <span className="absolute -top-1.5 right-0 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-emerald-500 px-1 text-[11px] font-extrabold tabular-nums text-zinc-950 ring-2 ring-zinc-950">
                      {item.badge}
                    </span>
                  )}
                </span>
                <span className={`text-[11px] leading-[14px] ${isActive ? 'font-bold' : 'font-medium'}`}>
                  {item.shortLabel}
                </span>
              </button>
            );
          })}

          {moreTabs.length > 0 && (
            <button
              type="button"
              onClick={() => setMoreOpen((open) => !open)}
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              aria-current={moreIsActive ? 'page' : undefined}
              className={`flex h-16 touch-manipulation flex-col items-center justify-center gap-1 transition-transform active:scale-98 ${
                moreIsActive || moreOpen ? 'text-emerald-400' : 'text-zinc-400'
              }`}
            >
              <span
                className={`flex h-[30px] w-12 items-center justify-center rounded-full ${
                  moreIsActive || moreOpen ? 'bg-zinc-800' : ''
                }`}
              >
                <Ellipsis className={`h-5 w-5 ${moreIsActive || moreOpen ? 'stroke-[2.5]' : 'stroke-2'}`} />
              </span>
              <span className={`text-[11px] leading-[14px] ${moreIsActive || moreOpen ? 'font-bold' : 'font-medium'}`}>
                More
              </span>
            </button>
          )}
        </nav>
      </div>

      {/* More sheet — sits directly above the bottom bar, which stays tappable. */}
      {moreOpen && moreTabs.length > 0 && (
        <div className="md:hidden">
          <div className="fixed inset-0 z-40 bg-zinc-950/70 backdrop-blur-xs" onClick={() => setMoreOpen(false)} />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="More destinations"
            className="animate-in fade-in fixed inset-x-0 z-50 rounded-t-2xl border-t border-zinc-800 bg-zinc-950 px-3 pb-3 pt-2"
            style={{ bottom: `calc(${PHONE_NAV_HEIGHT}px + env(safe-area-inset-bottom, 0px))` }}
          >
            <div className="flex items-center justify-between pb-1 pl-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-zinc-400">More</span>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                className="flex h-10 w-10 items-center justify-center rounded-xl text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-white"
                aria-label="Close more menu"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex flex-col gap-1">
              {moreTabs.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleSelectTab(item.id)}
                    aria-current={isActive ? 'page' : undefined}
                    className={`flex h-12 touch-manipulation items-center gap-3 rounded-xl px-3 text-left transition-colors ${
                      isActive ? 'bg-zinc-800 text-white ring-1 ring-zinc-700/60' : 'text-zinc-400 hover:bg-zinc-900'
                    }`}
                  >
                    <Icon
                      className={`h-5 w-5 flex-shrink-0 ${isActive ? 'stroke-[2.5] text-emerald-400' : 'stroke-2'}`}
                    />
                    <span className={`truncate text-sm ${isActive ? 'font-bold' : 'font-medium'}`}>{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Phone drawer — the full panel, reached from the top bar's menu button. */}
      {mobileDrawerOpen && (
        <div className="fixed inset-0 z-50 flex bg-black/70 backdrop-blur-xs md:hidden">
          <div className="h-full w-72 max-w-[85vw] shadow-2xl">{renderPanel(true)}</div>
          <div className="flex-1" onClick={() => setMobileDrawerOpen(false)} />
        </div>
      )}
    </>
  );
};
