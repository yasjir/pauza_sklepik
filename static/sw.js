// Service Worker — Sklepik Szkolny PWA
// Strategia: Cache-First dla zasobów UI, Network-Only dla /api/*
// Istniejący IndexedDB w aplikacji obsługuje offline dla wywołań API.
//
// Aby wymusić aktualizację po deploymencie: zmień CACHE_NAME (np. sklepik-v2)

const CACHE_NAME = 'sklepik-v1';

// Zasoby pre-cachowane przy instalacji SW (cały UI shell)
const PRECACHE_URLS = [
  '/app',
  '/login',
  '/static/zxing/zxing.min.js',
  '/static/fonts/FredokaOne-Regular.woff2',
  '/static/fonts/Nunito-latin.woff2',
  '/static/fonts/Nunito-latin-ext.woff2',
];

// ============ INSTALL — pre-cachuj UI shell ============
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ============ ACTIVATE — usuń stare cache ============
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

  // /api/* — nie przechwytuj; IndexedDB w aplikacji obsługuje offline
  if (url.pathname.startsWith('/api/')) return;

  // Tylko GET
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      // Zasób nie w cache — pobierz z sieci i dodaj do cache
      return fetch(event.request).then(response => {
        if (response.ok && response.type === 'basic') {
          caches.open(CACHE_NAME)
            .then(cache => cache.put(event.request, response.clone()));
        }
        return response;
      }).catch(() => {
        // Brak sieci i brak cache — zwróć główną stronę aplikacji jako fallback
        if (url.pathname === '/app' || url.pathname === '/login') {
          return caches.match('/app');
        }
      });
    })
  );
});
