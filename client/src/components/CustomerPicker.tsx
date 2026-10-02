import React, { useEffect, useRef, useState } from 'react';
import { Star, UserPlus, UserRound, X } from 'lucide-react';
import { api } from '../utils/api';
import type { Customer } from '../utils/api';

export interface PickedCustomer {
  id?: number;
  name: string;
  points?: number;
}

/**
 * Find a customer by name or phone, add one on the spot, or just type a name
 * for a walk-in. A picked customer earns loyalty points on the sale.
 */
export const CustomerPicker: React.FC<{
  value: PickedCustomer;
  onChange: (c: PickedCustomer) => void;
  onDone: () => void;
}> = ({ value, onChange, onDone }) => {
  const [q, setQ] = useState(value.id ? '' : value.name);
  const [results, setResults] = useState<Customer[]>([]);
  const [adding, setAdding] = useState(false);
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(timer.current);
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    timer.current = window.setTimeout(() => {
      api
        .searchCustomers(term, 6)
        .then(setResults)
        .catch(() => setResults([]));
    }, 250);
    return () => window.clearTimeout(timer.current);
  }, [q]);

  const pick = (c: Customer) => {
    onChange({ id: c.id, name: c.name, points: c.points });
    onDone();
  };

  const add = async () => {
    setError(null);
    try {
      const c = await api.createCustomer({ name: q.trim(), phone: phone.trim() || null });
      pick(c);
    } catch (err) {
      setError((err as Error).message || 'Could not add the customer');
    }
  };

  const input = 'h-9 px-2.5 bg-white border border-zinc-200 rounded-lg text-[13px] text-zinc-900 outline-none focus:border-zinc-900 placeholder:text-zinc-500';

  return (
    <div className="relative flex-1 min-w-0 flex items-center gap-2">
      <UserRound className="w-4 h-4 text-zinc-500 flex-shrink-0" />
      {value.id ? (
        <span className="flex-1 min-w-0 flex items-center gap-2 text-[13px]">
          <span className="font-semibold text-zinc-800 truncate">{value.name}</span>
          <span className="inline-flex items-center gap-0.5 text-amber-700">
            <Star className="w-3.5 h-3.5" /> {value.points ?? 0}
          </span>
          <button type="button" onClick={() => onChange({ name: '' })} aria-label="Remove customer" className="w-8 h-8 grid place-items-center rounded-lg hover:bg-zinc-200/70">
            <X className="w-4 h-4" />
          </button>
        </span>
      ) : (
        <input
          type="text"
          value={q}
          autoFocus
          onChange={(e) => {
            setQ(e.target.value);
            onChange({ name: e.target.value });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' || (e.key === 'Enter' && results.length === 0 && !adding)) onDone();
          }}
          placeholder="Customer name or phone"
          aria-label="Customer name or phone"
          className={`flex-1 min-w-0 ${input}`}
        />
      )}
      <button type="button" onClick={onDone} className="h-9 px-2.5 rounded-lg text-[13px] font-semibold text-zinc-700 hover:bg-zinc-200/70">
        Done
      </button>

      {!value.id && q.trim().length >= 2 && (
        <div className="absolute bottom-11 left-0 right-0 z-40 rounded-xl border border-zinc-200 bg-white shadow-lg p-1.5 flex flex-col gap-0.5">
          {results.map((c) => (
            <button key={c.id} type="button" onClick={() => pick(c)} className="text-left rounded-lg px-2 py-1.5 hover:bg-zinc-50">
              <div className="text-[13px] font-semibold text-zinc-900">{c.name}</div>
              <div className="text-xs text-zinc-500">
                {c.phone ?? 'no phone'} · {c.points} pts · {c.visits} visits
              </div>
            </button>
          ))}
          {adding ? (
            <div className="flex flex-col gap-1.5 p-1">
              <input className={input} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone (optional)" inputMode="tel" autoFocus />
              {error && <span className="text-xs text-rose-600">{error}</span>}
              <button type="button" onClick={() => void add()} className="h-9 rounded-lg bg-zinc-900 text-white text-[13px] font-semibold">
                Save “{q.trim()}”
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-semibold text-zinc-700 hover:bg-zinc-50">
              <UserPlus className="w-4 h-4" /> Add “{q.trim()}” as a customer
            </button>
          )}
        </div>
      )}
    </div>
  );
};
