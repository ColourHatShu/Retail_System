import React, { useEffect, useState } from 'react';
import { Lock, X } from 'lucide-react';
import type { CartItem } from '../types';

/**
 * Edit one order line: quantity, money off the line, and (for managers and
 * owners) the price per unit. The server enforces the same rules.
 */
export const LineEditDialog: React.FC<{
  item: CartItem | null;
  canOverridePrice: boolean;
  onClose: () => void;
  onSave: (patch: { quantity: number; line_discount?: number; price_override?: number }) => void;
  onRemove: () => void;
}> = ({ item, canOverridePrice, onClose, onSave, onRemove }) => {
  const [qty, setQty] = useState('1');
  const [discount, setDiscount] = useState('');
  const [discountMode, setDiscountMode] = useState<'$' | '%'>('$');
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!item) return;
    setQty(String(item.quantity));
    setDiscount(item.line_discount ? String(item.line_discount) : '');
    setDiscountMode('$');
    setPrice(item.price_override !== undefined ? String(item.price_override) : '');
    setError(null);
  }, [item]);

  if (!item) return null;

  const save = () => {
    const quantity = parseInt(qty, 10);
    if (!Number.isFinite(quantity) || quantity < 1) return setError('Quantity must be at least 1.');
    const unit = price.trim() === '' ? item.unit_price : parseFloat(price);
    if (!Number.isFinite(unit) || unit < 0) return setError('Enter a valid price.');
    const gross = Math.round(unit * 100) * quantity;
    let off = discount.trim() === '' ? 0 : parseFloat(discount);
    if (!Number.isFinite(off) || off < 0) return setError('Enter a valid discount.');
    if (discountMode === '%') off = Math.round(gross * Math.min(off, 100)) / 10000;
    if (Math.round(off * 100) > gross) return setError('The discount is more than the line.');
    onSave({
      quantity,
      line_discount: off > 0 ? Math.round(off * 100) / 100 : undefined,
      price_override: price.trim() === '' || unit === item.unit_price ? undefined : unit,
    });
  };

  const field = 'h-11 px-3 rounded-xl border border-zinc-200 text-sm tabular-nums w-full';

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-zinc-950/50 p-0 sm:p-4" role="dialog" aria-modal="true" aria-label={`Edit ${item.product.name}`}>
      <div className="w-full sm:max-w-sm bg-white rounded-t-2xl sm:rounded-2xl shadow-xl p-5 flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-zinc-950">{item.product.name}</h2>
            <p className="text-[13px] text-zinc-500">List price ${item.unit_price.toFixed(2)}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="w-10 h-10 grid place-items-center rounded-xl hover:bg-zinc-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-800">
          Quantity
          <input className={field} type="number" min="1" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>

        <div className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-800">
          Discount on this line
          <div className="flex gap-2">
            <input
              className={field}
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={discount}
              onChange={(e) => setDiscount(e.target.value)}
              placeholder="0"
            />
            <div className="flex rounded-xl border border-zinc-200 overflow-hidden flex-shrink-0">
              {(['$', '%'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setDiscountMode(m)}
                  aria-pressed={discountMode === m}
                  className={`w-11 h-11 text-sm font-bold ${discountMode === m ? 'bg-zinc-900 text-white' : 'bg-white text-zinc-700'}`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        </div>

        <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-800">
          <span className="flex items-center gap-1.5">
            Price each {!canOverridePrice && <Lock className="w-3.5 h-3.5 text-zinc-400" />}
          </span>
          <input
            className={`${field} disabled:bg-zinc-50 disabled:text-zinc-400`}
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder={item.unit_price.toFixed(2)}
            disabled={!canOverridePrice}
          />
          {!canOverridePrice && <span className="text-xs font-normal text-zinc-500">Only a manager or owner can change a price.</span>}
        </label>

        {error && <p className="text-[13px] text-rose-600">{error}</p>}

        <div className="flex gap-2">
          <button type="button" onClick={onRemove} className="h-12 px-4 rounded-xl border border-rose-200 text-rose-700 font-semibold">
            Remove
          </button>
          <button type="button" onClick={save} className="flex-1 h-12 rounded-xl bg-zinc-900 text-white font-bold">
            Save
          </button>
        </div>
      </div>
    </div>
  );
};
