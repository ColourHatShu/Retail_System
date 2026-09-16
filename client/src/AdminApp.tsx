import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRightLeft,
  Check,
  KeyRound,
  Lock,
  LogIn,
  LogOut,
  Plus,
  Power,
  RefreshCw,
  ShieldCheck,
  Store,
  User as UserIcon,
  UserPlus,
  X,
} from 'lucide-react';
import { AdminAction, PlatformAdmin, Tenant } from './types';
import { adminApi, ApiError, TenantCreateInput } from './utils/api';
import { getAdminToken, setAdminToken, setToken } from './utils/auth';

/**
 * The platform administrator's surface, served at /admin.
 *
 * Deliberately not a fourth tab in the register. The admin is a different
 * principal with a different job: provisioning sellers, keeping them running,
 * and switching into one to see a problem first-hand — never ringing their
 * sales.
 */

type AuthState = 'checking' | 'setup' | 'login' | 'ready';
type View = 'stores' | 'switch' | 'activity';

const VIEWS: Array<{ key: View; label: string }> = [
  { key: 'stores', label: 'Stores' },
  { key: 'switch', label: 'Switch into a store' },
  { key: 'activity', label: 'Activity' },
];

const field =
  'w-full pl-9 pr-3 py-2.5 text-sm bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:bg-white placeholder:text-zinc-400';
const plainField =
  'w-full px-3 py-2.5 text-sm bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:bg-white placeholder:text-zinc-400';

const ACTION_LABELS: Record<string, string> = {
  ADMIN_SETUP: 'Administrator account created',
  ADMIN_LOGIN: 'Signed in',
  TENANT_CREATED: 'Created store',
  TENANT_UPDATED: 'Renamed store',
  TENANT_DEACTIVATED: 'Deactivated store',
  TENANT_REACTIVATED: 'Reactivated store',
  OWNER_PASSWORD_RESET: 'Reset owner password',
  IMPERSONATION_STARTED: 'Switched into store',
  IMPERSONATION_STOPPED: 'Switched out of store',
  IMPERSONATED_WRITE: 'Changed something while switched in',
};

/**
 * Impersonated writes carry the response status: a refused attempt (a sale,
 * a refund, a stock change) must not read as if it went through.
 */
function actionLabel(a: AdminAction): string {
  if (a.action === 'IMPERSONATED_WRITE') {
    const status = Number(a.details?.status ?? 0);
    if (status === 403) return 'Blocked while switched in';
    if (status >= 400) return 'Failed change while switched in';
  }
  return ACTION_LABELS[a.action] ?? a.action;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// ===========================================================================

export const AdminApp: React.FC = () => {
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [admin, setAdmin] = useState<PlatformAdmin | null>(null);
  const [actingTenant, setActingTenant] = useState<Tenant | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const checkSession = useCallback(async () => {
    setAuthError(null);
    try {
      const status = await adminApi.status();
      if (status.needs_setup) return setAuthState('setup');
      if (!getAdminToken()) return setAuthState('login');
      const me = await adminApi.me();
      setAdmin(me.admin);
      setActingTenant(me.acting_tenant);
      setAuthState('ready');
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'NETWORK_ERROR' || err.code === 'DATABASE_UNAVAILABLE')) {
        setAuthError(err.message);
        setAuthState('checking');
      } else {
        setAdminToken(null);
        setAuthState('login');
      }
    }
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  const signedIn = (session: { admin: PlatformAdmin; token: string }) => {
    setAdminToken(session.token);
    setAdmin(session.admin);
    setActingTenant(null);
    setAuthState('ready');
  };

  const signOut = async () => {
    try {
      await adminApi.logout();
    } catch {
      // Already gone; clearing locally is what matters.
    }
    setAdminToken(null);
    setAdmin(null);
    setAuthState('login');
  };

  if (authState === 'checking') {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center p-4">
        <div className="text-center space-y-3">
          <RefreshCw className="w-6 h-6 text-zinc-400 animate-spin mx-auto" />
          <p className="text-xs text-zinc-500">{authError ?? 'Checking administrator session…'}</p>
          {authError && (
            <button onClick={checkSession} className="text-xs font-bold text-zinc-900 underline">
              Try again
            </button>
          )}
        </div>
      </div>
    );
  }

  if (authState !== 'ready' || !admin) {
    return <AdminSignIn mode={authState === 'setup' ? 'setup' : 'login'} onSuccess={signedIn} />;
  }

  return <AdminPanel admin={admin} actingTenant={actingTenant} onSignOut={signOut} onRefreshSession={checkSession} />;
};

// ===========================================================================
// Sign in / one-time setup
// ===========================================================================

const AdminSignIn: React.FC<{
  mode: 'setup' | 'login';
  onSuccess: (session: { admin: PlatformAdmin; token: string }) => void;
}> = ({ mode, onSuccess }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isSetup = mode === 'setup';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const session = isSetup
        ? await adminApi.setup({ username, password, display_name: displayName })
        : await adminApi.login({ username, password });
      onSuccess(session);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-white rounded-2xl border border-zinc-200 shadow-2xl p-6 space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-zinc-950 text-amber-400 flex items-center justify-center">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-sm font-extrabold tracking-tight text-zinc-900 uppercase">Platform Admin</h1>
            <p className="text-xs text-zinc-500">{isSetup ? 'Create the administrator account' : 'Administrators only'}</p>
          </div>
        </div>

        {isSetup && (
          <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
            No administrator exists yet. This account manages every store on the platform — it is not a store
            login. This screen will not appear again.
          </div>
        )}

        {isSetup && (
          <label className="block space-y-1">
            <span className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">Your name</span>
            <div className="relative">
              <UserIcon className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input className={field} value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
            </div>
          </label>
        )}

        <label className="block space-y-1">
          <span className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">Username</span>
          <div className="relative">
            <UserIcon className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              className={field}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </div>
        </label>

        <label className="block space-y-1">
          <span className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">
            Password {isSetup && <span className="normal-case font-normal text-zinc-400">(8+ characters)</span>}
          </span>
          <div className="relative">
            <Lock className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              className={field}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isSetup ? 'new-password' : 'current-password'}
              minLength={isSetup ? 8 : 1}
              required
            />
          </div>
        </label>

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full flex items-center justify-center gap-2 py-2.5 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-60 text-white text-sm font-bold rounded-xl transition-colors"
        >
          {isSetup ? <UserPlus className="w-4 h-4" /> : <LogIn className="w-4 h-4" />}
          {busy ? 'Please wait…' : isSetup ? 'Create administrator' : 'Sign in'}
        </button>

        <p className="text-center text-[11px] text-zinc-400">
          Looking for the register?{' '}
          <a href="/" className="font-bold text-zinc-700 underline">
            Store sign-in
          </a>
        </p>
      </form>
    </div>
  );
};

// ===========================================================================
// The panel
// ===========================================================================

const AdminPanel: React.FC<{
  admin: PlatformAdmin;
  actingTenant: Tenant | null;
  onSignOut: () => void;
  onRefreshSession: () => void;
}> = ({ admin, actingTenant, onSignOut, onRefreshSession }) => {
  const [view, setView] = useState<View>('stores');
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [actions, setActions] = useState<AdminAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [resetFor, setResetFor] = useState<Tenant | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [t, a] = await Promise.all([adminApi.listTenants(), adminApi.actions({ limit: 200 })]);
      setTenants(t);
      setActions(a);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the platform');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    }
  };

  /**
   * Switching into a store: once the admin session is marked, the register
   * accepts the admin's own token as that store's owner. So the store token
   * is pointed at it and the register is opened. The register shows a banner
   * with a "Switch out" button the whole time, and refuses anything that
   * moves money.
   */
  const switchInto = (t: Tenant) =>
    run(async () => {
      await adminApi.impersonate(t.id);
      setToken(getAdminToken());
      window.location.href = '/';
    }, `Switching into ${t.name}…`);

  const switchOut = () =>
    run(async () => {
      await adminApi.stopImpersonating();
      setToken(null);
      onRefreshSession();
    }, 'Switched out');

  const active = useMemo(() => tenants.filter((t) => t.is_active).length, [tenants]);

  const nav = (extra: string) =>
    VIEWS.map((v) => (
      <button
        key={v.key}
        onClick={() => setView(v.key)}
        className={`${extra} ${view === v.key ? 'bg-white text-zinc-900' : 'text-zinc-400 hover:text-white'}`}
      >
        {v.label}
      </button>
    ));

  return (
    <div className="min-h-screen bg-zinc-100">
      <header className="bg-zinc-950 text-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-zinc-800 text-amber-400 flex items-center justify-center">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-extrabold uppercase tracking-tight">Nexus POS — Platform Admin</h1>
            <p className="text-[11px] text-zinc-400">
              {admin.display_name} · {tenants.length} store{tenants.length === 1 ? '' : 's'}, {active} active
            </p>
          </div>
          <nav className="hidden md:flex items-center gap-1 bg-zinc-900 rounded-xl p-1">
            {nav('px-3 py-1.5 rounded-lg text-xs font-bold transition-colors')}
          </nav>
          <button
            onClick={onSignOut}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-zinc-300 hover:text-white rounded-lg hover:bg-zinc-800"
            title="Sign out"
          >
            <LogOut className="w-4 h-4" /> <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </header>

      {actingTenant && (
        <div className="bg-amber-400 text-amber-950 border-b-2 border-amber-500">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-2 flex items-center gap-3 text-xs sm:text-sm">
            <ArrowRightLeft className="w-4 h-4" />
            <span className="flex-1">
              You are switched into <strong>{actingTenant.name}</strong>.
            </span>
            <a href="/" className="font-bold underline">
              Open their register
            </a>
            <button onClick={switchOut} className="px-3 py-1 bg-amber-950 text-amber-50 text-xs font-bold rounded-lg">
              Switch out
            </button>
          </div>
        </div>
      )}

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        <div className="md:hidden flex items-center gap-1 bg-zinc-900 rounded-xl p-1">
          {nav('flex-1 px-2 py-1.5 rounded-lg text-[11px] font-bold')}
        </div>

        {error && <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800">{error}</div>}
        {notice && (
          <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">{notice}</div>
        )}

        {view === 'stores' && (
          <StoresView
            tenants={tenants}
            loading={loading}
            onRefresh={load}
            onCreate={() => setCreateOpen(true)}
            onSwitchInto={switchInto}
            onToggle={(t) =>
              run(
                () => (t.is_active ? adminApi.deactivateTenant(t.id) : adminApi.reactivateTenant(t.id)),
                t.is_active ? `${t.name} deactivated — its staff are signed out` : `${t.name} reactivated`,
              )
            }
            onResetPassword={(t) => setResetFor(t)}
            onRename={(t) => {
              const name = prompt(`New name for ${t.name}:`, t.name);
              if (name && name.trim() && name.trim() !== t.name) {
                run(() => adminApi.updateTenant(t.id, { name: name.trim() }), `Renamed to ${name.trim()}`);
              }
            }}
          />
        )}
        {view === 'switch' && (
          <SwitchView tenants={tenants} actingTenant={actingTenant} onSwitchInto={switchInto} onSwitchOut={switchOut} />
        )}
        {view === 'activity' && <ActivityView actions={actions} loading={loading} onRefresh={load} />}
      </main>

      {createOpen && (
        <CreateStoreModal
          onClose={() => setCreateOpen(false)}
          onCreated={async (t) => {
            setCreateOpen(false);
            setNotice(`${t.name} is ready. Its owner can sign in at the register as "${t.owner_username}".`);
            await load();
          }}
        />
      )}

      {resetFor && (
        <ResetPasswordModal
          tenant={resetFor}
          onClose={() => setResetFor(null)}
          onDone={async (username) => {
            setResetFor(null);
            setNotice(`Password reset for "${username}" — they are signed out everywhere and must sign in again.`);
            await load();
          }}
        />
      )}
    </div>
  );
};

// ===========================================================================
// Switch into a store — see what a seller sees, first-hand
// ===========================================================================

const SwitchView: React.FC<{
  tenants: Tenant[];
  actingTenant: Tenant | null;
  onSwitchInto: (t: Tenant) => void;
  onSwitchOut: () => void;
}> = ({ tenants, actingTenant, onSwitchInto, onSwitchOut }) => {
  const activeStores = tenants.filter((t) => t.is_active);
  return (
    <section className="space-y-4">
      <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-5 space-y-3">
        <h2 className="text-sm font-bold text-zinc-900 flex items-center gap-2">
          <ArrowRightLeft className="w-4 h-4" /> Switch into a store
        </h2>
        <p className="text-xs text-zinc-600 leading-relaxed">
          Opens that store's register signed in as its <strong>owner</strong>, so you see exactly what they see —
          the same screens, the same data, the same problem they are describing — and can fix their catalogue,
          departments, staff and settings on the spot. A banner with a <strong>Switch out</strong> button stays on
          screen the whole time, and every change you make is recorded against your administrator account in the
          Activity log.
        </p>
        <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
          <strong>Sales, refunds, voids and stock changes are refused while switched in.</strong> A sale rung this way
          would put a cashier's name on a receipt for someone who was never there — those must be made by the
          store's own staff.
        </div>
        {actingTenant && (
          <div className="flex items-center gap-3 p-3 rounded-xl bg-zinc-900 text-white text-xs">
            <span className="flex-1">
              You are currently switched into <strong>{actingTenant.name}</strong>.
            </span>
            <a href="/" className="px-3 py-1.5 bg-white text-zinc-900 font-bold rounded-lg">
              Open their register
            </a>
            <button onClick={onSwitchOut} className="px-3 py-1.5 bg-amber-400 text-amber-950 font-bold rounded-lg">
              Switch out
            </button>
          </div>
        )}
      </div>

      {activeStores.length === 0 ? (
        <div className="bg-white rounded-2xl border border-zinc-200 p-10 text-center text-xs text-zinc-500">
          No active stores to switch into.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {activeStores.map((t) => {
            const current = actingTenant?.id === t.id;
            return (
              <div
                key={t.id}
                className={`bg-white rounded-2xl border shadow-sm p-4 flex flex-col gap-3 ${
                  current ? 'border-amber-400 ring-2 ring-amber-200' : 'border-zinc-200'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-zinc-100 text-zinc-700 flex items-center justify-center flex-shrink-0">
                    <Store className="w-5 h-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-zinc-900 truncate">{t.name}</div>
                    <div className="text-[11px] text-zinc-500">
                      owner <span className="font-mono">{t.owner_username ?? '—'}</span>
                      <span className="mx-1">·</span>
                      {t.product_count ?? 0} products
                      <span className="mx-1">·</span>
                      {t.sale_count ?? 0} sales
                    </div>
                  </div>
                </div>
                {current ? (
                  <button
                    onClick={onSwitchOut}
                    className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 bg-amber-400 hover:bg-amber-300 text-amber-950 text-xs font-bold rounded-xl transition-colors"
                  >
                    <ArrowRightLeft className="w-4 h-4" /> Switched in — switch out
                  </button>
                ) : (
                  <button
                    onClick={() => onSwitchInto(t)}
                    disabled={!t.owner_username}
                    title={t.owner_username ? undefined : 'This store has no owner account to act as'}
                    className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 bg-zinc-900 hover:bg-zinc-800 disabled:bg-zinc-300 disabled:cursor-not-allowed text-white text-xs font-bold rounded-xl transition-colors"
                  >
                    <ArrowRightLeft className="w-4 h-4" />
                    {t.owner_username ? `Switch into ${t.name}` : 'No owner to act as'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};

// ===========================================================================
// Stores
// ===========================================================================

const StoresView: React.FC<{
  tenants: Tenant[];
  loading: boolean;
  onRefresh: () => void;
  onCreate: () => void;
  onSwitchInto: (t: Tenant) => void;
  onToggle: (t: Tenant) => void;
  onResetPassword: (t: Tenant) => void;
  onRename: (t: Tenant) => void;
}> = ({ tenants, loading, onRefresh, onCreate, onSwitchInto, onToggle, onResetPassword, onRename }) => (
  <section className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
    <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-zinc-100">
      <div className="flex items-center gap-2">
        <Store className="w-4 h-4 text-zinc-500" />
        <span className="text-sm font-bold text-zinc-900">Stores</span>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={onRefresh} className="p-1.5 text-zinc-400 hover:text-zinc-900 rounded-lg" title="Refresh">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
        <button
          onClick={onCreate}
          className="inline-flex items-center gap-1.5 px-3 py-2 bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-bold rounded-xl"
        >
          <Plus className="w-4 h-4" /> New store
        </button>
      </div>
    </div>

    {tenants.length === 0 && !loading ? (
      <div className="p-10 text-center text-xs text-zinc-500">No stores yet. Create the first one.</div>
    ) : (
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-zinc-50 text-[10px] uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="text-left px-4 py-2">Store</th>
              <th className="text-left px-4 py-2">Owner</th>
              <th className="text-right px-4 py-2">Staff</th>
              <th className="text-right px-4 py-2">Products</th>
              <th className="text-right px-4 py-2">Sales</th>
              <th className="text-left px-4 py-2">Last sale</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-right px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {tenants.map((t) => (
              <tr key={t.id} className={t.is_active ? '' : 'opacity-60'}>
                <td className="px-4 py-3">
                  <div className="font-semibold text-zinc-900">{t.name}</div>
                  <div className="font-mono text-[10px] text-zinc-400">{t.slug}</div>
                </td>
                <td className="px-4 py-3 font-mono text-zinc-600">{t.owner_username ?? '—'}</td>
                <td className="px-4 py-3 text-right tabular-nums">{t.user_count ?? 0}</td>
                <td className="px-4 py-3 text-right tabular-nums">{t.product_count ?? 0}</td>
                <td className="px-4 py-3 text-right tabular-nums">{t.sale_count ?? 0}</td>
                <td className="px-4 py-3 text-zinc-500">{t.last_sale_at ? when(t.last_sale_at) : 'never'}</td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-bold text-[10px] ${
                      t.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-zinc-100 text-zinc-500'
                    }`}
                  >
                    {t.is_active ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
                    {t.is_active ? 'Active' : 'Deactivated'}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1 flex-wrap">
                    <button
                      onClick={() => onSwitchInto(t)}
                      disabled={!t.is_active}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-white text-[11px] font-bold rounded-lg"
                    >
                      <ArrowRightLeft className="w-3.5 h-3.5" /> Switch into
                    </button>
                    <button
                      onClick={() => onRename(t)}
                      className="px-2.5 py-1.5 border border-zinc-200 hover:bg-zinc-50 text-[11px] font-semibold rounded-lg"
                    >
                      Rename
                    </button>
                    <button
                      onClick={() => onResetPassword(t)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-zinc-200 hover:bg-zinc-50 text-[11px] font-semibold rounded-lg"
                      title="Set a new password for the store's owner"
                    >
                      <KeyRound className="w-3.5 h-3.5" /> Owner password
                    </button>
                    <button
                      onClick={() => {
                        const verb = t.is_active ? 'Deactivate' : 'Reactivate';
                        const detail = t.is_active
                          ? 'Its staff will be signed out immediately and cannot sign in until it is reactivated. Nothing is deleted — every receipt and stock record is kept.'
                          : 'Its staff will be able to sign in again.';
                        if (confirm(`${verb} ${t.name}?\n\n${detail}`)) onToggle(t);
                      }}
                      className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold rounded-lg border ${
                        t.is_active
                          ? 'border-rose-200 text-rose-700 hover:bg-rose-50'
                          : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'
                      }`}
                    >
                      <Power className="w-3.5 h-3.5" /> {t.is_active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </section>
);

// ===========================================================================
// Activity
// ===========================================================================

const ActivityView: React.FC<{ actions: AdminAction[]; loading: boolean; onRefresh: () => void }> = ({
  actions,
  loading,
  onRefresh,
}) => (
  <section className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
    <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-zinc-100">
      <div className="flex items-center gap-2">
        <Activity className="w-4 h-4 text-zinc-500" />
        <span className="text-sm font-bold text-zinc-900">Administrator activity</span>
        <span className="hidden sm:inline text-[11px] text-zinc-400">— everything an administrator has done, newest first</span>
      </div>
      <button onClick={onRefresh} className="p-1.5 text-zinc-400 hover:text-zinc-900 rounded-lg" title="Refresh">
        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
      </button>
    </div>
    {actions.length === 0 ? (
      <div className="p-10 text-center text-xs text-zinc-500">Nothing recorded yet.</div>
    ) : (
      <ul className="divide-y divide-zinc-100">
        {actions.map((a) => (
          <li key={a.id} className="px-4 sm:px-5 py-3 flex items-start gap-3 text-xs">
            <div className="w-28 flex-shrink-0 text-zinc-400 tabular-nums">{when(a.created_at)}</div>
            <div className="flex-1 min-w-0">
              <span className="font-semibold text-zinc-900">{actionLabel(a)}</span>
              {a.tenant_name && (
                <span className="text-zinc-600">
                  {' '}
                  — <strong>{a.tenant_name}</strong>
                </span>
              )}
              {a.details && (
                <div className="mt-0.5 font-mono text-[10px] text-zinc-400 truncate">
                  {Object.entries(a.details)
                    .map(([k, v]) => `${k}=${String(v)}`)
                    .join('  ')}
                </div>
              )}
            </div>
            <div className="text-zinc-400 font-mono text-[10px]">{a.admin_username}</div>
          </li>
        ))}
      </ul>
    )}
  </section>
);

// ===========================================================================
// Modals
// ===========================================================================

const CreateStoreModal: React.FC<{ onClose: () => void; onCreated: (t: Tenant) => void }> = ({ onClose, onCreated }) => {
  const [form, setForm] = useState<TenantCreateInput>({
    slug: '',
    name: '',
    owner_username: '',
    owner_display_name: '',
    owner_password: '',
    currency: 'CAD',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [slugTouched, setSlugTouched] = useState(false);

  const setName = (name: string) => {
    const auto = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    setForm((f) => ({ ...f, name, slug: slugTouched ? f.slug : auto }));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      onCreated(await adminApi.createTenant(form));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the store');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-950/60 backdrop-blur-sm">
      <form onSubmit={submit} className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-zinc-200 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-zinc-900 flex items-center gap-2">
            <Store className="w-4 h-4" /> New store
          </h2>
          <button type="button" onClick={onClose} className="p-1 text-zinc-400 hover:text-zinc-900 rounded-lg">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-zinc-500">
          Creates the store, its owner account, the six standard departments and its settings in one step. The
          owner can rename departments and add staff afterwards.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block space-y-1 sm:col-span-2">
            <span className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">Store name</span>
            <input className={plainField} value={form.name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">Store code</span>
            <input
              className={`${plainField} font-mono`}
              value={form.slug}
              onChange={(e) => {
                setSlugTouched(true);
                setForm((f) => ({ ...f, slug: e.target.value.toLowerCase() }));
              }}
              pattern="[a-z0-9][a-z0-9\-]*[a-z0-9]"
              title="Letters, digits and dashes; must start and end with a letter or digit"
              minLength={2}
              maxLength={40}
              required
            />
            <span className="block text-[10px] text-zinc-400">Staff type this if their username exists in another store.</span>
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">Currency</span>
            <input
              className={`${plainField} font-mono uppercase`}
              value={form.currency}
              onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))}
              maxLength={3}
              minLength={3}
              required
            />
          </label>
        </div>

        <div className="pt-2 border-t border-zinc-100">
          <div className="text-[11px] font-bold uppercase tracking-wide text-zinc-500 mb-2">Owner account</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-[11px] text-zinc-500">Full name</span>
              <input
                className={plainField}
                value={form.owner_display_name}
                onChange={(e) => setForm((f) => ({ ...f, owner_display_name: e.target.value }))}
                required
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-zinc-500">Username</span>
              <input
                className={`${plainField} font-mono`}
                value={form.owner_username}
                onChange={(e) => setForm((f) => ({ ...f, owner_username: e.target.value.toLowerCase() }))}
                autoCapitalize="none"
                spellCheck={false}
                required
              />
            </label>
            <label className="block space-y-1 sm:col-span-2">
              <span className="text-[11px] text-zinc-500">Temporary password (8+ characters)</span>
              <input
                className={plainField}
                type="password"
                value={form.owner_password}
                onChange={(e) => setForm((f) => ({ ...f, owner_password: e.target.value }))}
                minLength={8}
                autoComplete="new-password"
                required
              />
            </label>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-semibold text-zinc-600 hover:text-zinc-900">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-60 text-white text-xs font-bold rounded-xl"
          >
            <Plus className="w-4 h-4" /> {busy ? 'Creating…' : 'Create store'}
          </button>
        </div>
      </form>
    </div>
  );
};

const ResetPasswordModal: React.FC<{ tenant: Tenant; onClose: () => void; onDone: (username: string) => void }> = ({
  tenant,
  onClose,
  onDone,
}) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { username } = await adminApi.resetOwnerPassword(tenant.id, password);
      onDone(username);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reset the password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-950/60 backdrop-blur-sm">
      <form onSubmit={submit} className="w-full max-w-sm bg-white rounded-2xl shadow-2xl border border-zinc-200 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-zinc-900 flex items-center gap-2">
            <KeyRound className="w-4 h-4" /> Reset owner password
          </h2>
          <button type="button" onClick={onClose} className="p-1 text-zinc-400 hover:text-zinc-900 rounded-lg">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-zinc-500">
          Sets a new password for the owner of <strong>{tenant.name}</strong>
          {tenant.owner_username ? (
            <>
              {' '}
              (<span className="font-mono">{tenant.owner_username}</span>)
            </>
          ) : null}
          . Their existing sessions are ended. Tell them the new password out of band; it is not shown again.
        </p>
        <label className="block space-y-1">
          <span className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">New password (8+ characters)</span>
          <input
            className={plainField}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            autoComplete="new-password"
            autoFocus
            required
          />
        </label>
        {error && (
          <div className="flex items-start gap-2 p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-semibold text-zinc-600 hover:text-zinc-900">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="px-4 py-2 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-60 text-white text-xs font-bold rounded-xl"
          >
            {busy ? 'Saving…' : 'Set password'}
          </button>
        </div>
      </form>
    </div>
  );
};
