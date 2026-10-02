import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleAlert, PackageCheck, Plus, Truck } from 'lucide-react';
import { Product } from '../types';
import { api } from '../utils/api';
import type { PurchaseOrder, ReorderSuggestion, Supplier } from '../utils/api';

const FIELD =
  'w-full h-11 px-3 text-sm bg-white border border-zinc-200 rounded-xl text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900';
const BTN = 'h-11 px-4 inline-flex items-center justify-center gap-2 rounded-xl text-[13px] font-semibold disabled:opacity-60';
const money = (n: number) => `$${n.toFixed(2)}`;

type Tab = 'reorder' | 'orders' | 'suppliers';
type DraftLine = { product_id: number; name: string; quantity: string; unit_cost: string };

const Card: React.FC<{ title?: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="rounded-2xl border border-zinc-200/80 bg-white shadow-xs p-5 flex flex-col gap-3 min-w-0">
    {title && <h2 className="text-[15px] font-semibold text-zinc-950">{title}</h2>}
    {children}
  </section>
);

export const PurchasingPage: React.FC<{ products: Product[]; refreshData: () => Promise<void> | void }> = ({
  products,
  refreshData,
}) => {
  const [tab, setTab] = useState<Tab>('reorder');
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [suggestions, setSuggestions] = useState<ReorderSuggestion[]>([]);
  const [open, setOpen] = useState<PurchaseOrder | null>(null);
  const [draft, setDraft] = useState<{ supplier_id: number | ''; notes: string; lines: DraftLine[] } | null>(null);
  const [addProduct, setAddProduct] = useState('');
  const [supplierForm, setSupplierForm] = useState({ name: '', contact_name: '', phone: '', email: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, o, r] = await Promise.all([api.listSuppliers(), api.listPurchaseOrders(), api.reorderSuggestions()]);
      setSuppliers(s);
      setOrders(o);
      setSuggestions(r);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startDraft = (picked: ReorderSuggestion[]) => {
    const supplier = picked.find((p) => p.last_supplier_id)?.last_supplier_id ?? suppliers[0]?.id ?? '';
    setDraft({
      supplier_id: supplier,
      notes: '',
      lines: picked.map((p) => ({
        product_id: p.id,
        name: p.name,
        quantity: String(p.suggested_quantity),
        unit_cost: p.cost_price.toFixed(2),
      })),
    });
    setTab('orders');
  };

  const draftTotal = useMemo(
    () => (draft?.lines ?? []).reduce((a, l) => a + (parseFloat(l.quantity) || 0) * (parseFloat(l.unit_cost) || 0), 0),
    [draft],
  );

  const tabs: Array<[Tab, string]> = [
    ['reorder', `Low stock (${suggestions.length})`],
    ['orders', 'Purchase orders'],
    ['suppliers', 'Suppliers'],
  ];

  return (
    <div className="w-full px-4 sm:px-6 py-4 sm:py-6 flex flex-col gap-4">
      <div>
        <h1 className="text-xl lg:text-[22px] font-bold tracking-[-0.01em] text-zinc-950">Purchasing</h1>
        <p className="text-[13px] text-zinc-500">
          See what is running low, order it from a supplier, and receive the delivery straight into stock.
        </p>
      </div>

      <div className="flex gap-1 rounded-xl bg-zinc-100 p-1 self-start">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`h-9 px-3 rounded-lg text-[13px] font-semibold ${tab === id ? 'bg-white shadow-xs text-zinc-950' : 'text-zinc-600'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div role="alert" className="flex gap-2 p-3 rounded-xl bg-rose-50 border border-rose-200 text-[13px] text-rose-700">
          <CircleAlert className="w-4 h-4 mt-px" />
          {error}
        </div>
      )}

      {tab === 'reorder' && (
        <Card title="At or below the low-stock level">
          {suggestions.length === 0 ? (
            <p className="text-[13px] text-zinc-500">Nothing is running low.</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-[13px] tabular-nums">
                  <thead>
                    <tr className="text-left text-xs text-zinc-500">
                      <th className="py-1 pr-3 font-medium">Product</th>
                      <th className="py-1 pr-3 font-medium text-right">In stock</th>
                      <th className="py-1 pr-3 font-medium text-right">Low level</th>
                      <th className="py-1 font-medium text-right">Suggested order</th>
                    </tr>
                  </thead>
                  <tbody>
                    {suggestions.map((p) => (
                      <tr key={p.id} className="border-t border-zinc-100">
                        <td className="py-2 pr-3 font-semibold text-zinc-900">{p.name}</td>
                        <td className={`py-2 pr-3 text-right ${p.stock_quantity <= 0 ? 'text-rose-700 font-semibold' : ''}`}>{p.stock_quantity}</td>
                        <td className="py-2 pr-3 text-right">{p.min_stock_level}</td>
                        <td className="py-2 text-right">{p.suggested_quantity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="button" onClick={() => startDraft(suggestions)} disabled={suppliers.length === 0} className={`${BTN} bg-zinc-900 text-white self-start`}>
                <Truck className="w-4 h-4" /> Make a purchase order from these
              </button>
              {suppliers.length === 0 && <p className="text-xs text-amber-700">Add a supplier first (Suppliers tab).</p>}
            </>
          )}
        </Card>
      )}

      {tab === 'orders' && (
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="flex flex-col gap-4 min-w-0">
            {draft ? (
              <Card title="New purchase order">
                <select className={FIELD} value={draft.supplier_id} onChange={(e) => setDraft({ ...draft, supplier_id: Number(e.target.value) || '' })}>
                  <option value="">Choose supplier…</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                {draft.lines.map((l, i) => (
                  <div key={l.product_id} className="grid grid-cols-[minmax(0,1fr)_80px_96px_auto] gap-2 items-center text-[13px]">
                    <span className="truncate font-semibold">{l.name}</span>
                    <input className={FIELD} type="number" min="1" aria-label="Quantity" value={l.quantity} onChange={(e) => setDraft({ ...draft, lines: draft.lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)) })} />
                    <input className={FIELD} type="number" min="0" step="0.01" aria-label="Unit cost" value={l.unit_cost} onChange={(e) => setDraft({ ...draft, lines: draft.lines.map((x, j) => (j === i ? { ...x, unit_cost: e.target.value } : x)) })} />
                    <button type="button" className="text-rose-600 text-xs font-semibold" onClick={() => setDraft({ ...draft, lines: draft.lines.filter((_, j) => j !== i) })}>
                      Remove
                    </button>
                  </div>
                ))}
                <div className="flex gap-2">
                  <select className={FIELD} value={addProduct} onChange={(e) => setAddProduct(e.target.value)}>
                    <option value="">Add a product…</option>
                    {products
                      .filter((p) => p.is_active !== false && !draft.lines.some((l) => l.product_id === p.id))
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    disabled={!addProduct}
                    onClick={() => {
                      const p = products.find((x) => x.id === Number(addProduct));
                      if (!p) return;
                      setDraft({ ...draft, lines: [...draft.lines, { product_id: p.id, name: p.name, quantity: '1', unit_cost: (p.cost_price ?? 0).toFixed(2) }] });
                      setAddProduct('');
                    }}
                    className={`${BTN} border border-zinc-200`}
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
                <input className={FIELD} placeholder="Notes for the supplier (optional)" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-zinc-500">Order total</span>
                  <span className="font-bold tabular-nums">{money(draftTotal)}</span>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setDraft(null)} className={`${BTN} border border-zinc-200`}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={busy || !draft.supplier_id || draft.lines.length === 0}
                    onClick={() =>
                      run(async () => {
                        const po = await api.createPurchaseOrder({
                          supplier_id: Number(draft.supplier_id),
                          notes: draft.notes.trim() || undefined,
                          items: draft.lines.map((l) => ({ product_id: l.product_id, quantity: parseInt(l.quantity, 10) || 1, unit_cost: parseFloat(l.unit_cost) || 0 })),
                        });
                        setDraft(null);
                        setOpen(po);
                        await load();
                      })
                    }
                    className={`${BTN} flex-1 bg-zinc-900 text-white`}
                  >
                    Place order
                  </button>
                </div>
              </Card>
            ) : (
              <button type="button" onClick={() => setDraft({ supplier_id: suppliers[0]?.id ?? '', notes: '', lines: [] })} disabled={suppliers.length === 0} className={`${BTN} bg-zinc-900 text-white self-start`}>
                <Plus className="w-4 h-4" /> New purchase order
              </button>
            )}

            <Card title="Orders">
              {orders.length === 0 && <p className="text-[13px] text-zinc-500">No purchase orders yet.</p>}
              {orders.map((o) => (
                <button key={o.id} type="button" onClick={() => run(async () => setOpen(await api.getPurchaseOrder(o.id)))} className="text-left flex justify-between gap-3 border-t border-zinc-100 pt-2 text-[13px] hover:bg-zinc-50 rounded">
                  <span>
                    <span className="font-semibold text-zinc-900">{o.po_number}</span> · {o.supplier_name}
                    <span className="block text-xs text-zinc-500">
                      {new Date(o.created_at).toLocaleDateString()} · {o.item_count} units
                    </span>
                  </span>
                  <span className="text-right tabular-nums">
                    {money(o.total_cost)}
                    <span className={`block text-xs font-semibold ${o.status === 'RECEIVED' ? 'text-emerald-700' : o.status === 'CANCELLED' ? 'text-zinc-400' : 'text-amber-700'}`}>{o.status.toLowerCase()}</span>
                  </span>
                </button>
              ))}
            </Card>
          </div>

          {open && (
            <Card title={`${open.po_number} · ${open.supplier_name}`}>
              <div className="overflow-x-auto">
                <table className="w-full text-[13px] tabular-nums">
                  <thead>
                    <tr className="text-left text-xs text-zinc-500">
                      <th className="py-1 pr-3 font-medium">Product</th>
                      <th className="py-1 pr-3 font-medium text-right">Ordered</th>
                      <th className="py-1 pr-3 font-medium text-right">Received</th>
                      <th className="py-1 font-medium text-right">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(open.items ?? []).map((i) => (
                      <tr key={i.id} className="border-t border-zinc-100">
                        <td className="py-2 pr-3">{i.product_name}</td>
                        <td className="py-2 pr-3 text-right">{i.quantity}</td>
                        <td className="py-2 pr-3 text-right">{i.received_quantity}</td>
                        <td className="py-2 text-right">{money(i.unit_cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {open.status === 'ORDERED' && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        setOpen(await api.receivePurchaseOrder(open.id));
                        await Promise.all([load(), refreshData()]);
                      })
                    }
                    className={`${BTN} flex-1 bg-emerald-600 text-white`}
                  >
                    <PackageCheck className="w-4 h-4" /> Receive everything into stock
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        if (!window.confirm(`Cancel ${open.po_number}?`)) return;
                        setOpen(await api.cancelPurchaseOrder(open.id));
                        await load();
                      })
                    }
                    className={`${BTN} border border-rose-200 text-rose-700`}
                  >
                    Cancel order
                  </button>
                </div>
              )}
              {open.status === 'RECEIVED' && <p className="text-[13px] text-emerald-700">Received {open.received_at ? new Date(open.received_at).toLocaleString() : ''}. Stock and cost prices are updated.</p>}
            </Card>
          )}
        </div>
      )}

      {tab === 'suppliers' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Add supplier">
            <input className={FIELD} placeholder="Company name" value={supplierForm.name} onChange={(e) => setSupplierForm({ ...supplierForm, name: e.target.value })} />
            <input className={FIELD} placeholder="Contact person" value={supplierForm.contact_name} onChange={(e) => setSupplierForm({ ...supplierForm, contact_name: e.target.value })} />
            <input className={FIELD} placeholder="Phone" value={supplierForm.phone} onChange={(e) => setSupplierForm({ ...supplierForm, phone: e.target.value })} />
            <input className={FIELD} placeholder="Email" value={supplierForm.email} onChange={(e) => setSupplierForm({ ...supplierForm, email: e.target.value })} />
            <button
              type="button"
              disabled={busy || !supplierForm.name.trim()}
              onClick={() =>
                run(async () => {
                  await api.createSupplier({
                    name: supplierForm.name.trim(),
                    contact_name: supplierForm.contact_name.trim() || null,
                    phone: supplierForm.phone.trim() || null,
                    email: supplierForm.email.trim() || null,
                  });
                  setSupplierForm({ name: '', contact_name: '', phone: '', email: '' });
                  await load();
                })
              }
              className={`${BTN} bg-zinc-900 text-white self-start`}
            >
              <Plus className="w-4 h-4" /> Add supplier
            </button>
          </Card>
          <Card title="Suppliers">
            {suppliers.length === 0 && <p className="text-[13px] text-zinc-500">No suppliers yet.</p>}
            {suppliers.map((s) => (
              <div key={s.id} className="border-t border-zinc-100 pt-2 text-[13px]">
                <div className="font-semibold text-zinc-900">{s.name}</div>
                <div className="text-zinc-500">{[s.contact_name, s.phone, s.email].filter(Boolean).join(' · ') || 'No contact details'}</div>
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  );
};
