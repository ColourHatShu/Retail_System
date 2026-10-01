import React, { useEffect, useId, useRef } from 'react';
import { PackagePlus, Plus } from 'lucide-react';

interface UnregisteredProductDialogProps {
  /** The barcode no product carries. The dialog is open while this is set. */
  barcode: string | null;
  /**
   * Only owners and managers can create products — the server refuses everyone else —
   * so a cashier is told who can instead of being handed a form that will fail.
   */
  canRegister: boolean;
  onRegister: () => void;
  onClose: () => void;
}

/**
 * Asked the moment a scan finds no product: register it now, or carry on. Drawn above
 * the camera scanner (z-50), so it can be answered without closing the camera first.
 */
export const UnregisteredProductDialog: React.FC<UnregisteredProductDialogProps> = ({
  barcode,
  canRegister,
  onRegister,
  onClose,
}) => {
  const titleId = useId();
  const descriptionId = useId();
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const isOpen = barcode !== null;

  useEffect(() => {
    if (!isOpen) return;
    primaryRef.current?.focus();
    // Capture phase, and stopped here: the scanner underneath closes on Escape too, and
    // one key press should only close the top layer.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-zinc-950/60 p-0 backdrop-blur-sm animate-in fade-in duration-150 sm:items-center sm:p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="relative flex w-full flex-col overflow-hidden rounded-t-2xl border border-zinc-200 bg-white shadow-2xl sm:max-w-sm sm:rounded-2xl"
      >
        <div className="flex flex-col gap-3 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom,0px))] sm:pb-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700">
              <PackagePlus className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <h2 id={titleId} className="text-sm font-bold text-zinc-950">
                This product is not registered
              </h2>
              <p id={descriptionId} className="text-[13px] leading-5 text-zinc-500">
                No product in your catalogue has the barcode{' '}
                <span className="break-all font-mono font-semibold text-zinc-900">{barcode}</span>.{' '}
                {canRegister
                  ? 'Do you want to register it?'
                  : 'Ask a manager or the owner to add it in Inventory.'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            {canRegister ? (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  className="h-12 flex-1 rounded-xl border border-zinc-200 bg-white text-sm font-semibold text-zinc-800 transition-colors hover:bg-zinc-50"
                >
                  Not now
                </button>
                <button
                  ref={primaryRef}
                  type="button"
                  onClick={onRegister}
                  className="inline-flex h-12 flex-1 items-center justify-center gap-1.5 rounded-xl bg-zinc-900 text-sm font-semibold text-white transition-colors hover:bg-zinc-800"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  <span>Register product</span>
                </button>
              </>
            ) : (
              <button
                ref={primaryRef}
                type="button"
                onClick={onClose}
                className="h-12 flex-1 rounded-xl bg-zinc-900 text-sm font-semibold text-white transition-colors hover:bg-zinc-800"
              >
                OK
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
