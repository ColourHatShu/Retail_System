import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { AdminApp } from './AdminApp'

// The platform administrator lives at /admin — a separate surface with its
// own sign-in and its own token, never mixed with the register.
const path = window.location.pathname.replace(/\/+$/, '')
const isAdminSurface = path === '/admin' || path.startsWith('/admin/')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isAdminSurface ? <AdminApp /> : <App />}
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

