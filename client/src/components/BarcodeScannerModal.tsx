import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { Camera, X, Flashlight, Keyboard, AlertCircle, Check, Zap } from 'lucide-react';
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
  const [isPaused, setIsPaused] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  const scannerRef = useRef<Html5Qrcode | null>(null);
  const isStoppingRef = useRef(false);
  const isScanLockedRef = useRef(false);
  const lastScannedCodeRef = useRef<string | null>(null);
  const lastScanTimeRef = useRef(0);
  const lockTimerRef = useRef<any>(null);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

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
    setIsPaused(false);
    setCooldownSeconds(0);
    isScanLockedRef.current = false;
    lastScannedCodeRef.current = null;
    lastScanTimeRef.current = 0;

    const initScanner = async () => {
      try {
        const formatsToSupport = [
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.UPC_E,
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.CODE_93,
          Html5QrcodeSupportedFormats.CODABAR,
          Html5QrcodeSupportedFormats.ITF,
          Html5QrcodeSupportedFormats.QR_CODE,
          Html5QrcodeSupportedFormats.DATA_MATRIX,
        ];

        const html5QrCode = new Html5Qrcode(scannerElementId, {
          formatsToSupport,
          verbose: false,
          experimentalFeatures: {
            useBarCodeDetectorIfSupported: true,
          },
        });
        scannerRef.current = html5QrCode;

        const config = {
          fps: 20,
          qrbox: (viewfinderWidth: number, viewfinderHeight: number) => ({
            width: Math.min(Math.floor(viewfinderWidth * 0.90), 340),
            height: Math.min(Math.floor(viewfinderHeight * 0.50), 160),
          }),
          aspectRatio: 1.333333,
        };

        await html5QrCode.start(
          {
            facingMode: 'environment',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          config,
          (decodedText) => {
            const cleanCode = decodedText ? decodedText.trim() : '';
            if (!cleanCode) return;

            const now = Date.now();

            // 1. Guard against scans while locked in pause window
            if (isScanLockedRef.current) {
              return;
            }

            // 2. Cooldown for the SAME barcode (3.5s) to prevent adding 20+ when holding one item
            if (lastScannedCodeRef.current === cleanCode && now - lastScanTimeRef.current < 3500) {
              return;
            }

            // 3. General cooldown between ANY consecutive scans (1.2s)
            if (now - lastScanTimeRef.current < 1200) {
              return;
            }

            // Lock immediately to prevent duplicate frames from triggering
            isScanLockedRef.current = true;
            lastScannedCodeRef.current = cleanCode;
            lastScanTimeRef.current = now;

            setLastScanned(cleanCode);
            playScanSuccessSound();

            // Mobile vibration feedback
            if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
              try {
                navigator.vibrate([60, 40, 60]);
              } catch {}
            }

            onScanRef.current(cleanCode);

            if (!continuous) {
              cleanupScanner();
              onClose();
              return;
            }

            // Continuous mode: pause scanning for 3s so the item isn't re-scanned repeatedly
            setIsPaused(true);
            setCooldownSeconds(3);

            if (lockTimerRef.current) {
              clearInterval(lockTimerRef.current);
            }

            let remaining = 3;
            lockTimerRef.current = setInterval(() => {
              remaining -= 1;
              if (remaining <= 0) {
                if (lockTimerRef.current) {
                  clearInterval(lockTimerRef.current);
                  lockTimerRef.current = null;
                }
                isScanLockedRef.current = false;
                setIsPaused(false);
                setCooldownSeconds(0);
              } else {
                setCooldownSeconds(remaining);
              }
            }, 1000);
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
    if (lockTimerRef.current) {
      clearInterval(lockTimerRef.current);
      lockTimerRef.current = null;
    }
    isScanLockedRef.current = false;
    lastScannedCodeRef.current = null;

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

  const handleUnlockNow = () => {
    if (lockTimerRef.current) {
      clearInterval(lockTimerRef.current);
      lockTimerRef.current = null;
    }
    isScanLockedRef.current = false;
    lastScannedCodeRef.current = null;
    setIsPaused(false);
    setCooldownSeconds(0);
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
    const clean = manualCode.trim();
    if (!clean) return;

    lastScannedCodeRef.current = clean;
    lastScanTimeRef.current = Date.now();
    setLastScanned(clean);

    playScanSuccessSound();
    onScanRef.current(clean);
    setManualCode('');

    if (!continuous) {
      cleanupScanner();
      onClose();
    } else {
      setIsPaused(true);
      setCooldownSeconds(2);
      isScanLockedRef.current = true;
      setTimeout(() => {
        isScanLockedRef.current = false;
        setIsPaused(false);
        setCooldownSeconds(0);
      }, 2000);
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

          {/* Scanner Overlay Line / Pause feedback */}
          {isScanning && (
            <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center p-3">
              <div
                className={`w-[88%] max-w-[340px] h-32 sm:h-36 border-2 rounded-2xl relative transition-all duration-300 ${
                  isPaused
                    ? 'border-emerald-400 bg-emerald-950/40 shadow-[0_0_25px_rgba(52,211,153,0.5)] ring-4 ring-emerald-500/20'
                    : 'border-dashed border-emerald-400/90 shadow-[0_0_15px_rgba(52,211,153,0.3)]'
                }`}
              >
                {!isPaused ? (
                  <div className="absolute inset-x-0 h-0.5 bg-emerald-400 shadow-[0_0_10px_#34d399] animate-pulse top-1/2 -translate-y-1/2" />
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-center px-2">
                    <div className="w-8 h-8 rounded-full bg-emerald-500 text-zinc-950 flex items-center justify-center font-bold">
                      <Check className="w-5 h-5 stroke-[3]" />
                    </div>
                    <span className="text-xs font-bold text-white font-mono bg-zinc-950/80 px-2 py-0.5 rounded">
                      {lastScanned}
                    </span>
                    <span className="text-[10px] font-semibold text-emerald-300">
                      Captured!
                    </span>
                  </div>
                )}
              </div>

              {/* Status and manual unlock button */}
              <div className="mt-3 flex flex-col items-center gap-1.5 text-center px-4 pointer-events-auto">
                {isPaused ? (
                  <div className="flex flex-col items-center gap-2">
                    <span className="text-[11px] font-semibold text-emerald-200 bg-zinc-900/95 px-3 py-1 rounded-full border border-emerald-500/30 flex items-center gap-1.5 shadow-md">
                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                      <span>Paused ({cooldownSeconds}s) to prevent double-scan</span>
                    </span>

                    <button
                      type="button"
                      onClick={handleUnlockNow}
                      className="px-4 py-2 bg-emerald-400 hover:bg-emerald-300 text-zinc-950 text-xs font-bold rounded-xl shadow-lg flex items-center gap-1.5 transition-transform active:scale-95 cursor-pointer"
                    >
                      <Zap className="w-3.5 h-3.5 fill-current" />
                      <span>Scan Next Item Now</span>
                    </button>
                  </div>
                ) : (
                  <>
                    <span className="text-[11px] font-bold text-emerald-300 bg-zinc-900/90 px-3 py-1 rounded-full border border-emerald-500/30">
                      Align barcode along the green line
                    </span>
                    <span className="text-[10px] text-zinc-300 bg-black/60 px-2.5 py-0.5 rounded">
                      💡 Bottles / Cans: Hold barcode horizontally across the line or tilt to avoid glare
                    </span>
                  </>
                )}
              </div>
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
          <div className="bg-emerald-50 border-y border-emerald-200 px-4 py-2 flex items-center justify-between text-xs text-emerald-900">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${isPaused ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'}`} />
              <span>Scanned: <strong className="font-mono text-zinc-950">{lastScanned}</strong></span>
            </div>
            {isPaused ? (
              <button
                type="button"
                onClick={handleUnlockNow}
                className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[11px] font-bold shadow-xs flex items-center gap-1 transition-all active:scale-95"
              >
                <Zap className="w-3 h-3" />
                <span>Resume ({cooldownSeconds}s)</span>
              </button>
            ) : (
              <span className="text-[10px] bg-emerald-200/80 px-2 py-0.5 rounded font-semibold text-emerald-800">
                Ready for next
              </span>
            )}
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
