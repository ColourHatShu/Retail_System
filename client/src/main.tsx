import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Register PWA service worker for mobile installability and offline caching
if ('serviceWorker' in navigator && !window.location.host.startsWith('localhost:')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      console.log('Nexus POS PWA Service Worker active:', reg.scope);
    }).catch((err) => {
      console.warn('PWA Service Worker registration error:', err);
    });
  });
}

