import React, { useEffect, useState } from 'react';
import { CircleAlert, Search, Star, UserPlus } from 'lucide-react';
import { User } from '../types';
import { api } from '../utils/api';
import type { Customer } from '../utils/api';

const FIELD =
  'w-full h-11 px-3 text-sm bg-white border border-zinc-200 rounded-xl text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900';
const BTN = 'h-11 px-4 inline-flex items-center justify-center gap-2 rounded-xl text-[13px] font-semibold disabled:opacity-60';
const money = (n: number) => `$${n.toFixed(2)}`;

export const CustomersPage: React.FC<{ currentUser: User }> = ({ currentUser }) => {
  const canEdit = currentUser.role !== 'CASHIER';
  const [q, setQ] = useState('');
  const [list, setList] = useState<Customer[]>([]);
  const [selected, setSelected] = useState<Customer | null>(null);
  const [form, setForm] = useState({ name: '', phone: '', email: '', notes: '', points: '' });
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => {
      api
        .searchCustomers(q.trim(), 50)
        .then(setList)
        .catch((err) => setError(err.message));
    }, 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const open = async (id: number) => {
    setError(null);
    setAdding(false);
    try {
      const c = await api.getCustomer(id);
      setSelected(c);
      setForm({ name: c.name, phone: c.phone ?? '', email: c.email ?? '', notes: c.notes ?? '', points: String(c.points) });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name: form.name.trim(), phone: form.phone.trim() || null, email: form.email.trim() || null, notes: form.notes.trim() || null };
      const saved = adding
        ? await api.createCustomer(body)
        : await api.updateCustomer(selected!.id, { ...body, points: Number(form.points) || 0 });
      setAdding(false);
      setSelected(saved);
      setList(await api.searchCustomers(q.trim(), 50));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const editing = adding || (selected && canEdit);

  return (
    <div className="w-full px-4 sm:px-6 py-4 sm:py-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl lg:text-[22px] font-bold tracking-[-0.01em] text-zinc-950">Customers</h1>
          <p className="text-[13px] text-zinc-500">Regulars, their visits and loyalty points (1 point per dollar spent by default).</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setAdding(true);
            setSelected(null);
            setForm({ name: '', phone: '', email: '', notes: '', points: '' });
          }}
          className={`${BTN} bg-zinc-900 text-white`}
        >
          <UserPlus className="w-4 h-4" /> Add customer
        </button>
      </div>

      {error && (
        <div role="alert" className="flex gap-2 p-3 rounded-xl bg-rose-50 border border-rose-200 text-[13px] text-rose-700">
          <CircleAlert className="w-4 h-4 mt-px" />
          {error}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section className="rounded-2xl border border-zinc-200/80 bg-white shadow-xs p-4 flex flex-col gap-3 min-w-0">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-3.5 text-zinc-400" />
            <input className={`${FIELD} pl-9`} placeholder="Search by name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px] tabular-nums">
              <thead>
                <tr className="text-left text-xs text-zinc-500">
                  <th className="py-1 pr-3 font-medium">Name</th>
                  <th className="py-1 pr-3 font-medium">Phone</th>
                  <th className="py-1 pr-3 font-medium text-right">Visits</th>
                  <th className="py-1 pr-3 font-medium text-right">Spent</th>
                  <th className="py-1 font-medium text-right">Points</th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id} onClick={() => void open(c.id)} className={`border-t border-zinc-100 cursor-pointer hover:bg-zinc-50 ${selected?.id === c.id ? 'bg-zinc-50' : ''}`}>
                    <td className="py-2 pr-3 font-semibold text-zinc-900">{c.name}</td>
                    <td className="py-2 pr-3">{c.phone ?? '—'}</td>
                    <td className="py-2 pr-3 text-right">{c.visits}</td>
                    <td className="py-2 pr-3 text-right">{money(c.total_spent)}</td>
                    <td className="py-2 text-right text-amber-700">{c.points}</td>
                  </tr>
                ))}
                {list.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-zinc-500">
                      No customers yet. Add one here or from the register.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {(selected || adding) && (
          <section className="rounded-2xl border border-zinc-200/80 bg-white shadow-xs p-5 flex flex-col gap-3">
            <h2 className="text-[15px] font-semibold text-zinc-950 flex items-center gap-2">
              {adding ? 'New customer' : selected!.name}
              {selected && !adding && (
                <span className="inline-flex items-center gap-1 text-amber-700 text-[13px]">
                  <Star className="w-4 h-4" /> {selected.points}
                </span>
              )}
            </h2>
            {editing ? (
              <>
                <input className={FIELD} placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                <input className={FIELD} placeholder="Phone" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                <input className={FIELD} placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                <input className={FIELD} placeholder="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                {!adding && (
                  <label className="flex flex-col gap-1 text-[13px] font-semibold text-zinc-800">
                    Points (lower it when a customer redeems)
                    <input className={FIELD} type="number" min="0" value={form.points} onChange={(e) => setForm({ ...form, points: e.target.value })} />
                  </label>
                )}
                <button type="button" disabled={busy || !form.name.trim()} onClick={() => void save()} className={`${BTN} bg-zinc-900 text-white`}>
                  Save
                </button>
              </>
            ) : (
              <p className="text-[13px] text-zinc-600">
                {selected?.phone ?? 'No phone'} · {selected?.email ?? 'No email'}
              </p>
            )}
            {selected && !adding && (
              <div className="flex flex-col gap-1 text-[13px]">
                <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mt-2">Recent purchases</div>
                {(selected.recent_sales ?? []).map((s) => (
                  <div key={s.id} className="flex justify-between border-t border-zinc-100 py-1.5 tabular-nums">
                    <span>
                      {s.receipt_number} · {new Date(s.created_at).toLocaleDateString()}
                    </span>
                    <span className={s.status === 'VOIDED' ? 'line-through text-zinc-400' : ''}>{money(s.total)}</span>
                  </div>
                ))}
                {(selected.recent_sales ?? []).length === 0 && <span className="text-zinc-500">No purchases yet.</span>}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
};
