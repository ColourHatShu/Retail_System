import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import {
  AlertCircle,
  ArrowRight,
  Camera,
  Check,
  Flashlight,
  Keyboard,
  Lock,
  Minus,
  Plus,
  RefreshCw,
  ScanLine,
  ShieldAlert,
  SwitchCamera,
  VideoOff,
  X,
} from 'lucide-react';
import { playScanSuccessSound, playScanErrorSound } from '../utils/audio';

/**
 * What the register knows about the line a scan touched. The dialog renders what the
 * caller reports and hides what it doesn't — it never derives a name, a price or a
 * total of its own, so nothing on screen can disagree with the order behind it.
 */
export interface ScannedLine {
  name: string;
  sku?: string;
  /** Unit price in dollars, already resolved by the caller. Display only. */
  unitPrice?: number;
  /** Quantity on the order line AFTER this scan. */
  quantity?: number;
  /** Line total in dollars, already totalled by the caller. Display only. */
  lineTotal?: number;
}

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
// Shorter floor between two *different* barcodes.
const ANY_SCAN_COOLDOWN_MS = 1200;
// The countdown is read as seconds but drawn as a bar, so it ticks faster than 1s.
const COOLDOWN_TICK_MS = 100;

const normalizeOutcome = (outcome: unknown): { accepted: boolean; message?: string } => {
  if (outcome === false) return { accepted: false };
  if (outcome && typeof outcome === 'object' && 'accepted' in outcome) {
    const result = outcome as { accepted: boolean; message?: string };
    return { accepted: result.accepted !== false, message: result.message };
  }
  return { accepted: true };
};

// Display formatting only. Anything that isn't a real number is simply not drawn,
// which is the difference between "no price yet" and a confident "$0.00".
const money = (value?: number): string | null =>
  typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(2)}` : null;

interface BarcodeScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onScan: (barcode: string) => BarcodeScanOutcome | Promise<BarcodeScanOutcome>;
  title?: string;
  subtitle?: string;
  continuous?: boolean;
  /**
   * The order line the last accepted scan touched, recomputed by the caller on every
   * render so the quantity and total on screen stay the order's, not a snapshot.
   * Omitted → the dialog shows the barcode alone, as it always has.
   */
  lastLine?: ScannedLine | null;
  /** +1 / -1 on that line. The stepper is only drawn when someone can act on it. */
  onAdjustLastLine?: (delta: 1 | -1) => void;
  /** The running order as the caller has already totalled it. */
  orderSummary?: { itemCount: number; total: number } | null;
}

export const BarcodeScannerModal: React.FC<BarcodeScannerModalProps> = ({
  isOpen,
  onClose,
  onScan,
  title = 'Scan Barcode',
  subtitle = 'Point camera at product barcode or enter manually',
  continuous = false,
  lastLine = null,
  onAdjustLastLine,
  orderSummary = null,
}) => {
  const [manualCode, setManualCode] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorType, setErrorType] = useState<'PERMISSION' | 'NOT_FOUND' | 'IN_USE' | 'PHOTO' | 'OTHER' | null>(null);
  const [rejectedMessage, setRejectedMessage] = useState<string | null>(null);
  const [rejectedCode, setRejectedCode] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isPhotoScanning, setIsPhotoScanning] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [lastScanned, setLastScanned] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [cooldownMs, setCooldownMs] = useState(0);

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
  const manualInputRef = useRef<HTMLInputElement | null>(null);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const scannerElementId = 'barcode-reader-view';

  const cooldownSeconds = Math.ceil(cooldownMs / 1000);
  const cooldownElapsedPct = Math.min(100, Math.max(0, (1 - cooldownMs / SAME_CODE_COOLDOWN_MS) * 100));

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
      // Keep the code even when the caller gave no reason: a silent refusal in front of
      // a live camera reads as a scanner fault, and the cashier retries forever.
      setRejectedMessage(outcome.message || null);
      setRejectedCode(code);
      return false;
    }

    setRejectedMessage(null);
    setRejectedCode(null);
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
    setCooldownMs(SAME_CODE_COOLDOWN_MS);

    if (lockTimerRef.current) {
      clearInterval(lockTimerRef.current);
    }

    // Count against a deadline rather than a tick count, so the bar and the number are
    // the time actually left on the guard even if a tick is late.
    const endsAt = Date.now() + SAME_CODE_COOLDOWN_MS;
    lockTimerRef.current = setInterval(() => {
      const remaining = endsAt - Date.now();
      if (remaining <= 0) {
        if (lockTimerRef.current) {
          clearInterval(lockTimerRef.current);
          lockTimerRef.current = null;
        }
        isScanLockedRef.current = false;
        setIsPaused(false);
        setCooldownMs(0);
      } else {
        setCooldownMs(remaining);
      }
    }, COOLDOWN_TICK_MS);
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

    // Refused: no success row, no countdown. Keep the same-code refs so the refused item
    // stays quiet in front of the lens, but unlock so the next item scans immediately.
    if (!accepted) {
      isScanLockedRef.current = false;
      return;
    }

    if (!continuous) {
      cleanupScanner();
      onCloseRef.current();
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

      // The frame drawn over the video uses these same two expressions in CSS, so the
      // cashier aims at the region that actually decodes instead of a second, smaller box.
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
    }
  };

  useEffect(() => {
    if (!isOpen) {
      cleanupScanner();
      return;
    }

    // Dismiss any active virtual keyboard when scanner modal opens
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    setErrorMessage(null);
    setErrorType(null);
    setRejectedMessage(null);
    setRejectedCode(null);
    setLastScanned(null);
    setIsPaused(false);
    setCooldownMs(0);
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

  // A camera failure makes typing the only way through, so put the caret there rather
  // than leaving the cashier to find the field under a dead viewfinder.
  useEffect(() => {
    if (isOpen && errorMessage) {
      manualInputRef.current?.focus();
    }
  }, [isOpen, errorMessage]);

  // Escape is the one dismissal a dialog owes a keyboard; the camera still stops first.
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeScanner();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
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

  const closeScanner = () => {
    cleanupScanner();
    onCloseRef.current();
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
          onCloseRef.current();
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
    setCooldownMs(0);
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
      onCloseRef.current();
    } else {
      startPause();
    }
  };

  if (!isOpen) return null;

  const showCameraOverlay = isScanning && !errorMessage;
  const unitPriceLabel = money(lastLine?.unitPrice);
  const lineTotalLabel = money(lastLine?.lineTotal);
  const orderTotalLabel = money(orderSummary?.total);
  const canStepLine = !!onAdjustLastLine && typeof lastLine?.quantity === 'number';

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-900 animate-in fade-in duration-150 md:items-center md:justify-center md:bg-zinc-950/60 md:p-4 md:backdrop-blur-xs">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex h-full w-full min-h-0 flex-col overflow-hidden bg-zinc-900 md:h-auto md:max-h-[92vh] md:w-[520px] md:rounded-2xl md:border md:border-zinc-200/80 md:bg-white md:shadow-2xl xl:w-[560px]"
      >
        {/* Header — on phone the title sits over the camera instead, per the artboards */}
        <div className="hidden h-[77px] flex-shrink-0 items-center justify-between gap-4 border-b border-zinc-100 px-5 md:flex">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h3 className="truncate text-lg font-bold leading-6 text-zinc-950">{title}</h3>
            <p className="truncate text-[13px] leading-5 text-zinc-500">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={closeScanner}
            className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl border border-zinc-200 text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900 active:scale-98"
            title="Close scanner"
            aria-label="Close scanner"
          >
            <X className="h-[18px] w-[18px]" />
          </button>
        </div>

        {/* Viewfinder */}
        <div
          className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-zinc-900 md:flex-none ${
            /* The unblock instructions need more room than a viewfinder does, and the
               dialog is capped at 92vh, so give them the height instead of a scrollbar. */
            errorMessage ? 'md:h-[380px] xl:h-[380px]' : 'md:h-[300px] xl:h-[340px]'
          }`}
        >
          {/* Stays in flow at full size: html5-qrcode forces `position: relative` inline on
              this node, so absolute positioning here collapses the viewfinder. Its own
              shaded decode region is hidden so only one frame is drawn over the video. */}
          <div id="barcode-reader-view" className="h-full w-full overflow-hidden [&_#qr-shaded-region]:hidden" />

          {/* One frame, at exactly the qrbox the config decodes */}
          {showCameraOverlay && (
            <div className="pointer-events-none absolute inset-0">
              <div
                className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-xl shadow-[0_0_0_9999px_rgba(9,9,11,0.45)] transition-colors duration-200 ${
                  isPaused ? 'bg-emerald-400/20' : 'bg-emerald-400/[0.08]'
                }`}
                style={{ width: 'min(90%, 340px)', height: 'min(50%, 160px)' }}
              >
                <div className="absolute -left-[3px] -top-[3px] h-7 w-7 rounded-tl-xl border-l-4 border-t-4 border-emerald-400" />
                <div className="absolute -right-[3px] -top-[3px] h-7 w-7 rounded-tr-xl border-r-4 border-t-4 border-emerald-400" />
                <div className="absolute -bottom-[3px] -left-[3px] h-7 w-7 rounded-bl-xl border-b-4 border-l-4 border-emerald-400" />
                <div className="absolute -bottom-[3px] -right-[3px] h-7 w-7 rounded-br-xl border-b-4 border-r-4 border-emerald-400" />
              </div>
            </div>
          )}

          {/* Mode pill (tablet and desktop; on phone the same words sit under the title) */}
          {showCameraOverlay && !isPaused && (
            <div className="pointer-events-none absolute left-3 top-3 hidden h-7 items-center gap-1.5 rounded-full bg-zinc-950/70 px-2.5 text-xs font-semibold text-zinc-200 md:flex">
              <ScanLine className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
              <span>{continuous ? 'Continuous · camera stays open' : 'One scan · the dialog closes'}</span>
            </div>
          )}

          {/* Camera controls. Close + title are phone-only; torch and camera picker are not.
              Above the error card (z-20): on phone this close button is the only one there is. */}
          <div className="absolute inset-x-2 top-2 z-20 flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 md:hidden">
              <button
                type="button"
                onClick={closeScanner}
                className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-full bg-zinc-950/70 text-white backdrop-blur-xs transition-colors hover:bg-zinc-950/90 active:scale-98"
                title="Close scanner"
                aria-label="Close scanner"
              >
                <X className="h-5 w-5" />
              </button>
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[15px] font-bold leading-5 text-white">{title}</span>
                <span className="truncate text-xs font-medium leading-4 text-zinc-300">{subtitle}</span>
              </div>
            </div>

            <div className="ml-auto flex flex-shrink-0 items-center gap-2">
              {hasTorch && showCameraOverlay && (
                <button
                  type="button"
                  onClick={toggleTorch}
                  className={`grid h-11 w-11 place-items-center rounded-full backdrop-blur-xs transition-colors active:scale-98 md:h-10 md:w-10 ${
                    torchOn ? 'bg-amber-400 text-zinc-950' : 'bg-zinc-950/70 text-white hover:bg-zinc-950/90'
                  }`}
                  title={torchOn ? 'Turn flashlight off' : 'Turn flashlight on'}
                  aria-label={torchOn ? 'Turn flashlight off' : 'Turn flashlight on'}
                  aria-pressed={torchOn}
                >
                  <Flashlight className="h-5 w-5 md:h-4 md:w-4" />
                </button>
              )}

              {cameras.length > 1 && isScanning && (
                /* Native picker kept — a cycle button would hide the third camera on the
                   tills that have one — but drawn as the artboard's round icon button. */
                <div className="relative h-11 w-11 md:h-10 md:w-10">
                  <div
                    aria-hidden="true"
                    className="grid h-full w-full place-items-center rounded-full bg-zinc-950/70 text-white backdrop-blur-xs"
                  >
                    <SwitchCamera className="h-5 w-5 md:h-4 md:w-4" />
                  </div>
                  <select
                    value={selectedCameraId}
                    onChange={(e) => {
                      setSelectedCameraId(e.target.value);
                      initScanner(e.target.value);
                    }}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    title="Switch camera"
                    aria-label="Switch camera"
                  >
                    {cameras.map((c, i) => (
                      <option key={c.id} value={c.id}>
                        {c.label || `Camera ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </div>

          {/* Cooldown: the real time left on the same-code guard, and the one way past it */}
          {isPaused && (
            <div className="absolute inset-x-3 bottom-3 flex h-[68px] items-center justify-between gap-3 overflow-hidden rounded-2xl bg-zinc-950/85 px-3 md:inset-x-0 md:bottom-0 md:h-16 md:rounded-none md:bg-zinc-950/80 md:px-4">
              <div className="absolute inset-x-0 bottom-0 h-[3px] bg-zinc-700 md:bottom-auto md:top-0">
                <div
                  className="h-[3px] bg-emerald-400 transition-[width] duration-100 ease-linear"
                  style={{ width: `${cooldownElapsedPct}%` }}
                />
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-bold leading-5 text-white tabular-nums">
                  Next scan in {cooldownSeconds} s
                </span>
                <span className="text-xs leading-4 text-zinc-400">
                  <span className="md:hidden">So one item counts once</span>
                  <span className="hidden md:inline">Paused so one item isn't counted twice</span>
                </span>
              </div>
              <button
                type="button"
                onClick={handleUnlockNow}
                className="flex h-11 flex-shrink-0 items-center gap-2 rounded-xl bg-emerald-400 px-4 text-sm font-bold text-zinc-950 transition-colors hover:bg-emerald-300 active:scale-98 md:h-10 md:text-[13px]"
              >
                <ScanLine className="h-4 w-4" aria-hidden="true" />
                <span>Scan now</span>
              </button>
            </div>
          )}

          {/* Permission & error troubleshooting, over the dead viewfinder */}
          {errorMessage && (
            <div className="absolute inset-0 z-10 overflow-y-auto bg-zinc-950/95 px-4 pb-5 pt-16 md:pt-5">
              <div className="mx-auto flex max-w-sm flex-col items-center gap-3 text-center">
                <div className="grid h-12 w-12 place-items-center rounded-2xl border border-amber-500/20 bg-amber-500/10">
                  {errorType === 'PERMISSION' ? (
                    <ShieldAlert className="h-6 w-6 text-amber-400" />
                  ) : errorType === 'NOT_FOUND' ? (
                    <VideoOff className="h-6 w-6 text-rose-400" />
                  ) : (
                    <AlertCircle className="h-6 w-6 text-amber-400" />
                  )}
                </div>

                <div className="flex flex-col gap-1">
                  <h4 className="text-sm font-bold text-white">
                    {errorType === 'PERMISSION'
                      ? 'Camera permission blocked'
                      : errorType === 'IN_USE'
                      ? 'Camera is in use'
                      : errorType === 'NOT_FOUND'
                      ? 'No camera found'
                      : errorType === 'PHOTO'
                      ? 'No barcode in that photo'
                      : 'Camera unavailable'}
                  </h4>
                  <p className="text-xs leading-relaxed text-zinc-300">{errorMessage}</p>
                </div>

                {errorType === 'PERMISSION' && (
                  <div className="w-full space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/90 p-3 text-left text-xs text-zinc-300">
                    <div className="font-semibold text-zinc-200">How to unblock in 5 seconds:</div>
                    <ul className="list-inside list-disc space-y-1.5">
                      <li>
                        <strong className="text-white">Android / Chrome:</strong> Tap the{' '}
                        <Lock className="inline-block h-3 w-3 align-[-1px]" aria-hidden="true" /> lock or tune icon next
                        to the website URL at the top → <strong className="text-emerald-400">Permissions</strong> →{' '}
                        <strong className="text-emerald-400">Camera</strong> → choose{' '}
                        <strong className="text-emerald-400">Allow</strong>.
                      </li>
                      <li>
                        <strong className="text-white">iPhone / Safari:</strong> Tap the{' '}
                        <strong className="font-serif text-white">aA</strong> icon in the address bar →{' '}
                        <strong className="text-emerald-400">Website Settings</strong> →{' '}
                        <strong className="text-emerald-400">Camera: Allow</strong>.
                      </li>
                      <li>
                        <strong className="text-white">In-app webview:</strong> If opened inside WhatsApp/Gmail/Instagram,
                        open the browser menu and choose{' '}
                        <strong className="text-emerald-400">"Open in Chrome / Safari"</strong>.
                      </li>
                    </ul>
                  </div>
                )}

                <div className="flex w-full flex-col items-stretch justify-center gap-2 pt-1 sm:flex-row">
                  <button
                    type="button"
                    onClick={handleRetryScanner}
                    disabled={isRetrying}
                    className="flex h-11 items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 text-[13px] font-bold text-zinc-950 transition-colors hover:bg-emerald-400 active:scale-98 disabled:opacity-50 sm:h-10"
                  >
                    <RefreshCw className={`h-4 w-4 ${isRetrying ? 'animate-spin' : ''}`} />
                    <span>{isRetrying ? 'Requesting...' : 'Request permission & retry'}</span>
                  </button>

                  {/* Snap-photo fallback: needs no web camera permission at all */}
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isPhotoScanning}
                    className="flex h-11 items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-800 px-4 text-[13px] font-semibold text-white transition-colors hover:bg-zinc-700 active:scale-98 disabled:opacity-50 sm:h-10"
                  >
                    <Camera className="h-4 w-4 text-emerald-400" />
                    <span>{isPhotoScanning ? 'Scanning photo...' : 'Snap photo of barcode'}</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* The sheet: what the register did with the read, manual entry, and the way out */}
        <div className="flex flex-shrink-0 flex-col rounded-t-2xl bg-white md:rounded-none">
          {rejectedCode ? (
            /* Refused: the register said no, so say so here instead of an alert() over a live camera */
            <div
              role="alert"
              className="flex items-center gap-3 px-4 py-3 md:h-[73px] md:border-b md:border-zinc-100 md:px-5 md:py-0"
            >
              <div className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl bg-rose-50 text-rose-600">
                <AlertCircle className="h-5 w-5" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-sm font-semibold leading-5 text-rose-700">
                  {rejectedMessage || 'The register did not add this item.'}
                </span>
                <span className="truncate font-mono text-xs leading-4 text-zinc-500">{rejectedCode}</span>
              </div>
            </div>
          ) : lastScanned ? (
            <div
              role="status"
              className="flex flex-wrap items-center gap-3 px-4 py-3 md:h-[73px] md:flex-nowrap md:border-b md:border-zinc-100 md:px-5 md:py-0"
            >
              <div className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-700">
                <Check className="h-5 w-5 stroke-[2.5]" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="truncate text-sm font-semibold leading-5 text-zinc-950 md:text-sm">
                  {lastLine?.name ? (
                    <>
                      {lastLine.name}
                      <span className="text-emerald-700"> · added</span>
                    </>
                  ) : (
                    <>
                      <span className="font-mono">{lastScanned}</span>
                      <span className="text-emerald-700"> · scanned</span>
                    </>
                  )}
                </span>
                {(lastLine?.name || unitPriceLabel || lastLine?.sku) && (
                  <div className="flex items-center gap-1.5 overflow-hidden text-xs leading-4 text-zinc-500">
                    {lastLine?.name && <span className="truncate font-mono">{lastScanned}</span>}
                    {unitPriceLabel && (
                      <>
                        {lastLine?.name && <span>·</span>}
                        <span className="whitespace-nowrap tabular-nums">{unitPriceLabel} each</span>
                      </>
                    )}
                    {lastLine?.sku && (
                      <>
                        <span>·</span>
                        <span className="truncate font-mono">{lastLine.sku}</span>
                      </>
                    )}
                  </div>
                )}
              </div>

              {(canStepLine || lineTotalLabel) && (
                <div className="flex w-full items-center justify-between gap-3 md:w-auto md:justify-end">
                  {lineTotalLabel && (
                    <div className="flex flex-col md:hidden">
                      <span className="text-xs leading-4 text-zinc-500">Line total</span>
                      <span className="text-[15px] font-semibold leading-5 text-zinc-950 tabular-nums">
                        {lineTotalLabel}
                      </span>
                    </div>
                  )}

                  {canStepLine && (
                    <div className="flex h-11 flex-shrink-0 items-center overflow-hidden rounded-xl border border-emerald-200 bg-white md:h-10">
                      <button
                        type="button"
                        onClick={() => onAdjustLastLine?.(-1)}
                        className="grid h-full w-11 place-items-center text-zinc-700 transition-colors hover:bg-zinc-50 md:w-10"
                        title="Remove one"
                        aria-label="Remove one"
                      >
                        <Minus className="h-[18px] w-[18px] md:h-4 md:w-4" />
                      </button>
                      <span className="min-w-[40px] text-center text-base font-bold text-zinc-950 tabular-nums md:min-w-[36px] md:text-[15px]">
                        {lastLine?.quantity}
                      </span>
                      <button
                        type="button"
                        onClick={() => onAdjustLastLine?.(1)}
                        className="grid h-full w-11 place-items-center bg-emerald-600 text-white transition-colors hover:bg-emerald-700 md:w-10"
                        title="Add one"
                        aria-label="Add one"
                      >
                        <Plus className="h-[18px] w-[18px] md:h-4 md:w-4" />
                      </button>
                    </div>
                  )}

                  {lineTotalLabel && (
                    <span className="hidden w-14 flex-shrink-0 text-right text-[15px] font-semibold text-zinc-950 tabular-nums md:block">
                      {lineTotalLabel}
                    </span>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-3 px-4 py-3 md:h-[73px] md:border-b md:border-zinc-100 md:px-5 md:py-0">
              <div className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl bg-zinc-100 text-zinc-500">
                <ScanLine className="h-5 w-5" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-sm font-semibold leading-5 text-zinc-950">
                  {isScanning ? 'Ready to scan' : 'Camera not running'}
                </span>
                <span className="text-xs leading-4 text-zinc-500">
                  {isScanning ? 'Each read shows up here' : 'Type the barcode below instead'}
                </span>
              </div>
            </div>
          )}

          {/* Manual entry: always on screen, so a label that won't read never blocks the till */}
          <div className="flex flex-col gap-3 border-t border-zinc-100 px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom,0px))] md:border-t-0 md:bg-zinc-50 md:px-5 md:pb-4">
            <form onSubmit={handleManualSubmit} className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <Keyboard
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
                  aria-hidden="true"
                />
                <input
                  ref={manualInputRef}
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck="false"
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value)}
                  placeholder="Type the barcode"
                  className="h-11 w-full rounded-xl border border-zinc-200 bg-white pl-9 pr-3 font-mono text-sm text-zinc-900 placeholder:font-sans placeholder:text-zinc-500 focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900 md:h-10 md:text-[13px]"
                  aria-label="Barcode"
                />
              </div>
              <button
                type="submit"
                className="h-11 flex-shrink-0 rounded-xl border border-zinc-200 bg-white px-5 text-sm font-semibold text-zinc-900 transition-colors hover:bg-zinc-50 active:scale-98 md:h-10 md:px-4 md:text-[13px]"
              >
                Add
              </button>
            </form>

            <div className="flex items-center justify-between gap-4">
              {orderSummary ? (
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[11px] font-semibold uppercase leading-4 tracking-[0.06em] text-zinc-500">
                    Current order
                  </span>
                  <span className="truncate text-[15px] font-bold leading-5 text-zinc-950 tabular-nums">
                    {orderSummary.itemCount} {orderSummary.itemCount === 1 ? 'item' : 'items'}
                    {orderTotalLabel ? ` · ${orderTotalLabel}` : ''}
                  </span>
                </div>
              ) : (
                <span aria-hidden="true" />
              )}

              <button
                type="button"
                onClick={closeScanner}
                className="flex h-12 flex-shrink-0 items-center gap-2 rounded-xl bg-zinc-900 px-6 text-[15px] font-bold text-white transition-colors hover:bg-zinc-800 active:scale-98 md:h-11 md:text-sm"
              >
                <span>Done</span>
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

        {/* Mounted once, outside the error card, so the capture input survives a re-render */}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          ref={fileInputRef}
          onChange={handleFileCapture}
          className="hidden"
        />
      </div>
    </div>
  );
};
