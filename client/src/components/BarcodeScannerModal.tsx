import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { Camera, X, Flashlight, Keyboard, AlertCircle } from 'lucide-react';
import { playScanSuccessSound, playScanErrorSound } from '../utils/audio';

interface BarcodeScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onScan: (barcode: string) => void;
  title?: string;
  subtitle?: string;
  continuous?: boolean;
}

export const BarcodeScannerModal: React.FC<BarcodeScannerModalProps> = ({
  isOpen,
  onClose,
  onScan,
  title = 'Scan Barcode',
  subtitle = 'Point camera at product barcode or enter manually',
  continuous = false,
}) => {
  const [manualCode, setManualCode] = useState('');
  const [showManualInput, setShowManualInput] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [lastScanned, setLastScanned] = useState<string | null>(null);

  const scannerRef = useRef<Html5Qrcode | null>(null);
  const isStoppingRef = useRef(false);
  const lastScanTimeRef = useRef(0);

  useEffect(() => {
    if (!isOpen) {
      cleanupScanner();
      setShowManualInput(false);
      return;
    }

    // Dismiss any active virtual keyboard when scanner modal opens
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    const scannerElementId = 'barcode-reader-view';
    setErrorMessage(null);
    setLastScanned(null);

    const initScanner = async () => {
      try {
        const formatsToSupport = [
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.UPC_E,
          Html5QrcodeSupportedFormats.QR_CODE,
        ];

        const html5QrCode = new Html5Qrcode(scannerElementId, {
          formatsToSupport,
          verbose: false,
        });
        scannerRef.current = html5QrCode;

        const config = {
          fps: 15,
          qrbox: { width: 280, height: 160 },
          aspectRatio: 1.333333,
        };

        await html5QrCode.start(
          { facingMode: 'environment' },
          config,
          (decodedText) => {
            const now = Date.now();
            // Debounce continuous scans by 1.2s to prevent multiple triggers of same item
            if (now - lastScanTimeRef.current < 1200 && lastScanned === decodedText) {
              return;
            }
            lastScanTimeRef.current = now;
            setLastScanned(decodedText);
            playScanSuccessSound();

            onScan(decodedText);

            if (!continuous) {
              cleanupScanner();
              onClose();
            }
          },
          () => {
            // scan failure callback (silent on no barcode frame)
          }
        );

        setIsScanning(true);

        // Check torch capability
        try {
          // @ts-ignore
          const capabilities = html5QrCode.getRunningTrackCameraCapabilities();
          if (capabilities && capabilities.torchFeature().isSupported()) {
            setHasTorch(true);
          }
        } catch {
          setHasTorch(false);
        }
      } catch (err: any) {
        console.warn('Camera initiation failed:', err);
        setErrorMessage(
          err.message || 'Camera permission denied or camera not available. You can enter the barcode manually below.'
        );
        setIsScanning(false);
      }
    };

    const timer = setTimeout(initScanner, 150);
    return () => {
      clearTimeout(timer);
      cleanupScanner();
    };
  }, [isOpen]);

  const cleanupScanner = async () => {
    if (scannerRef.current && !isStoppingRef.current) {
      isStoppingRef.current = true;
      try {
        if (scannerRef.current.isScanning) {
          await scannerRef.current.stop();
        }
        await scannerRef.current.clear();
      } catch (e) {
        console.warn('Scanner stop error:', e);
      } finally {
        scannerRef.current = null;
        isStoppingRef.current = false;
        setIsScanning(false);
      }
    }
  };

  const toggleTorch = async () => {
    if (!scannerRef.current) return;
    try {
      // @ts-ignore
      await scannerRef.current.applyVideoConstraints({
        advanced: [{ torch: !torchOn } as any],
      });
      setTorchOn(!torchOn);
    } catch (e) {
      console.warn('Torch toggle failed', e);
    }
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualCode.trim()) return;
    playScanSuccessSound();
    onScan(manualCode.trim());
    setManualCode('');
    if (!continuous) {
      cleanupScanner();
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-zinc-950/60 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl border border-zinc-200 overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100">
          <div>
            <h3 className="text-base font-semibold text-zinc-900 flex items-center gap-2">
              <Camera className="w-4 h-4 text-zinc-700" />
              {title}
            </h3>
            <p className="text-xs text-zinc-500 mt-0.5">{subtitle}</p>
          </div>
          <button
            onClick={() => {
              cleanupScanner();
              onClose();
            }}
            className="p-1.5 text-zinc-400 hover:text-zinc-700 rounded-lg hover:bg-zinc-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Viewfinder / Camera Area */}
        <div className="relative bg-zinc-950 flex flex-col items-center justify-center min-h-[280px] overflow-hidden">
          <div id="barcode-reader-view" className="w-full max-h-[320px] overflow-hidden" />

          {/* Scanner Overlay Line */}
          {isScanning && (
            <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center">
              <div className="w-64 h-36 border-2 border-dashed border-emerald-400/80 rounded-xl relative">
                <div className="absolute inset-x-0 h-0.5 bg-emerald-400 shadow-[0_0_8px_#34d399] animate-pulse top-1/2 -translate-y-1/2" />
              </div>
              <span className="mt-3 text-[11px] font-medium text-emerald-300 bg-zinc-900/80 px-2.5 py-0.5 rounded-full border border-emerald-500/30">
                Align barcode inside frame
              </span>
            </div>
          )}

          {/* Torch toggle */}
          {hasTorch && isScanning && (
            <button
              onClick={toggleTorch}
              className={`absolute top-3 right-3 p-2 rounded-full backdrop-blur-md transition-colors ${
                torchOn ? 'bg-amber-400 text-zinc-950 shadow-md' : 'bg-zinc-900/70 text-white hover:bg-zinc-800'
              }`}
            >
              <Flashlight className="w-4 h-4" />
            </button>
          )}

          {/* Error fallback message */}
          {errorMessage && (
            <div className="p-6 text-center max-w-xs">
              <div className="w-10 h-10 mx-auto mb-3 rounded-full bg-rose-50 flex items-center justify-center text-rose-600">
                <AlertCircle className="w-5 h-5" />
              </div>
              <p className="text-xs text-zinc-300 mb-2">{errorMessage}</p>
              <span className="text-[11px] text-zinc-400">Use manual entry or a hardware USB scanner</span>
            </div>
          )}
        </div>

        {/* Last scanned banner */}
        {lastScanned && continuous && (
          <div className="bg-emerald-50 border-y border-emerald-200 px-4 py-2 flex items-center justify-between text-xs text-emerald-800">
            <span>Scanned: <strong className="font-mono">{lastScanned}</strong></span>
            <span className="text-[10px] bg-emerald-200/80 px-2 py-0.5 rounded font-medium">Ready for next</span>
          </div>
        )}

        {/* Manual Barcode Input Fallback - Collapsible to prevent mobile keyboard popups */}
        <div className="p-3 bg-zinc-50 border-t border-zinc-100">
          {!showManualInput ? (
            <button
              type="button"
              onClick={() => setShowManualInput(true)}
              className="w-full flex items-center justify-center gap-2 py-2 text-xs font-semibold text-zinc-600 hover:text-zinc-900 bg-white hover:bg-zinc-100/80 border border-zinc-200 rounded-xl transition-colors shadow-2xs"
            >
              <Keyboard className="w-3.5 h-3.5 text-zinc-500" />
              <span>Enter Barcode Manually</span>
            </button>
          ) : (
            <form onSubmit={handleManualSubmit} className="space-y-2 animate-in fade-in duration-150">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Keyboard className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    inputMode="text"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck="false"
                    value={manualCode}
                    onChange={(e) => setManualCode(e.target.value)}
                    placeholder="Type barcode digits & press Enter..."
                    className="w-full pl-9 pr-3 py-2 text-xs sm:text-sm bg-white border border-zinc-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900 placeholder:text-zinc-400 font-mono"
                    autoFocus={false}
                  />
                </div>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold text-white bg-zinc-900 rounded-xl hover:bg-zinc-800 transition-colors shadow-sm"
                >
                  Enter
                </button>
                <button
                  type="button"
                  onClick={() => setShowManualInput(false)}
                  className="px-2.5 py-2 text-xs text-zinc-500 hover:text-zinc-800 bg-zinc-200/70 hover:bg-zinc-200 rounded-xl transition-colors"
                  title="Close manual entry"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
