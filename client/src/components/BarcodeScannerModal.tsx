import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import {
  Camera,
  X,
  Flashlight,
  Keyboard,
  AlertCircle,
  Check,
  Zap,
  RefreshCw,
  ShieldAlert,
  VideoOff,
  Lightbulb,
  Lock,
} from 'lucide-react';
import { playScanSuccessSound, playScanErrorSound } from '../utils/audio';

/**
 * What the caller reports back about a scan. Returning nothing (or `true`) means
 * accepted, so existing callers keep working unchanged. Return `false` — or
 * `{ accepted: false, message }` to show the reason inside the dialog — when the
 * register refuses the item, so it never beeps success and then errors.
 */
export type BarcodeScanOutcome = void | boolean | { accepted: boolean; message?: string };

// One window drives both the on-screen countdown and the same-code guard. When they
// drift apart the cashier sees "Ready for next" while scans are still being swallowed.
const SAME_CODE_COOLDOWN_MS = 3000;
const SAME_CODE_COOLDOWN_SECONDS = SAME_CODE_COOLDOWN_MS / 1000;
// Shorter floor between two *different* barcodes.
const ANY_SCAN_COOLDOWN_MS = 1200;

const normalizeOutcome = (outcome: unknown): { accepted: boolean; message?: string } => {
  if (outcome === false) return { accepted: false };
  if (outcome && typeof outcome === 'object' && 'accepted' in outcome) {
    const result = outcome as { accepted: boolean; message?: string };
    return { accepted: result.accepted !== false, message: result.message };
  }
  return { accepted: true };
};

interface BarcodeScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onScan: (barcode: string) => BarcodeScanOutcome | Promise<BarcodeScanOutcome>;
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
  const [errorType, setErrorType] = useState<'PERMISSION' | 'NOT_FOUND' | 'IN_USE' | 'PHOTO' | 'OTHER' | null>(null);
  const [rejectedMessage, setRejectedMessage] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isPhotoScanning, setIsPhotoScanning] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [lastScanned, setLastScanned] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  // Multiple cameras support
  const [cameras, setCameras] = useState<Array<{ id: string; label: string }>>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>('');

  const scannerRef = useRef<Html5Qrcode | null>(null);
  const isStoppingRef = useRef(false);
  const isScanLockedRef = useRef(false);
  const lastScannedCodeRef = useRef<string | null>(null);
  const lastScanTimeRef = useRef(0);
  const lockTimerRef = useRef<any>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  const scannerElementId = 'barcode-reader-view';

  // The single place a scan becomes real: the caller decides, the dialog reacts. Nothing
  // celebrates until the register has actually taken the item.
  const commitScan = async (code: string): Promise<boolean> => {
    let outcome: { accepted: boolean; message?: string };
    try {
      outcome = normalizeOutcome(await onScanRef.current(code));
    } catch (e) {
      console.warn('onScan handler threw:', e);
      outcome = { accepted: false };
    }

    if (!outcome.accepted) {
      playScanErrorSound();
      setRejectedMessage(outcome.message || null);
      return false;
    }

    setRejectedMessage(null);
    setLastScanned(code);
    playScanSuccessSound();

    // Mobile vibration feedback
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate([60, 40, 60]);
      } catch {}
    }

    return true;
  };

  // Continuous mode: hold scanning for the same window the same-code guard uses so the
  // item isn't re-scanned repeatedly and the countdown never lies about being ready.
  const startPause = () => {
    isScanLockedRef.current = true;
    setIsPaused(true);
    setCooldownSeconds(SAME_CODE_COOLDOWN_SECONDS);

    if (lockTimerRef.current) {
      clearInterval(lockTimerRef.current);
    }

    let remaining = SAME_CODE_COOLDOWN_SECONDS;
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
  };

  const onScanSuccess = async (decodedText: string) => {
    const cleanCode = decodedText ? decodedText.trim() : '';
    if (!cleanCode) return;

    const now = Date.now();

    // 1. Guard against scans while locked in pause window
    if (isScanLockedRef.current) {
      return;
    }

    // 2. Cooldown for the SAME barcode to prevent adding 20+ when holding one item
    if (lastScannedCodeRef.current === cleanCode && now - lastScanTimeRef.current < SAME_CODE_COOLDOWN_MS) {
      return;
    }

    // 3. General cooldown between ANY consecutive scans (1.2s)
    if (now - lastScanTimeRef.current < ANY_SCAN_COOLDOWN_MS) {
      return;
    }

    // Lock immediately to prevent duplicate frames from triggering
    isScanLockedRef.current = true;
    lastScannedCodeRef.current = cleanCode;
    lastScanTimeRef.current = now;

    const accepted = await commitScan(cleanCode);

    // Refused: no "Captured!", no countdown. Keep the same-code refs so the refused item
    // stays quiet in front of the lens, but unlock so the next item scans immediately.
    if (!accepted) {
      isScanLockedRef.current = false;
      return;
    }

    if (!continuous) {
      cleanupScanner();
      onClose();
      return;
    }

    startPause();
  };

  const initScanner = async (preferredCameraId?: string) => {
    try {
      setIsScanning(false);
      setErrorMessage(null);
      setErrorType(null);

      // Clean up previous instance cleanly
      if (scannerRef.current) {
        try {
          if (scannerRef.current.isScanning) {
            await scannerRef.current.stop();
          }
          await scannerRef.current.clear();
        } catch {}
        scannerRef.current = null;
      }

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

      // 1. Enumerate cameras if possible
      let availableDevices: Array<{ id: string; label: string }> = [];
      try {
        availableDevices = await Html5Qrcode.getCameras();
        if (availableDevices && availableDevices.length > 0) {
          setCameras(availableDevices);
        }
      } catch (e) {
        // getCameras can throw before permissions are granted
      }

      let started = false;
      let lastErr: any = null;

      // Strategy A: If specific camera selected or preferred, try it first
      const targetCameraId = preferredCameraId || selectedCameraId;
      if (targetCameraId && availableDevices.some((d) => d.id === targetCameraId)) {
        try {
          await html5QrCode.start(targetCameraId, config, onScanSuccess, () => {});
          started = true;
        } catch (e) {
          lastErr = e;
        }
      }

      // Strategy B: Prefer detected rear/environment camera device ID
      if (!started && availableDevices.length > 0) {
        const backCam = availableDevices.find(
          (c) =>
            c.label.toLowerCase().includes('back') ||
            c.label.toLowerCase().includes('rear') ||
            c.label.toLowerCase().includes('environment')
        );
        const candidateId = backCam ? backCam.id : availableDevices[0].id;
        try {
          await html5QrCode.start(candidateId, config, onScanSuccess, () => {});
          setSelectedCameraId(candidateId);
          started = true;
        } catch (e) {
          lastErr = e;
        }
      }

      // Strategy C: Flexible facingMode { ideal: 'environment' } (won't fail on devices without rear camera!)
      if (!started) {
        try {
          await html5QrCode.start(
            {
              facingMode: { ideal: 'environment' },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
            config,
            onScanSuccess,
            () => {}
          );
          started = true;
        } catch (e) {
          lastErr = e;
        }
      }

      // Strategy D: Front camera or default video stream
      if (!started) {
        try {
          await html5QrCode.start(
            {
              facingMode: 'user',
            },
            config,
            onScanSuccess,
            () => {}
          );
          started = true;
        } catch (e) {
          lastErr = e;
        }
      }

      if (!started && lastErr) {
        throw lastErr;
      }

      setIsScanning(true);
      setErrorMessage(null);
      setErrorType(null);

      // Re-fetch cameras after permission is granted to get accurate labels
      try {
        const refreshed = await Html5Qrcode.getCameras();
        if (refreshed.length > 0) {
          setCameras(refreshed);
        }
      } catch {}

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
      setIsScanning(false);

      const msg = String(err?.message || err || '');
      const name = String(err?.name || '');

      if (
        name === 'NotAllowedError' ||
        name === 'PermissionDeniedError' ||
        msg.toLowerCase().includes('permission') ||
        msg.toLowerCase().includes('denied') ||
        msg.toLowerCase().includes('notallowederror')
      ) {
        setErrorType('PERMISSION');
        setErrorMessage('Camera access was blocked by your browser settings.');
      } else if (
        name === 'NotFoundError' ||
        name === 'DevicesNotFoundError' ||
        msg.toLowerCase().includes('notfound') ||
        msg.toLowerCase().includes('requested device not found')
      ) {
        setErrorType('NOT_FOUND');
        setErrorMessage('No camera hardware was detected on this device.');
      } else if (
        name === 'NotReadableError' ||
        name === 'TrackStartError' ||
        msg.toLowerCase().includes('notreadableerror') ||
        msg.toLowerCase().includes('could not start video source')
      ) {
        setErrorType('IN_USE');
        setErrorMessage('Camera is currently in use by another app or browser window.');
      } else {
        setErrorType('OTHER');
        setErrorMessage(msg || 'Unable to access camera.');
      }

      // Auto-expand manual input so the user is never stuck
      setShowManualInput(true);
    }
  };

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

    setErrorMessage(null);
    setErrorType(null);
    setRejectedMessage(null);
    setLastScanned(null);
    setIsPaused(false);
    setCooldownSeconds(0);
    isScanLockedRef.current = false;
    lastScannedCodeRef.current = null;
    lastScanTimeRef.current = 0;

    const timer = setTimeout(() => {
      initScanner();
    }, 150);

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

  const handleRetryScanner = async () => {
    setIsRetrying(true);
    setErrorMessage(null);
    setErrorType(null);

    // Explicit user-gesture camera permission request via getUserMedia
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((track) => track.stop());
      }
    } catch (e) {
      console.warn('Direct getUserMedia prompt caught:', e);
    }

    try {
      await initScanner();
    } finally {
      setIsRetrying(false);
    }
  };

  const handleFileCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsPhotoScanning(true);
    try {
      let scanner = scannerRef.current;
      if (!scanner) {
        scanner = new Html5Qrcode(scannerElementId, {
          verbose: false,
          formatsToSupport: [
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
          ],
        });
        scannerRef.current = scanner;
      }

      const decodedText = await scanner.scanFile(file, false);
      const cleanCode = decodedText ? decodedText.trim() : '';
      if (cleanCode) {
        // Feed the guards too, so the live camera can't immediately re-add the same item.
        lastScannedCodeRef.current = cleanCode;
        lastScanTimeRef.current = Date.now();

        const accepted = await commitScan(cleanCode);
        if (accepted && !continuous) {
          cleanupScanner();
          onClose();
        }
      }
    } catch {
      playScanErrorSound();
      // The dialog already owns an error surface; an alert() drops the cashier out of it.
      setErrorType('PHOTO');
      setErrorMessage('No barcode found in that photo. Center the barcode, hold steady and try again in better light.');
    } finally {
      setIsPhotoScanning(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
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

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = manualCode.trim();
    if (!clean) return;

    lastScannedCodeRef.current = clean;
    lastScanTimeRef.current = Date.now();

    const accepted = await commitScan(clean);
    // Keep what was typed on a refusal so the cashier can correct it instead of retyping.
    if (!accepted) return;

    setManualCode('');

    if (!continuous) {
      cleanupScanner();
      onClose();
    } else {
      startPause();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-zinc-950/60 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl border border-zinc-200 overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header with Camera Switcher */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100">
          <div>
            <h3 className="text-base font-semibold text-zinc-900 flex items-center gap-2">
              <Camera className="w-4 h-4 text-zinc-700" />
              {title}
            </h3>
            <p className="text-xs text-zinc-500 mt-0.5">{subtitle}</p>
          </div>

          <div className="flex items-center gap-2">
            {cameras.length > 1 && isScanning && (
              <select
                value={selectedCameraId}
                onChange={(e) => {
                  setSelectedCameraId(e.target.value);
                  initScanner(e.target.value);
                }}
                className="text-[11px] font-medium bg-zinc-100 hover:bg-zinc-200 border border-zinc-200 rounded-lg px-2 py-1 text-zinc-800 max-w-[130px] truncate focus:outline-none"
                title="Switch Camera"
                aria-label="Switch camera"
              >
                {cameras.map((c, i) => (
                  <option key={c.id} value={c.id}>
                    {c.label || `Camera ${i + 1}`}
                  </option>
                ))}
              </select>
            )}

            <button
              onClick={() => {
                cleanupScanner();
                onClose();
              }}
              className="p-1.5 text-zinc-500 hover:text-zinc-900 rounded-lg hover:bg-zinc-100 transition-colors"
              title="Close scanner"
              aria-label="Close scanner"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Viewfinder / Camera Area */}
        <div className="relative bg-zinc-950 flex items-center justify-center min-h-[320px] sm:min-h-[350px] overflow-hidden">
          <div id="barcode-reader-view" className="w-full h-full min-h-[320px] overflow-hidden flex items-center justify-center [&_video]:object-cover" />

          {/* Scanner Overlay Line / Pause feedback */}
          {isScanning && !errorMessage && (
            <div className="absolute inset-0 pointer-events-none">
              {/* Perfectly Centered Target Box & Laser Line */}
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[84%] max-w-[320px] h-32 sm:h-36 pointer-events-none">
                <div
                  className={`w-full h-full border-2 rounded-2xl relative transition-all duration-300 ${
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
                      <span className="text-xs font-semibold text-emerald-300">
                        Captured!
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Status and instruction pill anchored at the bottom */}
              <div className="absolute bottom-2.5 inset-x-0 flex flex-col items-center gap-1 text-center px-4">
                {isPaused ? (
                  /* The "Resume" control lives in the banner below, which is on screen in
                     every paused state — including camera-error / manual entry. */
                  <span className="text-[11px] font-semibold text-emerald-200 bg-zinc-900/95 px-3 py-1 rounded-full border border-emerald-500/30 flex items-center gap-1.5 shadow-md">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                    <span>Paused ({cooldownSeconds}s) to prevent double-scan</span>
                  </span>
                ) : (
                  <>
                    <span className="text-[11px] font-bold text-emerald-300 bg-zinc-900/90 px-3 py-1 rounded-full border border-emerald-500/30 shadow-xs">
                      Align barcode along the green line
                    </span>
                    <span className="text-xs text-zinc-300 bg-black/70 px-2.5 py-0.5 rounded backdrop-blur-xs flex items-center gap-1.5">
                      <Lightbulb className="w-3 h-3 text-amber-300 shrink-0" aria-hidden="true" />
                      <span>Bottles / Cans: Hold barcode horizontally across the line</span>
                    </span>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Torch toggle */}
          {hasTorch && isScanning && !errorMessage && (
            <button
              onClick={toggleTorch}
              className={`absolute top-3 right-3 p-2 rounded-full backdrop-blur-md transition-colors ${
                torchOn ? 'bg-amber-400 text-zinc-950 shadow-md' : 'bg-zinc-900/70 text-white hover:bg-zinc-800'
              }`}
              title={torchOn ? 'Turn flashlight off' : 'Turn flashlight on'}
              aria-label={torchOn ? 'Turn flashlight off' : 'Turn flashlight on'}
              aria-pressed={torchOn}
            >
              <Flashlight className="w-4 h-4" />
            </button>
          )}

          {/* Comprehensive Permission & Error Troubleshooting Card */}
          {errorMessage && (
            <div className="p-4 sm:p-5 w-full max-w-sm mx-auto text-center space-y-3 z-10 animate-in fade-in duration-200">
              <div className="w-12 h-12 mx-auto rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
                {errorType === 'PERMISSION' ? (
                  <ShieldAlert className="w-6 h-6 text-amber-400" />
                ) : errorType === 'NOT_FOUND' ? (
                  <VideoOff className="w-6 h-6 text-rose-400" />
                ) : (
                  <AlertCircle className="w-6 h-6 text-amber-400" />
                )}
              </div>

              <div>
                <h4 className="text-sm font-bold text-white">
                  {errorType === 'PERMISSION'
                    ? 'Camera Permission Blocked'
                    : errorType === 'IN_USE'
                    ? 'Camera Is In Use'
                    : errorType === 'NOT_FOUND'
                    ? 'No Camera Found'
                    : errorType === 'PHOTO'
                    ? 'No Barcode In That Photo'
                    : 'Camera Unavailable'}
                </h4>
                <p className="text-xs text-zinc-300 mt-1 leading-relaxed">
                  {errorMessage}
                </p>
              </div>

              {/* Step-by-step instructions for Unblocking */}
              {errorType === 'PERMISSION' && (
                <div className="text-left bg-zinc-900/90 border border-zinc-800 rounded-xl p-3 text-[11px] text-zinc-300 space-y-2">
                  <div className="font-semibold text-zinc-200 flex items-center gap-1.5">
                    <span>How to unblock in 5 seconds:</span>
                  </div>
                  <ul className="space-y-1.5 text-[11px] text-zinc-300 list-disc list-inside">
                    <li>
                      <strong className="text-white">Android / Chrome:</strong> Tap the{' '}
                      <Lock className="inline-block w-3 h-3 align-[-1px]" aria-hidden="true" /> lock or tune icon next to the website URL at the top → <strong className="text-emerald-400">Permissions</strong> → <strong className="text-emerald-400">Camera</strong> → choose <strong className="text-emerald-400">Allow</strong>.
                    </li>
                    <li>
                      <strong className="text-white">iPhone / Safari:</strong> Tap the <strong className="text-white font-serif">aA</strong> icon in the address bar → <strong className="text-emerald-400">Website Settings</strong> → <strong className="text-emerald-400">Camera: Allow</strong>.
                    </li>
                    <li>
                      <strong className="text-white">In-App Webview:</strong> If opened inside WhatsApp/Gmail/Instagram, tap ⋮ and choose <strong className="text-emerald-400">"Open in Chrome / Safari"</strong>.
                    </li>
                  </ul>
                </div>
              )}

              {/* Action Buttons */}
              <div className="pt-1 flex flex-col sm:flex-row items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={handleRetryScanner}
                  disabled={isRetrying}
                  className="w-full sm:w-auto px-4 py-2 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-zinc-950 text-xs font-bold rounded-xl shadow-md flex items-center justify-center gap-1.5 transition-all active:scale-95 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isRetrying ? 'animate-spin' : ''}`} />
                  <span>{isRetrying ? 'Requesting...' : 'Request Permission & Retry'}</span>
                </button>

                {/* Snap Photo Fallback (Zero web permissions required!) */}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isPhotoScanning}
                  className="w-full sm:w-auto px-3.5 py-2 bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-semibold rounded-xl border border-zinc-700 flex items-center justify-center gap-1.5 transition-all active:scale-95 cursor-pointer"
                >
                  <Camera className="w-3.5 h-3.5 text-emerald-400" />
                  <span>{isPhotoScanning ? 'Scanning Photo...' : 'Snap Photo of Barcode'}</span>
                </button>
              </div>

              <input
                type="file"
                accept="image/*"
                capture="environment"
                ref={fileInputRef}
                onChange={handleFileCapture}
                className="hidden"
              />
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
              <span className="text-xs bg-emerald-200/80 px-2 py-0.5 rounded font-semibold text-emerald-800">
                Ready for next
              </span>
            )}
          </div>
        )}

        {/* Refused scan: the register said no, so say why here instead of beeping success */}
        {rejectedMessage && (
          <div
            role="alert"
            className="bg-rose-50 border-y border-rose-200 px-4 py-2 flex items-center gap-2 text-xs text-rose-800"
          >
            <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>{rejectedMessage}</span>
          </div>
        )}

        {/* Manual Barcode Input Fallback - Collapsible or Auto-opened when camera error */}
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
                    className="w-full pl-9 pr-3 py-2 text-xs sm:text-sm bg-white border border-zinc-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900 placeholder:text-zinc-500 font-mono"
                    aria-label="Barcode"
                    autoFocus={!!errorMessage}
                  />
                </div>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold text-white bg-zinc-900 rounded-xl hover:bg-zinc-800 transition-colors shadow-sm"
                >
                  Enter
                </button>
                {!errorMessage && (
                  <button
                    type="button"
                    onClick={() => setShowManualInput(false)}
                    className="px-2.5 py-2 text-xs text-zinc-500 hover:text-zinc-800 bg-zinc-200/70 hover:bg-zinc-200 rounded-xl transition-colors"
                    title="Close manual entry"
                    aria-label="Close manual entry"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

