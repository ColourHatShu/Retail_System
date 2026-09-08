import { useEffect, useRef } from 'react';

/**
 * Custom React Hook to listen for hardware USB / Bluetooth barcode scanners.
 * Barcode scanners type characters in rapid succession (< 40ms between keys)
 * followed by an 'Enter' key.
 */
export function useHardwareBarcodeScanner(
  onScan: (barcode: string) => void,
  enabled: boolean = true
) {
  const bufferRef = useRef<string>('');
  const lastKeyTimeRef = useRef<number>(0);

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // If the user is actively typing in a standard input or textarea, don't hijack unless it's an Enter on a barcode
      const target = e.target as HTMLElement | null;
      const isInputFocused = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      const currentTime = Date.now();
      const timeDiff = currentTime - lastKeyTimeRef.current;
      lastKeyTimeRef.current = currentTime;

      // If time between keystrokes is too long (>100ms), it is manual human typing, reset buffer
      if (timeDiff > 100 && bufferRef.current.length > 0) {
        bufferRef.current = '';
      }

      if (e.key === 'Enter') {
        if (bufferRef.current.length >= 3) {
          const scannedCode = bufferRef.current.trim();
          bufferRef.current = '';
          // Avoid triggering default form submissions
          e.preventDefault();
          onScan(scannedCode);
        } else {
          bufferRef.current = '';
        }
        return;
      }

      // Only collect printable characters
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // If an input is focused, only capture if typing speed indicates barcode scanner (<45ms)
        if (isInputFocused && timeDiff > 45 && bufferRef.current.length === 0) {
          return;
        }
        bufferRef.current += e.key;
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [onScan, enabled]);
}
