const CACHE_NAME = 'nexus-pos-v4';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.svg',
  '/favicon.svg'
];

// Install Event: cache core app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch((err) => {
        console.warn('Pre-caching partial fail:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// Activate Event: cleanup old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event: the API is never cached; static assets are stale-while-revalidate.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Do not intercept Supabase database or third-party external requests
  if (url.origin !== self.location.origin) return;

  // Never cache the API. Under a Firebase Hosting rewrite /api/** is same-origin,
  // so without this the cache would serve stale stock, stale prices, and one
  // cashier's /api/auth/me to the next cashier on a shared till.
  if (url.pathname.startsWith('/api/')) return;

  // The page shell is always fetched fresh. index.html names a content-hashed
  // JavaScript bundle, so a copy cached before a deploy points at the previous
  // bundle — which boots nothing and shows a blank white screen with no error
  // in the console. Cache it only as an offline fallback, never as the answer.
  if (event.request.mode === 'navigate' || event.request.destination === 'document') {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return networkResponse;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match(event.request)) || (await cache.match('/index.html'));
        }),
    );
    return;
  }

  // Stale-while-revalidate for local static assets
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cachedResponse = await cache.match(event.request);

      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          cache.put(event.request, networkResponse.clone());
        }
        return networkResponse;
      }).catch(() => {
        return cachedResponse;
      });

      return cachedResponse || fetchPromise;
    })
  );
});
