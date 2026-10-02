import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  UserPlus,
  KeyRound,
  Lock,
  UserCog,
  UserX,
  UserCheck,
  Check,
  Minus,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  X,
  ShoppingCart,
  Undo2,
  Package,
  ScanLine,
  History,
  BarChart3,
  Users,
  Store,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Role, User } from '../types';
import { api, ApiError } from '../utils/api';
import { ActiveTab, TABS_FOR_ROLE } from '../components/Sidebar';

interface UsersPageProps {
  currentUser: User;
}

const ROLE_LABELS: Record<Role, string> = { OWNER: 'Owner', MANAGER: 'Manager', CASHIER: 'Cashier' };

/** Least access first — the access summary reads as a ladder in that order. */
const ROLE_ORDER: Role[] = ['CASHIER', 'MANAGER', 'OWNER'];

/** Must match TABS_FOR_ROLE in components/Sidebar.tsx — staff pick a role from these words. */
const ROLE_HELP: Record<Role, string> = {
  OWNER: 'Everything a manager can do, plus staff accounts and roles, and refunds past the return window',
  MANAGER: 'Products, stock adjustments, imports, movement history and sales reports — but not staff',
  CASHIER: 'The register and receipt refunds only — no inventory, movement history or sales reports',
};

/**
 * Names and icons for the access summary. The access itself is read from
 * TABS_FOR_ROLE, so this panel cannot drift from what the sidebar offers and
 * the server enforces. Typing it as Record<ActiveTab, …> means a new screen
 * fails the build here rather than quietly going missing from the summary.
 */
const SCREEN_META: Record<ActiveTab, { label: string; short: string; Icon: LucideIcon }> = {
  pos: { label: 'POS Register', short: 'Register', Icon: ShoppingCart },
  returns: { label: 'Returns & Refunds', short: 'Returns', Icon: Undo2 },
  inventory: { label: 'Inventory', short: 'Inventory', Icon: Package },
  scanner: { label: 'Stock Scan (+/-)', short: 'Stock Scan', Icon: ScanLine },
  history: { label: 'Movement History', short: 'History', Icon: History },
  analytics: { label: 'Sales & Audit', short: 'Sales', Icon: BarChart3 },
  users: { label: 'Staff & Access', short: 'Staff', Icon: Users },
  profile: { label: 'Store Profile', short: 'Profile', Icon: Store },
};

/** Sidebar order, so the summary reads in the order the nav is laid out. */
const SCREEN_ORDER: ActiveTab[] = ['pos', 'returns', 'inventory', 'scanner', 'history', 'analytics', 'users'];

const screensFor = (role: Role) => TABS_FOR_ROLE[role].map((tab) => SCREEN_META[tab].short).join(', ');

/**
 * A sign-in log is scanned, not read: `toLocaleString()` printed
 * "2026-09-16, 2:20:14 p.m." for a fact an owner checks in one glance.
 * Today keeps its clock time; anything older is just the day.
 */
const formatSignIn = (iso: string | null) => {
  if (!iso) return 'Never';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'Unknown';
  const now = new Date();
  if (at.toDateString() === now.toDateString()) {
    return `Today ${at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`;
  }
  return at.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    // Only spell out the year when it is not this one, so "28 Aug" stays short.
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
};

const initialOf = (name: string) => (name.trim().charAt(0) || '?').toUpperCase();

// Shared surface tokens (SPEC.md): cards 16px radius on white with the zinc-200/80
// hairline, controls 12px radius on the solid zinc-200 border.
const CARD = 'bg-white rounded-2xl border border-zinc-200/80 shadow-xs';
const LABEL = 'text-[11px] leading-4 font-semibold uppercase tracking-[0.06em] text-zinc-500';
const PILL = 'h-[22px] px-2 rounded-full text-xs font-semibold inline-flex items-center whitespace-nowrap';
/** Height and padding stay at the call site: Tailwind resolves px-4 over px-3.5
 *  by source order, not by class order, so a shared px here would win silently. */
const PRIMARY_BTN =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 disabled:opacity-60 text-white text-[13px] font-semibold transition-colors';
const SECONDARY_BTN =
  'h-10 px-3 inline-flex items-center justify-center gap-2 rounded-xl bg-white border border-zinc-200 text-[13px] font-semibold text-zinc-800 hover:bg-zinc-50 disabled:opacity-60 transition-colors';
const DANGER_BTN =
  'h-10 px-3 inline-flex items-center justify-center gap-2 rounded-xl bg-white border border-rose-200 text-[13px] font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-60 transition-colors';
const RESTORE_BTN =
  'h-10 px-3 inline-flex items-center justify-center gap-2 rounded-xl bg-white border border-emerald-200 text-[13px] font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-60 transition-colors';
/** The self row shows this instead of an action it is not allowed to offer. */
const LOCKED_BTN =
  'h-10 px-3 inline-flex items-center justify-center gap-2 rounded-xl bg-zinc-50 border border-zinc-100 text-[13px] font-semibold text-zinc-400 cursor-not-allowed';
const ICON_BTN =
  'w-10 h-10 flex-shrink-0 flex items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 transition-colors';
const FIELD_LABEL = 'text-[13px] leading-5 font-semibold text-zinc-800';
const FIELD =
  'w-full h-11 px-3 text-sm bg-white border border-zinc-200 rounded-xl text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900';
const SHEET_BACKDROP =
  'fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-zinc-950/60 backdrop-blur-sm animate-in fade-in duration-150';
const SHEET_PANEL =
  'relative w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl border border-zinc-200 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]';

/**
 * The row carries three 40px buttons that need their full labels (434px of
 * them), so the table only appears once there is room for it: card rows below
 * lg, the tablet's merged "staff · last sign-in" column up to 1800px, and the
 * artboard's separate sign-in column above that — where the access panel also
 * fits beside the table rather than under it.
 */
const TABLE_GRID =
  'grid gap-3 grid-cols-[minmax(0,1fr)_88px_106px_434px] min-[1800px]:gap-4 min-[1800px]:grid-cols-[minmax(0,1fr)_110px_120px_120px_434px]';
const ROW_ACTIONS_GRID = 'grid grid-cols-[150px_128px_140px] gap-2 items-center';

const PAGE_DESCRIPTION =
  'Every sale and stock change records who made it. Deactivated staff are signed out at once and keep their history.';

/** One cell of the access summary. The icon is decorative; the word carries it. */
const AccessMark: React.FC<{ allowed: boolean }> = ({ allowed }) => (
  <div role="cell" className="flex items-center justify-center">
    {allowed ? (
      <Check className="w-4 h-4 text-emerald-700" strokeWidth={2.5} aria-hidden="true" />
    ) : (
      <Minus className="w-4 h-4 text-zinc-300" aria-hidden="true" />
    )}
    <span className="sr-only">{allowed ? 'Yes' : 'No'}</span>
  </div>
);

export const UsersPage: React.FC<UsersPageProps> = ({ currentUser }) => {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Blocks the confirm buttons while a write is in flight, so one tap is one write. */
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState({ username: '', display_name: '', password: '', role: 'CASHIER' as Role });
  const [creating, setCreating] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [resetFor, setResetFor] = useState<{ id: number; password: string } | null>(null);
  /** Role changes and deactivations used to fire on the first tap; both now confirm. */
  const [roleFor, setRoleFor] = useState<{ user: User; role: Role } | null>(null);
  const [deactivateFor, setDeactivateFor] = useState<User | null>(null);
  /** Phone only: which card has its actions open. */
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const noticeTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setUsers(await api.getUsers());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load staff');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => () => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
  }, []);

  const flash = (text: string) => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3500);
  };

  /** Resolves true only when the write landed, so a dialog can stay open on failure. */
  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      setError(null);
      await action();
      await load();
      flash(done);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    const ok = await run(async () => {
      await api.createUser(form);
    }, `Account "${form.username}" created`);
    setCreating(false);
    if (ok) {
      setForm({ username: '', display_name: '', password: '', role: 'CASHIER' });
      setAddOpen(false);
    }
  };

  const saveRole = async () => {
    if (!roleFor) return;
    const { user, role } = roleFor;
    const ok = await run(
      () => api.updateUser(user.id, { role }),
      `${user.display_name} is now ${ROLE_LABELS[role]}`,
    );
    if (ok) setRoleFor(null);
  };

  const confirmDeactivate = async () => {
    if (!deactivateFor) return;
    const target = deactivateFor;
    const ok = await run(
      () => api.updateUser(target.id, { is_active: false }),
      `${target.display_name} deactivated and signed out`,
    );
    if (ok) setDeactivateFor(null);
  };

  /** Restoring access is not destructive, so it stays a single tap. */
  const reactivate = (u: User) => run(() => api.updateUser(u.id, { is_active: true }), `${u.display_name} reactivated`);

  const submitReset = async (e: React.FormEvent, u: User) => {
    e.preventDefault();
    if (!resetFor) return;
    const ok = await run(
      () => api.updateUser(u.id, { password: resetFor.password }),
      `Password reset for ${u.display_name}; their other devices are signed out`,
    );
    if (ok) setResetFor(null);
  };

  /** The reset dialog needs the live row, not a copy, so a reload keeps it honest. */
  const resetUser = resetFor ? users.find((u) => u.id === resetFor.id) ?? null : null;
  const dialogOpen = addOpen || !!resetUser || !!roleFor || !!deactivateFor;

  const closeDialogs = useCallback(() => {
    setAddOpen(false);
    setResetFor(null);
    setRoleFor(null);
    setDeactivateFor(null);
  }, []);

  useEffect(() => {
    if (!dialogOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      // A half-finished write must not lose its dialog underneath it.
      if (e.key === 'Escape' && !busy && !creating) closeDialogs();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialogOpen, busy, creating, closeDialogs]);

  const activeCount = users.filter((u) => u.is_active).length;
  const inactiveCount = users.length - activeCount;
  const countsLabel =
    inactiveCount > 0 ? `${activeCount} active · ${inactiveCount} deactivated` : `${activeCount} active`;

  /** Shown inside the open dialog instead of the page banner it would sit behind. */
  const dialogError = error && dialogOpen && (
    <div className="flex items-start gap-2 p-3 rounded-xl bg-rose-50 border border-rose-200 text-[13px] leading-5 text-rose-700">
      <CircleAlert className="w-4 h-4 mt-px flex-shrink-0" aria-hidden="true" />
      <span>{error}</span>
    </div>
  );

  return (
    <div className="w-full px-4 sm:px-6 py-4 sm:py-6 flex flex-col gap-4">
      {/* Title and the primary action share a line; the description wraps below it. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h1 className="text-xl lg:text-[22px] lg:leading-7 font-bold tracking-[-0.01em] text-zinc-950">
          Staff &amp; Access
        </h1>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className={`${PRIMARY_BTN} h-12 lg:h-10 px-4`}
        >
          <UserPlus className="w-4 h-4" aria-hidden="true" />
          <span>Add staff member</span>
        </button>
        <p className="w-full lg:max-w-3xl text-[13px] leading-5 text-zinc-500">{PAGE_DESCRIPTION}</p>
      </div>

      {error && !dialogOpen && (
        <div
          role="alert"
          className="flex items-start gap-2 p-3 rounded-xl bg-rose-50 border border-rose-200 text-[13px] leading-5 text-rose-700"
        >
          <CircleAlert className="w-4 h-4 mt-px flex-shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="flex items-start gap-2 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-[13px] leading-5 text-emerald-700"
        >
          <Check className="w-4 h-4 mt-px flex-shrink-0" aria-hidden="true" />
          <span>{notice}</span>
        </div>
      )}

      <div className="flex flex-col min-[1800px]:flex-row min-[1800px]:items-start gap-4">
        {/* ---------------------------------------------------------------- Accounts */}
        <section className={`${CARD} flex-1 min-w-0 overflow-hidden flex flex-col`}>
          <div className="h-14 flex-shrink-0 px-4 min-[1800px]:px-5 border-b border-zinc-100 flex items-center gap-3">
            <h2 className="text-[15px] leading-5 font-semibold text-zinc-950">Accounts</h2>
            {!loading && <span className="text-[13px] leading-5 text-zinc-500 tabular-nums">{countsLabel}</span>}
          </div>

          {loading ? (
            <p className="px-4 min-[1800px]:px-5 py-6 text-[13px] leading-5 text-zinc-500">Loading staff…</p>
          ) : users.length === 0 ? (
            <p className="px-4 min-[1800px]:px-5 py-6 text-[13px] leading-5 text-zinc-500">
              No staff accounts to show.
            </p>
          ) : (
            <>
              {/* ------------------------------------------------ table, lg and wider */}
              <div role="table" aria-label="Staff accounts" className="hidden lg:block">
                <div role="rowgroup">
                  <div
                    role="row"
                    className={`${TABLE_GRID} h-11 px-4 min-[1800px]:px-5 items-center bg-zinc-50 border-b border-zinc-200 ${LABEL}`}
                  >
                    <span role="columnheader">
                      <span className="min-[1800px]:hidden">Staff · last sign-in</span>
                      <span className="hidden min-[1800px]:inline">Staff member</span>
                    </span>
                    <span role="columnheader">Role</span>
                    <span role="columnheader">Status</span>
                    <span role="columnheader" className="hidden min-[1800px]:block">
                      Last sign-in
                    </span>
                    <span role="columnheader">Actions</span>
                  </div>
                </div>

                <div role="rowgroup">
                  {users.map((u) => {
                    const isSelf = u.id === currentUser.id;
                    const signIn = formatSignIn(u.last_login_at);
                    return (
                      <div
                        key={u.id}
                        role="row"
                        className={`${TABLE_GRID} h-[68px] px-4 min-[1800px]:px-5 items-center border-b border-zinc-100 last:border-b-0`}
                      >
                        <div role="cell" className="flex items-center gap-3 min-w-0">
                          <div
                            aria-hidden="true"
                            className={`w-9 h-9 flex-shrink-0 rounded-full flex items-center justify-center text-[13px] font-bold ${
                              u.is_active
                                ? 'bg-zinc-100 text-zinc-700'
                                : 'bg-white border border-dashed border-zinc-300 text-zinc-500'
                            }`}
                          >
                            {initialOf(u.display_name)}
                          </div>
                          <div className="min-w-0 flex flex-col gap-0.5">
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                className={`text-sm leading-5 font-semibold truncate ${
                                  u.is_active ? 'text-zinc-950' : 'text-zinc-700'
                                }`}
                              >
                                {u.display_name}
                              </span>
                              {isSelf && (
                                <span className={`${PILL} h-5 px-[7px] bg-emerald-50 text-emerald-700 flex-shrink-0`}>
                                  You
                                </span>
                              )}
                            </div>
                            <span className="text-xs leading-4 text-zinc-500 truncate">
                              {u.username}
                              <span className="min-[1800px]:hidden">
                                {' · '}
                                <span className="tabular-nums">{signIn}</span>
                              </span>
                            </span>
                          </div>
                        </div>

                        <div role="cell" className="flex min-w-0">
                          <span className={`${PILL} bg-zinc-100 text-zinc-700`}>{ROLE_LABELS[u.role]}</span>
                        </div>

                        <div role="cell" className="flex min-w-0">
                          <span
                            className={`${PILL} ${
                              u.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-zinc-100 text-zinc-700'
                            }`}
                          >
                            {u.is_active ? 'Active' : 'Deactivated'}
                          </span>
                        </div>

                        <span
                          role="cell"
                          className="hidden min-[1800px]:block text-[13px] leading-5 text-zinc-700 tabular-nums"
                        >
                          {signIn}
                        </span>

                        <div role="cell" className={ROW_ACTIONS_GRID}>
                          <button
                            type="button"
                            onClick={() => setResetFor({ id: u.id, password: '' })}
                            className={SECONDARY_BTN}
                          >
                            <KeyRound className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                            <span className="truncate">Reset password</span>
                          </button>

                          {isSelf ? (
                            <>
                              {/* aria-disabled, not disabled: the control stays focusable
                                  so the reason beside it is actually announced. */}
                              <button
                                type="button"
                                aria-disabled="true"
                                aria-describedby={`own-access-${u.id}`}
                                className={LOCKED_BTN}
                              >
                                <Lock className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                                <span className="truncate">Change role</span>
                              </button>
                              <span id={`own-access-${u.id}`} className="text-xs leading-4 text-zinc-500">
                                You can’t change your own role or access
                              </span>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => setRoleFor({ user: u, role: u.role })}
                                className={SECONDARY_BTN}
                              >
                                <UserCog className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                                <span className="truncate">Change role</span>
                              </button>
                              {u.is_active ? (
                                <button type="button" onClick={() => setDeactivateFor(u)} className={DANGER_BTN}>
                                  <UserX className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                                  <span className="truncate">Deactivate</span>
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => reactivate(u)}
                                  className={RESTORE_BTN}
                                >
                                  <UserCheck className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                                  <span className="truncate">Reactivate</span>
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* ------------------------------------------- cards, below lg
                  The six-column table pushed Reset and Deactivate past the right
                  edge of a 390px screen; one card per person keeps them reachable. */}
              <div className="lg:hidden flex flex-col">
                {users.map((u) => {
                  const isSelf = u.id === currentUser.id;
                  const expanded = expandedId === u.id;
                  return (
                    <div key={u.id} className="border-b border-zinc-100 last:border-b-0">
                      <button
                        type="button"
                        onClick={() => setExpandedId(expanded ? null : u.id)}
                        aria-expanded={expanded}
                        aria-controls={`staff-actions-${u.id}`}
                        className="w-full min-h-[64px] py-2 pl-4 pr-1 flex items-center gap-3 text-left active:bg-zinc-50"
                      >
                        <div
                          aria-hidden="true"
                          className={`w-10 h-10 flex-shrink-0 rounded-full flex items-center justify-center text-sm font-bold ${
                            u.is_active
                              ? 'bg-zinc-100 text-zinc-700'
                              : 'bg-white border border-dashed border-zinc-300 text-zinc-500'
                          }`}
                        >
                          {initialOf(u.display_name)}
                        </div>
                        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className={`text-[15px] leading-5 font-semibold truncate ${
                                u.is_active ? 'text-zinc-950' : 'text-zinc-700'
                              }`}
                            >
                              {u.display_name}
                            </span>
                            {isSelf && (
                              <span className={`${PILL} h-5 px-[7px] bg-emerald-50 text-emerald-700 flex-shrink-0`}>
                                You
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className={`${PILL} bg-zinc-100 text-zinc-700`}>{ROLE_LABELS[u.role]}</span>
                            <span className="text-xs leading-4 text-zinc-500 tabular-nums truncate">
                              {formatSignIn(u.last_login_at)}
                            </span>
                          </div>
                        </div>
                        {!u.is_active && (
                          <span className={`${PILL} bg-zinc-100 text-zinc-700 flex-shrink-0`}>Deactivated</span>
                        )}
                        <span className="w-11 h-11 flex-shrink-0 flex items-center justify-center text-zinc-700">
                          {expanded ? (
                            <ChevronUp className="w-5 h-5" aria-hidden="true" />
                          ) : (
                            <ChevronDown className="w-5 h-5" aria-hidden="true" />
                          )}
                        </span>
                      </button>

                      {expanded && (
                        <div id={`staff-actions-${u.id}`} className="px-4 pb-4 flex flex-col gap-2">
                          <div className="grid grid-cols-2 gap-2">
                            <button
                              type="button"
                              onClick={() => setResetFor({ id: u.id, password: '' })}
                              className={`${SECONDARY_BTN} h-11`}
                            >
                              <KeyRound className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                              <span className="truncate">Reset password</span>
                            </button>
                            {isSelf ? (
                              <button
                                type="button"
                                aria-disabled="true"
                                aria-describedby={`own-access-phone-${u.id}`}
                                className={`${LOCKED_BTN} h-11`}
                              >
                                <Lock className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                                <span className="truncate">Change role</span>
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setRoleFor({ user: u, role: u.role })}
                                className={`${SECONDARY_BTN} h-11`}
                              >
                                <UserCog className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                                <span className="truncate">Change role</span>
                              </button>
                            )}
                          </div>
                          {isSelf ? (
                            <p id={`own-access-phone-${u.id}`} className="text-xs leading-4 text-zinc-500">
                              You can’t change your own role or deactivate your own account.
                            </p>
                          ) : u.is_active ? (
                            <button
                              type="button"
                              onClick={() => setDeactivateFor(u)}
                              className={`${DANGER_BTN} h-11 w-full`}
                            >
                              <UserX className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                              <span>Deactivate</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => reactivate(u)}
                              className={`${RESTORE_BTN} h-11 w-full`}
                            >
                              <UserCheck className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                              <span>Reactivate</span>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>

        {/* ------------------------------------------------------------ Role access
            Built from TABS_FOR_ROLE rather than prose, which is what let the old
            copy promise cashiers a sales report they could not open. */}
        <section className={`${CARD} min-[1800px]:w-[440px] min-[1800px]:flex-shrink-0 overflow-hidden`}>
          <div className="px-4 min-[1800px]:px-5 py-3.5 min-[1800px]:py-4 border-b border-zinc-100 flex flex-col gap-1 lg:flex-row lg:items-center lg:justify-between lg:gap-4 min-[1800px]:flex-col min-[1800px]:items-start min-[1800px]:gap-1">
            <h2 className="text-[15px] leading-5 font-semibold text-zinc-950">What each role can open</h2>
            <p className="text-[13px] leading-5 text-zinc-500">The server checks the same rules on every request.</p>
          </div>

          {/* Phones: the grid does not fit, so each role names its screens. */}
          <div className="p-4 flex flex-col gap-2.5 lg:hidden">
            {ROLE_ORDER.map((role) => (
              <div key={role} className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
                <span className="text-sm leading-5 font-semibold text-zinc-950">{ROLE_LABELS[role]}</span>
                <span className="text-[13px] leading-5 text-zinc-700">{screensFor(role)}</span>
              </div>
            ))}
          </div>

          {/* Tablet and laptop: one row per role, one column per screen. */}
          <div className="hidden lg:block min-[1800px]:hidden overflow-x-auto no-scrollbar">
            <div role="table" aria-label="What each role can open" className="min-w-[620px]">
              <div role="rowgroup">
                <div
                  role="row"
                  className="h-14 px-4 grid grid-cols-[120px_repeat(7,minmax(0,1fr))] items-center bg-zinc-50 border-b border-zinc-200"
                >
                  <span role="columnheader" className={LABEL}>
                    Role
                  </span>
                  {SCREEN_ORDER.map((tab) => {
                    const { short, Icon } = SCREEN_META[tab];
                    return (
                      <div key={tab} role="columnheader" className="px-1 flex flex-col items-center gap-1 text-zinc-600">
                        <Icon className="w-4 h-4" aria-hidden="true" />
                        <span className="text-xs leading-4 font-medium text-zinc-700 text-center">{short}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div role="rowgroup">
                {ROLE_ORDER.map((role) => (
                  <div
                    key={role}
                    role="row"
                    className="h-11 px-4 grid grid-cols-[120px_repeat(7,minmax(0,1fr))] items-center border-b border-zinc-100 last:border-b-0"
                  >
                    <span role="rowheader" className="text-sm leading-5 font-semibold text-zinc-950">
                      {ROLE_LABELS[role]}
                    </span>
                    {SCREEN_ORDER.map((tab) => (
                      <AccessMark key={tab} allowed={TABS_FOR_ROLE[role].includes(tab)} />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Wide desktop: the panel sits beside the table, so screens run down it. */}
          <div role="table" aria-label="What each role can open" className="hidden min-[1800px]:block">
            <div role="rowgroup">
              <div
                role="row"
                className={`h-11 px-5 grid grid-cols-[minmax(0,1fr)_72px_72px_72px] gap-2 items-center bg-zinc-50 border-b border-zinc-200 ${LABEL}`}
              >
                <span role="columnheader">Screen</span>
                {ROLE_ORDER.map((role) => (
                  <span key={role} role="columnheader" className="text-center">
                    {ROLE_LABELS[role]}
                  </span>
                ))}
              </div>
            </div>
            <div role="rowgroup">
              {SCREEN_ORDER.map((tab) => {
                const { label, Icon } = SCREEN_META[tab];
                return (
                  <div
                    key={tab}
                    role="row"
                    className="h-11 px-5 grid grid-cols-[minmax(0,1fr)_72px_72px_72px] gap-2 items-center border-b border-zinc-100 last:border-b-0"
                  >
                    <div role="rowheader" className="flex items-center gap-2.5 min-w-0 text-zinc-600">
                      <Icon className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                      <span className="text-[13px] leading-5 font-medium text-zinc-800 truncate">{label}</span>
                    </div>
                    {ROLE_ORDER.map((role) => (
                      <AccessMark key={role} allowed={TABS_FOR_ROLE[role].includes(tab)} />
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </div>

      {/* ------------------------------------------------------------ Add staff member */}
      {addOpen && (
        <div className={SHEET_BACKDROP} role="dialog" aria-modal="true" aria-label="Add staff member">
          <div className={SHEET_PANEL}>
            <form onSubmit={create} className="flex flex-col min-h-0">
              <div className="px-5 py-4 border-b border-zinc-100 flex items-start justify-between gap-3">
                <div className="min-w-0 flex flex-col gap-0.5">
                  <h2 className="text-base leading-6 font-bold text-zinc-950">Add staff member</h2>
                  <p className="text-[13px] leading-5 text-zinc-500">They can sign in as soon as you create it.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setAddOpen(false)}
                  disabled={creating}
                  className={ICON_BTN}
                  aria-label="Close without adding anyone"
                >
                  <X className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>

              <div className="p-5 flex flex-col gap-3 overflow-y-auto">
                {dialogError}
                <label className="flex flex-col gap-1.5">
                  <span className={FIELD_LABEL}>Full name</span>
                  <input
                    className={FIELD}
                    value={form.display_name}
                    onChange={(e) => setForm({ ...form, display_name: e.target.value })}
                    autoComplete="off"
                    required
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={FIELD_LABEL}>Username</span>
                  <input
                    className={FIELD}
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })}
                    autoCapitalize="none"
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={FIELD_LABEL}>Password</span>
                  <input
                    className={FIELD}
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    minLength={8}
                    autoComplete="new-password"
                    required
                  />
                  <span className="text-xs leading-4 text-zinc-500">8 characters or more.</span>
                </label>

                <fieldset className="flex flex-col gap-1.5">
                  <legend className={FIELD_LABEL}>Role</legend>
                  <div className="grid grid-cols-3 gap-2">
                    {ROLE_ORDER.map((role) => (
                      <label
                        key={role}
                        className={`h-11 rounded-xl border text-[13px] font-semibold flex items-center justify-center cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-zinc-900 focus-within:ring-offset-2 ${
                          form.role === role
                            ? 'bg-zinc-900 border-zinc-900 text-white'
                            : 'bg-white border-zinc-200 text-zinc-700 hover:bg-zinc-50'
                        }`}
                      >
                        <input
                          type="radio"
                          name="new-staff-role"
                          className="sr-only"
                          value={role}
                          checked={form.role === role}
                          onChange={() => setForm({ ...form, role })}
                        />
                        {ROLE_LABELS[role]}
                      </label>
                    ))}
                  </div>
                </fieldset>

                <div className="p-3 rounded-xl bg-zinc-50 border border-zinc-100 flex flex-col gap-1">
                  <p className="text-[13px] leading-5 text-zinc-700">{ROLE_HELP[form.role]}</p>
                  <p className="text-xs leading-4 text-zinc-500">Can open: {screensFor(form.role)}</p>
                </div>
              </div>

              {/* On a phone the sheet sits on the home indicator, so the footer clears it. */}
              <div className="px-5 py-4 pb-[calc(1rem_+_env(safe-area-inset-bottom,0px))] sm:pb-4 border-t border-zinc-100 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setAddOpen(false)}
                  disabled={creating}
                  className={`${SECONDARY_BTN} h-11 px-4`}
                >
                  Cancel
                </button>
                <button type="submit" disabled={creating} className={`${PRIMARY_BTN} h-11 px-4`}>
                  {creating ? 'Creating…' : 'Create account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --------------------------------------------------------------- Reset password */}
      {resetFor && resetUser && (
        <div
          className={SHEET_BACKDROP}
          role="dialog"
          aria-modal="true"
          aria-label={`Reset password for ${resetUser.display_name}`}
        >
          <div className={SHEET_PANEL}>
            <form onSubmit={(e) => submitReset(e, resetUser)} className="flex flex-col min-h-0">
              <div className="px-5 py-4 border-b border-zinc-100 flex items-start justify-between gap-3">
                <div className="min-w-0 flex flex-col gap-0.5">
                  <h2 className="text-base leading-6 font-bold text-zinc-950">Reset password</h2>
                  <p className="text-[13px] leading-5 text-zinc-500 truncate">
                    {resetUser.display_name} · {resetUser.username}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setResetFor(null)}
                  disabled={busy}
                  className={ICON_BTN}
                  aria-label="Close without resetting the password"
                >
                  <X className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>

              <div className="p-5 flex flex-col gap-3 overflow-y-auto">
                {dialogError}
                <label className="flex flex-col gap-1.5">
                  <span className={FIELD_LABEL}>New password</span>
                  <input
                    className={FIELD}
                    type="password"
                    minLength={8}
                    value={resetFor.password}
                    onChange={(e) => setResetFor({ id: resetFor.id, password: e.target.value })}
                    autoComplete="new-password"
                    autoFocus
                    required
                  />
                  <span className="text-xs leading-4 text-zinc-500">8 characters or more.</span>
                </label>
                <p className="text-[13px] leading-5 text-zinc-500">
                  Saving signs {resetUser.display_name} out of every other device. Tell them the new password in
                  person.
                </p>
              </div>

              {/* On a phone the sheet sits on the home indicator, so the footer clears it. */}
              <div className="px-5 py-4 pb-[calc(1rem_+_env(safe-area-inset-bottom,0px))] sm:pb-4 border-t border-zinc-100 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setResetFor(null)}
                  disabled={busy}
                  className={`${SECONDARY_BTN} h-11 px-4`}
                >
                  Cancel
                </button>
                <button type="submit" disabled={busy} className={`${PRIMARY_BTN} h-11 px-4`}>
                  {busy ? 'Saving…' : 'Reset password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ Change role */}
      {roleFor && (
        <div
          className={SHEET_BACKDROP}
          role="dialog"
          aria-modal="true"
          aria-label={`Change role for ${roleFor.user.display_name}`}
        >
          <div className={SHEET_PANEL}>
            <div className="px-5 py-4 border-b border-zinc-100 flex items-start justify-between gap-3">
              <div className="min-w-0 flex flex-col gap-0.5">
                <h2 className="text-base leading-6 font-bold text-zinc-950">Change role</h2>
                <p className="text-[13px] leading-5 text-zinc-500 truncate">
                  {roleFor.user.display_name} · {roleFor.user.username}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRoleFor(null)}
                disabled={busy}
                className={ICON_BTN}
                aria-label="Close without changing the role"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            <div className="p-5 flex flex-col gap-3 overflow-y-auto">
              {dialogError}
              <div role="radiogroup" aria-label="Role" className="flex flex-col gap-2">
                {ROLE_ORDER.map((role) => {
                  const picked = roleFor.role === role;
                  return (
                    <label
                      key={role}
                      className={`p-3 rounded-xl border cursor-pointer flex flex-col gap-1 transition-colors focus-within:ring-2 focus-within:ring-zinc-900 focus-within:ring-offset-2 ${
                        picked ? 'border-zinc-900 bg-zinc-50' : 'border-zinc-200 bg-white hover:bg-zinc-50'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="staff-role"
                          className="sr-only"
                          value={role}
                          checked={picked}
                          onChange={() => setRoleFor({ user: roleFor.user, role })}
                        />
                        <span
                          aria-hidden="true"
                          className={`w-4 h-4 flex-shrink-0 rounded-full border-2 flex items-center justify-center ${
                            picked ? 'border-zinc-900' : 'border-zinc-300'
                          }`}
                        >
                          {picked && <span className="w-2 h-2 rounded-full bg-zinc-900" />}
                        </span>
                        <span className="text-sm leading-5 font-semibold text-zinc-950">{ROLE_LABELS[role]}</span>
                        {roleFor.user.role === role && (
                          <span className={`${PILL} bg-zinc-100 text-zinc-700`}>Current</span>
                        )}
                      </span>
                      <span className="text-[13px] leading-5 text-zinc-500">{ROLE_HELP[role]}</span>
                      <span className="text-xs leading-4 text-zinc-500">Can open: {screensFor(role)}</span>
                    </label>
                  );
                })}
              </div>
              {roleFor.role !== roleFor.user.role && (
                <p className="text-[13px] leading-5 text-zinc-500">
                  {roleFor.user.display_name} takes the new access the next time they load a screen.
                </p>
              )}
            </div>

            <div className="px-5 py-4 pb-[calc(1rem_+_env(safe-area-inset-bottom,0px))] sm:pb-4 border-t border-zinc-100 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setRoleFor(null)}
                disabled={busy}
                className={`${SECONDARY_BTN} h-11 px-4`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveRole}
                disabled={busy || roleFor.role === roleFor.user.role}
                className={`${PRIMARY_BTN} h-11 px-4`}
              >
                {busy ? 'Saving…' : `Make ${ROLE_LABELS[roleFor.role]}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------- Deactivate */}
      {deactivateFor && (
        <div className={SHEET_BACKDROP} role="dialog" aria-modal="true" aria-label="Confirm deactivation">
          <div className={`${SHEET_PANEL} sm:max-w-sm`}>
            <div className="p-5 pb-[calc(1.25rem_+_env(safe-area-inset-bottom,0px))] sm:pb-5 flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className="w-10 h-10 flex-shrink-0 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center"
                >
                  <UserX className="w-5 h-5" />
                </span>
                <div className="min-w-0 flex flex-col gap-1">
                  <h2 className="text-base leading-6 font-bold text-zinc-950">
                    Deactivate {deactivateFor.display_name}?
                  </h2>
                  <p className="text-[13px] leading-5 text-zinc-500">
                    They are signed out at once and cannot sign in again until you reactivate them. Their sales and
                    stock movements stay on record.
                  </p>
                </div>
              </div>
              {dialogError}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDeactivateFor(null)}
                  disabled={busy}
                  className={`${SECONDARY_BTN} h-11 px-4`}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmDeactivate}
                  disabled={busy}
                  className="h-11 px-4 inline-flex items-center justify-center gap-2 rounded-xl bg-rose-600 hover:bg-rose-700 disabled:opacity-60 text-white text-[13px] font-semibold transition-colors"
                >
                  {busy ? 'Deactivating…' : 'Deactivate'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
