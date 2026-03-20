// Service Worker — Sklepik Szkolny PWA
// Strategy: Cache-First for UI assets, Network-Only for /api/*
// The app's existing IndexedDB handles offline data for API calls.
//
// To force an update after deployment: change CACHE_NAME (e.g. sklepik-v2)

const CACHE_NAME = 'sklepik-v19';

// Resources pre-cached on SW install (entire UI shell)
// NOTE: '/login' intentionally excluded — server may redirect to '/app' if user is logged in,
// which would cache the wrong page under the '/login' key → ERR_FAILED after logout.
const PRECACHE_URLS = [
  '/app',
  '/static/app.js',
  '/static/zxing/zxing.min.js',
  '/static/fonts/Fredoka-latin.woff2',
  '/static/fonts/Fredoka-latin-ext.woff2',
  '/static/fonts/Nunito-latin.woff2',
  '/static/fonts/Nunito-latin-ext.woff2',
];

// ============ INSTALL — pre-cache UI shell ============
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ============ ACTIVATE — remove old caches ============
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ============ FETCH ============
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // /api/*, /logout, /login — do not intercept; handled natively by the browser
  // /login must always go to the network — server handles auth logic (redirect if logged in)
  if (url.pathname.startsWith('/api/') || url.pathname === '/logout' || url.pathname === '/login') return;

  // GET only
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      // Resource not in cache — fetch from network and add to cache
      return fetch(event.request).then(response => {
        if (response.ok && response.type === 'basic') {
          const cloned = response.clone();
          caches.open(CACHE_NAME)
            .then(cache => cache.put(event.request, cloned));
        }
        return response;
      }).catch(() => {
        // No network and no cache — fall back to app page (login is not cached)
        return caches.match('/app');
      });
    })
  );
});
