// Service Worker — Sklepik Szkolny PWA
// Strategia: Cache-First dla zasobów UI, Network-Only dla /api/*
// Istniejący IndexedDB w aplikacji obsługuje offline dla wywołań API.
//
// Aby wymusić aktualizację po deploymencie: zmień CACHE_NAME (np. sklepik-v2)

const CACHE_NAME = 'sklepik-v15';

// Zasoby pre-cachowane przy instalacji SW (cały UI shell)
const PRECACHE_URLS = [
  '/app',
  '/login',
  '/static/app.js',
  '/static/zxing/zxing.min.js',
  '/static/fonts/Fredoka-latin.woff2',
  '/static/fonts/Fredoka-latin-ext.woff2',
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

  // /api/* i /logout — nie przechwytuj; obsługa natywna przez przeglądarkę
  if (url.pathname.startsWith('/api/') || url.pathname === '/logout') return;

  // Tylko GET
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      // Zasób nie w cache — pobierz z sieci i dodaj do cache
      return fetch(event.request).then(response => {
        if (response.ok && response.type === 'basic') {
          const cloned = response.clone();
          caches.open(CACHE_NAME)
            .then(cache => cache.put(event.request, cloned));
        }
        return response;
      }).catch(() => {
        // Brak sieci i brak cache — fallback na stronę logowania
        return caches.match('/login') || caches.match('/app');
      });
    })
  );
});
