import React, { useState, useEffect } from 'react';
import {
  Download,
  Smartphone,
  Share,
  PlusSquare,
  CheckCircle2,
  X,
  Sparkles,
  ArrowRight,
  Store,
} from 'lucide-react';

interface InstallAppModalProps {
  isOpen: boolean;
  onClose: () => void;
  deferredPrompt: any;
  isStandalone: boolean;
}

export const InstallAppModal: React.FC<InstallAppModalProps> = ({
  isOpen,
  onClose,
  deferredPrompt,
  isStandalone,
}) => {
  const [isIOS, setIsIOS] = useState(false);
  const [installSuccess, setInstallSuccess] = useState(false);

  useEffect(() => {
    // Detect iOS devices (iPhone, iPad, iPod)
    const userAgent = window.navigator.userAgent.toLowerCase();
    const isAppleDevice = /iphone|ipad|ipod/.test(userAgent);
    setIsIOS(isAppleDevice);
  }, []);

  if (!isOpen) return null;

  const handleNativeInstall = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        setInstallSuccess(true);
        setTimeout(() => {
          onClose();
        }, 1800);
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-950/70 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-sm bg-white rounded-3xl shadow-2xl border border-zinc-200 overflow-hidden flex flex-col">
        {/* Header Bar */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100 bg-zinc-50/50">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-zinc-900 text-white flex items-center justify-center shadow-xs">
              <Smartphone className="w-4 h-4 text-emerald-400" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-zinc-950 leading-tight">Install Mobile App</h3>
              <p className="text-[11px] text-zinc-400">Android & iOS Home Screen</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-zinc-700 rounded-lg hover:bg-zinc-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-5 space-y-4">
          {/* App Preview Card */}
          <div className="flex items-center gap-3.5 p-3.5 bg-zinc-900 text-white rounded-2xl shadow-sm border border-zinc-800">
            <img
              src="/icon-192.png"
              alt="Nexus POS"
              className="w-12 h-12 rounded-xl shadow-md border border-zinc-700/60"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="font-extrabold text-sm tracking-tight">Nexus POS</span>
                <span className="text-[9px] font-bold bg-emerald-500/20 text-emerald-400 px-1.5 py-0.2 rounded border border-emerald-500/30">
                  PRO
                </span>
              </div>
              <p className="text-[11px] text-zinc-400 truncate mt-0.5">
                Full-screen app with barcode scanner
              </p>
            </div>
          </div>

          {/* If already installed */}
          {isStandalone ? (
            <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-2xl text-center space-y-2">
              <div className="w-10 h-10 mx-auto rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <h4 className="text-xs font-bold text-emerald-900">Application Already Installed</h4>
              <p className="text-[11px] text-emerald-700">
                You are currently running Nexus POS in standalone mobile app mode.
              </p>
              <button
                onClick={onClose}
                className="w-full py-2 bg-emerald-700 text-white text-xs font-bold rounded-xl shadow-xs"
              >
                Close
              </button>
            </div>
          ) : isIOS ? (
            /* iOS Safari Instructions */
            <div className="space-y-3">
              <div className="p-3 bg-zinc-50 border border-zinc-200/80 rounded-2xl space-y-2.5">
                <span className="text-xs font-bold text-zinc-800 uppercase tracking-wider block">
                  How to install on iPhone / iPad:
                </span>

                <div className="flex items-start gap-2.5 text-xs text-zinc-600">
                  <span className="w-5 h-5 rounded-full bg-zinc-900 text-white flex items-center justify-center font-bold text-[10px] flex-shrink-0 mt-0.5">
                    1
                  </span>
                  <span>
                    Tap the <strong>Share</strong> button (
                    <Share className="w-3.5 h-3.5 inline text-indigo-600 -mt-0.5" />
                    ) in Safari's bottom toolbar.
                  </span>
                </div>

                <div className="flex items-start gap-2.5 text-xs text-zinc-600">
                  <span className="w-5 h-5 rounded-full bg-zinc-900 text-white flex items-center justify-center font-bold text-[10px] flex-shrink-0 mt-0.5">
                    2
                  </span>
                  <span>
                    Scroll down and select <strong>"Add to Home Screen"</strong> (
                    <PlusSquare className="w-3.5 h-3.5 inline text-zinc-800 -mt-0.5" />
                    ).
                  </span>
                </div>

                <div className="flex items-start gap-2.5 text-xs text-zinc-600">
                  <span className="w-5 h-5 rounded-full bg-zinc-900 text-white flex items-center justify-center font-bold text-[10px] flex-shrink-0 mt-0.5">
                    3
                  </span>
                  <span>
                    Tap <strong>"Add"</strong> in the top right corner. The app icon will appear on your home screen!
                  </span>
                </div>
              </div>

              <p className="text-[11px] text-zinc-400 text-center leading-tight">
                Runs full-screen with offline support and zero browser address bars.
              </p>
            </div>
          ) : (
            /* Android / Chrome One-Tap Install */
            <div className="space-y-3">
              {deferredPrompt ? (
                <button
                  type="button"
                  onClick={handleNativeInstall}
                  className="w-full flex items-center justify-center gap-2 py-3.5 bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-bold rounded-2xl shadow-md transition-all active:scale-[0.98]"
                >
                  <Download className="w-4 h-4 text-emerald-400" />
                  <span>Install App to Home Screen</span>
                </button>
              ) : (
                <div className="p-3 bg-zinc-50 border border-zinc-200 rounded-2xl text-xs space-y-2 text-zinc-600">
                  <span className="font-bold text-zinc-800 uppercase tracking-wider block">
                    How to install on Android:
                  </span>
                  <p>
                    1. Tap the <strong>three dots (⋮)</strong> menu in the top-right corner of Chrome.
                  </p>
                  <p>
                    2. Tap <strong>"Install app"</strong> or <strong>"Add to Home screen"</strong>.
                  </p>
                  <p>
                    3. The app will install directly into your phone's app launcher!
                  </p>
                </div>
              )}

              {installSuccess && (
                <div className="p-3 bg-emerald-50 text-emerald-800 rounded-xl text-xs font-semibold text-center animate-in fade-in">
                  🎉 App successfully installed!
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
