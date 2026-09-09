import React, { useCallback, useEffect, useState } from 'react';
import { UserPlus, KeyRound, ShieldCheck, UserX, UserCheck, RefreshCw } from 'lucide-react';
import { Role, User } from '../types';
import { api, ApiError } from '../utils/api';

interface UsersPageProps {
  currentUser: User;
}

const ROLE_LABELS: Record<Role, string> = { OWNER: 'Owner', MANAGER: 'Manager', CASHIER: 'Cashier' };
const ROLE_HELP: Record<Role, string> = {
  OWNER: 'Everything, including staff, tax and currency settings',
  MANAGER: 'Products, stock adjustments, imports and the audit ledger',
  CASHIER: 'Sell at the register and view sales',
};

export const UsersPage: React.FC<UsersPageProps> = ({ currentUser }) => {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [form, setForm] = useState({ username: '', display_name: '', password: '', role: 'CASHIER' as Role });
  const [creating, setCreating] = useState(false);
  const [resetFor, setResetFor] = useState<{ id: number; password: string } | null>(null);

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

  const flash = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice(null), 3500);
  };

  const run = async (action: () => Promise<unknown>, done: string) => {
    try {
      setError(null);
      await action();
      await load();
      flash(done);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed');
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    await run(async () => {
      await api.createUser(form);
      setForm({ username: '', display_name: '', password: '', role: 'CASHIER' });
    }, `Account "${form.username}" created`);
    setCreating(false);
  };

  const input =
    'w-full px-3 py-2 text-sm bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:bg-white';

  return (
    <div className="w-full max-w-5xl px-3 sm:px-6 py-4 sm:py-6 space-y-5">
      <div>
        <h1 className="text-lg font-extrabold text-zinc-900">Staff &amp; Access</h1>
        <p className="text-xs text-zinc-500">
          Every sale records its cashier and every stock change records who made it. Deactivated staff are signed
          out immediately and keep their history.
        </p>
      </div>

      {error && <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800">{error}</div>}
      {notice && <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">{notice}</div>}

      <form onSubmit={create} className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-bold text-zinc-900">
          <UserPlus className="w-4 h-4 text-emerald-600" /> Add staff member
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
          <input
            className={input}
            placeholder="Full name"
            value={form.display_name}
            onChange={(e) => setForm({ ...form, display_name: e.target.value })}
            required
          />
          <input
            className={input}
            placeholder="username"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })}
            autoCapitalize="none"
            spellCheck={false}
            required
          />
          <input
            className={input}
            type="password"
            placeholder="Password (8+ chars)"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            minLength={8}
            autoComplete="new-password"
            required
          />
          <select className={input} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-zinc-500">{ROLE_HELP[form.role]}</p>
          <button
            type="submit"
            disabled={creating}
            className="px-4 py-2 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-60 text-white text-xs font-bold rounded-xl"
          >
            {creating ? 'Creating…' : 'Create account'}
          </button>
        </div>
      </form>

      <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100">
          <span className="text-sm font-bold text-zinc-900">Accounts ({users.length})</span>
          <button onClick={load} className="p-1.5 text-zinc-400 hover:text-zinc-900 rounded-lg" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {loading ? (
          <div className="p-6 text-xs text-zinc-400">Loading…</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-zinc-50 text-[10px] uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="text-left px-4 py-2">Name</th>
                  <th className="text-left px-4 py-2">Username</th>
                  <th className="text-left px-4 py-2">Role</th>
                  <th className="text-left px-4 py-2">Status</th>
                  <th className="text-left px-4 py-2">Last sign-in</th>
                  <th className="text-right px-4 py-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {users.map((u) => {
                  const isSelf = u.id === currentUser.id;
                  return (
                    <React.Fragment key={u.id}>
                      <tr className={u.is_active ? '' : 'opacity-60'}>
                        <td className="px-4 py-2.5 font-semibold text-zinc-900">
                          {u.display_name} {isSelf && <span className="text-[10px] text-zinc-400">(you)</span>}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-zinc-600">{u.username}</td>
                        <td className="px-4 py-2.5">
                          <select
                            className="px-2 py-1 bg-zinc-50 border border-zinc-200 rounded-lg text-xs disabled:opacity-60"
                            value={u.role}
                            disabled={isSelf}
                            onChange={(e) =>
                              run(
                                () => api.updateUser(u.id, { role: e.target.value as Role }),
                                `${u.display_name} is now ${ROLE_LABELS[e.target.value as Role]}`,
                              )
                            }
                          >
                            {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                              <option key={r} value={r}>
                                {ROLE_LABELS[r]}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-4 py-2.5">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-bold text-[10px] ${
                              u.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-zinc-100 text-zinc-500'
                            }`}
                          >
                            <ShieldCheck className="w-3 h-3" /> {u.is_active ? 'Active' : 'Deactivated'}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-zinc-500">
                          {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : 'Never'}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              onClick={() => setResetFor(resetFor?.id === u.id ? null : { id: u.id, password: '' })}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-zinc-200 hover:bg-zinc-50 text-zinc-700"
                              title="Reset password"
                            >
                              <KeyRound className="w-3 h-3" /> Reset
                            </button>
                            {!isSelf && (
                              <button
                                onClick={() =>
                                  run(
                                    () => api.updateUser(u.id, { is_active: !u.is_active }),
                                    u.is_active
                                      ? `${u.display_name} deactivated and signed out`
                                      : `${u.display_name} reactivated`,
                                  )
                                }
                                className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg border ${
                                  u.is_active
                                    ? 'border-rose-200 text-rose-700 hover:bg-rose-50'
                                    : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'
                                }`}
                              >
                                {u.is_active ? <UserX className="w-3 h-3" /> : <UserCheck className="w-3 h-3" />}
                                {u.is_active ? 'Deactivate' : 'Reactivate'}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {resetFor?.id === u.id && (
                        <tr className="bg-zinc-50">
                          <td colSpan={6} className="px-4 py-2.5">
                            <form
                              className="flex flex-col sm:flex-row gap-2 sm:items-center"
                              onSubmit={async (e) => {
                                e.preventDefault();
                                await run(
                                  () => api.updateUser(u.id, { password: resetFor.password }),
                                  `Password reset for ${u.display_name}; their other devices are signed out`,
                                );
                                setResetFor(null);
                              }}
                            >
                              <span className="text-[11px] text-zinc-600">New password for {u.display_name}:</span>
                              <input
                                className="px-3 py-1.5 text-xs bg-white border border-zinc-200 rounded-lg"
                                type="password"
                                minLength={8}
                                value={resetFor.password}
                                onChange={(e) => setResetFor({ id: u.id, password: e.target.value })}
                                autoComplete="new-password"
                                required
                              />
                              <button type="submit" className="px-3 py-1.5 bg-zinc-900 text-white text-xs font-bold rounded-lg">
                                Save
                              </button>
                              <button type="button" onClick={() => setResetFor(null)} className="px-3 py-1.5 text-xs text-zinc-500">
                                Cancel
                              </button>
                            </form>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
