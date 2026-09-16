import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ShieldAlert, ArrowLeft } from 'lucide-react';
import { User } from '../types';
import { adminApi } from '../utils/api';
import { setToken } from '../utils/auth';

interface ImpersonationBannerProps {
  user: User;
}

/**
 * Shown across the top of the register whenever a platform administrator is
 * switched into a store. It must be impossible to forget: every change made
 * on this screen is written to the admin audit log, and sales, refunds, voids
 * and stock changes are refused outright.
 */
export const ImpersonationBanner: React.FC<ImpersonationBannerProps> = ({ user }) => {
  const [storeName, setStoreName] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // The banner is fixed, so the register and sidebar read its height from a
  // CSS variable and move down by that much. It wraps on narrow screens,
  // hence the observer rather than a constant.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty('--admin-banner', `${el.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--admin-banner');
    };
  }, []);

  useEffect(() => {
    adminApi
      .me()
      .then((me) => setStoreName(me.acting_tenant?.name ?? null))
      .catch(() => setStoreName(null));
  }, [user.tenant_id]);

  const leave = async () => {
    setLeaving(true);
    try {
      await adminApi.stopImpersonating();
    } catch {
      // The admin session may already have ended; leaving is still right.
    }
    setToken(null);
    window.location.href = '/admin';
  };

  return (
    <div ref={ref} className="fixed top-0 inset-x-0 z-[60] bg-amber-400 text-amber-950 border-b-2 border-amber-500 shadow-md">
      <div className="max-w-screen-2xl mx-auto px-4 py-2 flex items-center gap-3 text-xs sm:text-sm">
        <ShieldAlert className="w-5 h-5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <span className="font-extrabold uppercase tracking-wide">Administrator view</span>
          <span className="mx-2 opacity-60">·</span>
          <span>
            You are looking at <strong>{storeName ?? 'this store'}</strong> as its owner. Catalogue and settings
            changes are allowed and logged against you. Sales, refunds, voids and stock changes are refused.
          </span>
        </div>
        <button
          type="button"
          onClick={leave}
          disabled={leaving}
          className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-950 hover:bg-black disabled:opacity-60 text-amber-50 text-xs font-bold rounded-lg transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          {leaving ? 'Switching out…' : 'Switch out'}
        </button>
      </div>
    </div>
  );
};
