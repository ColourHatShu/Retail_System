import React, { useState } from 'react';
import { Store, LogIn, UserPlus, Lock, User as UserIcon, AlertTriangle } from 'lucide-react';
import { api, ApiError, SessionResult } from '../utils/api';

interface LoginPageProps {
  /** 'setup' on a fresh install (no users yet), otherwise 'login'. */
  mode: 'setup' | 'login';
  onSuccess: (session: SessionResult) => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({ mode, onSuccess }) => {
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
        ? await api.setupOwner({ username, password, display_name: displayName })
        : await api.login({ username, password });
      onSuccess(session);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  const field =
    'w-full pl-9 pr-3 py-2.5 text-sm bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:bg-white placeholder:text-zinc-400';

  return (
    <div className="min-h-screen bg-zinc-50 flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-white rounded-2xl border border-zinc-200 shadow-sm p-6 space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-zinc-950 text-emerald-400 flex items-center justify-center">
            <Store className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-sm font-extrabold tracking-tight text-zinc-900 uppercase">Nexus POS</h1>
            <p className="text-xs text-zinc-500">
              {isSetup ? 'Create the owner account to get started' : 'Sign in to the register'}
            </p>
          </div>
        </div>

        {isSetup && (
          <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900">
            This store has no accounts yet. The first account is the <strong>Owner</strong>, who can add managers
            and cashiers afterwards.
          </div>
        )}

        {isSetup && (
          <label className="block space-y-1">
            <span className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">Your name</span>
            <div className="relative">
              <UserIcon className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                className={field}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Store Owner"
                autoComplete="name"
                required
              />
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
              placeholder="owner"
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
          {busy ? 'Please wait…' : isSetup ? 'Create owner account' : 'Sign in'}
        </button>
      </form>
    </div>
  );
};
